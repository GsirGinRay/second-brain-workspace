import type { BrainCollectionSnapshot, BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";

export interface WorkspaceLists {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
}

type Keyed = { id?: string | null };

/** Field values are primitives or small arrays/objects; compare them by value. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEntity<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof T>;
  return [...keys].every((key) => sameValue(left[key], right[key]));
}

function sameList<T extends object>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => sameEntity(item, right[index]!));
}

/**
 * Field-level rebase of one entity: fields the caller changed since `before`
 * win, every other field keeps its `latest` value.
 */
export function rebaseFields<T extends object>(before: T, wanted: T, latest: T): T {
  const result = { ...latest };
  for (const key of Object.keys(wanted) as (keyof T)[]) {
    if (!sameValue(wanted[key], before[key])) result[key] = wanted[key];
  }
  return result;
}

/**
 * Three-way merge for one list. `base` is what the caller saw, `desired` is
 * what the caller wants, `latest` is what is on disk right now. The caller's
 * additions, removals and field edits are applied onto `latest`; everything
 * else keeps its latest value, so a write prepared from a stale render can no
 * longer revert a newer save, even one to another field of the same entity.
 */
export function rebaseEntities<T extends Keyed & object>(base: readonly T[], desired: readonly T[], latest: readonly T[]): T[] {
  // Nothing moved underneath the caller: keep its list exactly, order included.
  if (sameList(base, latest)) return [...desired];
  const keyed = (items: readonly T[]) => new Map(items.flatMap((item) => (item.id ? [[item.id, item] as const] : [])));
  const baseById = keyed(base);
  const desiredById = keyed(desired);
  const result: T[] = [];
  const placed = new Set<string>();
  for (const item of latest) {
    const id = item.id;
    if (!id) {
      result.push(item);
      continue;
    }
    const before = baseById.get(id);
    const wanted = desiredById.get(id);
    if (before && !wanted) continue;
    placed.add(id);
    result.push(wanted ? (before ? rebaseFields(before, wanted, item) : wanted) : item);
  }
  for (const item of desired) {
    if (!item.id) {
      // Id-less entries can only be matched by content.
      if (!base.some((existing) => sameEntity(existing, item))) result.push(item);
      continue;
    }
    if (!baseById.has(item.id) && !placed.has(item.id)) result.push(item);
  }
  return result;
}

export function rebaseWorkspace(base: WorkspaceLists, desired: WorkspaceLists, latest: WorkspaceLists): WorkspaceLists {
  return {
    tasks: rebaseEntities(base.tasks, desired.tasks, latest.tasks),
    projects: rebaseEntities(base.projects, desired.projects, latest.projects),
    collections: rebaseEntities(base.collections, desired.collections, latest.collections),
  };
}
