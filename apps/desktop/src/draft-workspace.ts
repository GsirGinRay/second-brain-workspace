import {
  BrainCollectionSnapshotSchema,
  BrainProjectSnapshotSchema,
  BrainTaskSnapshotSchema,
  type BrainCollectionSnapshot,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";

export const DRAFT_WORKSPACE_KEY = "second-brain.draftWorkspace.v1";

export interface DraftWorkspace {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
}

export const emptyDraftWorkspace = (): DraftWorkspace => ({ tasks: [], projects: [], collections: [] });

export function hasDraftContent(value: DraftWorkspace): boolean {
  return value.tasks.length + value.projects.length + value.collections.length > 0;
}

export function loadDraftWorkspace(storage: Pick<Storage, "getItem"> = localStorage): DraftWorkspace {
  try {
    const raw = storage.getItem(DRAFT_WORKSPACE_KEY);
    if (!raw) return emptyDraftWorkspace();
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      tasks: Array.isArray(value.tasks) ? value.tasks.flatMap((item) => {
        const result = BrainTaskSnapshotSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }) : [],
      projects: Array.isArray(value.projects) ? value.projects.flatMap((item) => {
        const result = BrainProjectSnapshotSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }) : [],
      collections: Array.isArray(value.collections) ? value.collections.flatMap((item) => {
        const result = BrainCollectionSnapshotSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }) : [],
    };
  } catch {
    return emptyDraftWorkspace();
  }
}

export function saveDraftWorkspace(value: DraftWorkspace, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  if (!hasDraftContent(value)) storage.removeItem(DRAFT_WORKSPACE_KEY);
  else storage.setItem(DRAFT_WORKSPACE_KEY, JSON.stringify(value));
}
