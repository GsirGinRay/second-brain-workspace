import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import type { DeviceClient, DeviceOwnerState, DevicePlanResponse, ConflictChoice } from "./device-client";
import type { NativeAdapter, PendingCommitRecord } from "./ipc";
import { applyDesiredSnapshot, scanStructuredVault, type LocalMarkdownFile } from "./vault";

type NativeSyncAdapter = Pick<NativeAdapter,
  "scanVault" | "readMarkdownFiles" | "applyMarkdownChanges" | "confirmServerCommit" |
  "savePendingCommit" | "loadPendingCommit" | "clearPendingCommit"
  | "pendingJournals"
>;

export type SyncDeviceClient = Pick<DeviceClient, "getState" | "createPlan" | "commitPlan" | "getPlanStatus">;

export type SyncResult =
  | { kind: "synced"; state: DeviceOwnerState; taskCount: number; projectCount: number }
  | { kind: "preview"; taskCount: number; projectCount: number; conflictCount: number; bootstrapFileCount: number }
  | { kind: "conflict"; plan: DevicePlanResponse; files: LocalMarkdownFile[]; journalPaths: string[]; state: DeviceOwnerState };

export class SyncEngine {
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly native: NativeSyncAdapter,
    private readonly client: SyncDeviceClient,
  ) {}

  sync(options: { previewOnly?: boolean } = {}): Promise<SyncResult> {
    if (this.running) return this.running;
    this.running = this.run(options.previewOnly === true).finally(() => { this.running = null; });
    return this.running;
  }

  async resolveConflict(result: Extract<SyncResult, { kind: "conflict" }>, choices: ConflictChoice[]): Promise<Extract<SyncResult, { kind: "synced" }>> {
    return this.applyAndCommit(result.plan, result.files, result.journalPaths, result.state, choices);
  }

  async loadLocal(): Promise<{ files: LocalMarkdownFile[]; tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[] }> {
    const scan = await this.native.scanVault();
    if (scan.length === 0) return { files: [], tasks: [], projects: [] };
    const files = await this.native.readMarkdownFiles(scan.map((file) => file.relativePath));
    const structured = scanStructuredVault(files);
    return { files, tasks: structured.snapshot.tasks, projects: structured.snapshot.projects };
  }

  private async run(previewOnly: boolean): Promise<SyncResult> {
    const pending = await this.native.loadPendingCommit();
    if (pending) {
      let confirmed = false;
      try {
        await this.client.commitPlan(pending.planId, pending.choices, pending.idempotencyKey);
        confirmed = true;
      } catch (commitError) {
        try {
          const plan = await this.client.getPlanStatus(pending.planId);
          if (plan.status === "committed") confirmed = true;
          else if (plan.status === "expired" || plan.status === "failed") {
            await this.native.clearPendingCommit();
          } else throw commitError;
        } catch {
          throw commitError;
        }
      }
      if (confirmed) {
        for (const journal of pending.journalPaths) await this.native.confirmServerCommit(journal);
        await this.native.clearPendingCommit();
      }
    }

    let local = await this.loadLocal();
    let structured = scanStructuredVault(local.files);
    const journalPaths = await this.native.pendingJournals();
    if (!previewOnly && structured.bootstrapChanges.length > 0) {
      const applied = await this.native.applyMarkdownChanges(structured.bootstrapChanges);
      journalPaths.push(applied.journalPath);
      local = await this.loadLocal();
      structured = scanStructuredVault(local.files);
    }
    const stateResult = await this.client.getState(null);
    if (stateResult.kind !== "modified") throw new Error("DEVICE_STATE_NOT_MODIFIED_WITHOUT_ETAG");
    const plan = await this.client.createPlan({
      schemaVersion: 5,
      baseRevision: stateResult.state.revision,
      tasks: structured.snapshot.tasks,
      projects: structured.snapshot.projects,
      fileHashes: structured.snapshot.fileHashes ?? {},
    });
    if (previewOnly) {
      return {
        kind: "preview",
        taskCount: plan.desiredTasks.length,
        projectCount: plan.desiredProjects.length,
        conflictCount: plan.conflicts.length,
        bootstrapFileCount: structured.bootstrapChanges.length,
      };
    }
    if (plan.conflicts.length > 0) {
      return { kind: "conflict", plan, files: local.files, journalPaths, state: stateResult.state };
    }
    return this.applyAndCommit(plan, local.files, journalPaths, stateResult.state, []);
  }

  private async applyAndCommit(
    plan: DevicePlanResponse,
    files: LocalMarkdownFile[],
    existingJournals: string[],
    state: DeviceOwnerState,
    choices: ConflictChoice[],
  ): Promise<Extract<SyncResult, { kind: "synced" }>> {
    const desired = resolveDesired(plan, choices);
    const changes = applyDesiredSnapshot(files, {
      schemaVersion: 5,
      tasks: desired.tasks,
      projects: desired.projects,
      fileHashes: {},
    });
    const journalPaths = [...existingJournals];
    if (changes.length > 0) {
      const applied = await this.native.applyMarkdownChanges(changes);
      journalPaths.push(applied.journalPath);
    }
    const pending: PendingCommitRecord = {
      planId: plan.planId,
      idempotencyKey: crypto.randomUUID(),
      choices,
      journalPaths,
    };
    await this.native.savePendingCommit(pending);
    await this.client.commitPlan(pending.planId, pending.choices, pending.idempotencyKey);
    for (const journal of journalPaths) await this.native.confirmServerCommit(journal);
    await this.native.clearPendingCommit();
    return { kind: "synced", state, taskCount: desired.tasks.length, projectCount: desired.projects.length };
  }
}

function resolveDesired(plan: DevicePlanResponse, choices: ConflictChoice[]): {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
} {
  const taskById = new Map(plan.desiredTasks.map((task) => [task.id, { ...task }]));
  const projectById = new Map(plan.desiredProjects.map((project) => [project.id, { ...project }]));
  for (const conflict of plan.conflicts) {
    for (const field of conflict.fields) {
      const selection = choices.find((choice) =>
        choice.entity === conflict.entity && choice.id === conflict.id && choice.field === field);
      if (!selection) throw new Error("SYNC_CONFLICT_CHOICES_INCOMPLETE");
      const source = selection.choice === "local" ? conflict.local : conflict.server;
      const target = conflict.entity === "task" ? taskById.get(conflict.id) : projectById.get(conflict.id);
      if (!target || !(field in source)) throw new Error("SYNC_CONFLICT_FIELD_INVALID");
      (target as unknown as Record<string, unknown>)[field] = source[field];
    }
  }
  return { tasks: [...taskById.values()], projects: [...projectById.values()] };
}
