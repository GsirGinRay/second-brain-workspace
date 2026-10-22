import type { BrainCollectionSnapshot, BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import type { DeviceClient, DeviceOwnerState, DevicePlanResponse, ConflictChoice } from "./device-client";
import type { NativeAdapter, PendingCommitRecord } from "./ipc";
import { applyDesiredSnapshot, createIncrementalVaultScanner, scanStructuredVault, type LocalMarkdownFile } from "./vault";

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

// Keyed by adapter: the app builds a fresh SyncEngine for each local reload.
const fileContentCache = new WeakMap<object, Map<string, LocalMarkdownFile>>();
const vaultScanners = new WeakMap<object, ReturnType<typeof createIncrementalVaultScanner>>();

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

  async loadLocal(): Promise<{ files: LocalMarkdownFile[]; tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; collections: BrainCollectionSnapshot[]; bootstrapChanges: ReturnType<typeof scanStructuredVault>["bootstrapChanges"]; warnings: ReturnType<typeof scanStructuredVault>["warnings"] }> {
    const scan = await this.native.scanVault();
    if (scan.length === 0) return { files: [], tasks: [], projects: [], collections: [], bootstrapChanges: [], warnings: [] };
    const files = await this.readChangedFiles(scan);
    const structured = this.parse(files);
    return { files, tasks: structured.snapshot.tasks, projects: structured.snapshot.projects, collections: structured.snapshot.collections, bootstrapChanges: structured.bootstrapChanges, warnings: structured.warnings };
  }

  /**
   * A save loads the vault twice, and most files are unchanged each time.
   * The cached file objects let the scanner re-parse only the changed ones.
   * Callers get a copy, so nothing they change can leak into the next load.
   */
  private parse(files: LocalMarkdownFile[]): ReturnType<typeof scanStructuredVault> {
    let scan = vaultScanners.get(this.native);
    if (!scan) {
      scan = createIncrementalVaultScanner();
      vaultScanners.set(this.native, scan);
    }
    return structuredClone(scan(files));
  }

  /**
   * Every save re-scans the vault, and sending every file's bytes over IPC
   * again dominated large vaults. A file whose scanned hash matches the last
   * read is reused; equal SHA-256 means equal bytes, so this cannot go stale.
   */
  private async readChangedFiles(scan: readonly { relativePath: string; sha256: string }[]): Promise<LocalMarkdownFile[]> {
    let cache = fileContentCache.get(this.native);
    if (!cache) {
      cache = new Map();
      fileContentCache.set(this.native, cache);
    }
    // Windows scans report "a\b.md" while reads return "a/b.md"; key both the same way.
    const key = (relativePath: string) => relativePath.replace(/\\/g, "/");
    const stale = scan.filter((file) => cache!.get(key(file.relativePath))?.sha256 !== file.sha256);
    const fresh = stale.length ? await this.native.readMarkdownFiles(stale.map((file) => file.relativePath)) : [];
    for (const file of fresh) cache.set(key(file.relativePath), file);
    const present = new Set(scan.map((file) => key(file.relativePath)));
    for (const relativePath of [...cache.keys()]) if (!present.has(relativePath)) cache.delete(relativePath);
    return scan.flatMap((file) => cache!.get(key(file.relativePath)) ?? []);
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
      tasks: structured.snapshot.tasks.map((task) => ({ ...task, schemaVersion: 5 })),
      projects: structured.snapshot.projects.map((project) => ({ ...project, schemaVersion: 5 })),
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
      schemaVersion: 6,
      tasks: desired.tasks,
      projects: desired.projects,
      collections: scanStructuredVault(files).snapshot.collections,
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
