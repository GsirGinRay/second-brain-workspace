import { rankForIndex, type BrainTaskSnapshot } from "@second-brain/brain-core";

export type DropPosition = "before" | "after";

/**
 * Reorder a displayed list so `draggedId` lands right before/after `targetId`.
 * Pure: returns null when the drop is impossible or changes nothing, so callers
 * can skip saving entirely.
 */
export function reorderDisplayed<
  T extends { id?: string | null },
>(
  ordered: readonly T[],
  draggedId: string | null,
  targetId: string | null,
  place: DropPosition,
): T[] | null {
  if (!draggedId || !targetId || draggedId === targetId) return null;
  const items = [...ordered];
  const from = items.findIndex((item) => item.id === draggedId);
  const anchorIndex = items.findIndex((item) => item.id === targetId);
  if (from < 0 || anchorIndex < 0) return null;
  const [moved] = items.splice(from, 1);
  if (!moved) return null;
  // After removing the dragged item the anchor shifts left by one when it sat below.
  let to = anchorIndex > from ? anchorIndex - 1 : anchorIndex;
  if (place === "after") to += 1;
  if (to === from) return null;
  items.splice(to, 0, moved);
  return items;
}

/**
 * The Today tray sorts by overdue-first, then priority, then date, then rank —
 * a drag can only persist inside one such group, so a drop aimed at a card from
 * a different group is ignored rather than snapping somewhere unexpected.
 */
export function todayTraySegmentKey(task: BrainTaskSnapshot, today: string): string {
  const category = task.taskDate && task.taskDate < today ? "overdue" : "current";
  return `${category}|${task.priority}|${task.taskDate ?? ""}`;
}

export function reorderTodayTray(
  trayTasks: readonly BrainTaskSnapshot[],
  today: string,
  draggedId: string | null,
  targetId: string | null,
  place: DropPosition,
): BrainTaskSnapshot[] | null {
  if (!draggedId) return null;
  const dragged = trayTasks.find((task) => task.id === draggedId);
  if (!dragged || !targetId || draggedId === targetId) return null;
  const key = todayTraySegmentKey(dragged, today);
  const segment = trayTasks.filter((task) => todayTraySegmentKey(task, today) === key);
  if (!segment.some((task) => task.id === targetId)) return null;
  const reorderedSegment = reorderDisplayed(segment, draggedId, targetId, place);
  if (!reorderedSegment) return null;
  const next = [...trayTasks];
  let cursor = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (todayTraySegmentKey(next[index]!, today) === key) {
      next[index] = reorderedSegment[cursor]!;
      cursor += 1;
    }
  }
  return next;
}

/**
 * Batch variant of reorderTodayTray: a marquee selection dragged by its
 * six-dot grip travels as one block (kept in its current display order) and
 * lands before/after `targetId`. Like the single reorder, the group may only
 * travel inside the dragged task's own tray segment — a selection spanning
 * several priority/date groups reorders just its members inside that segment.
 * Pure: returns null when the drop changes nothing or is impossible.
 */
export function reorderTodayTrayBatch(
  trayTasks: readonly BrainTaskSnapshot[],
  today: string,
  draggedIds: readonly string[],
  targetId: string | null,
  place: DropPosition,
): BrainTaskSnapshot[] | null {
  const dragged = trayTasks.find((task) => task.id === draggedIds[0]);
  if (!dragged || !targetId) return null;
  const key = todayTraySegmentKey(dragged, today);
  const moving = trayTasks.filter((task) =>
    task.id && draggedIds.includes(task.id) && todayTraySegmentKey(task, today) === key);
  if (moving.length === 0) return null;
  if (moving.length === 1) return reorderTodayTray(trayTasks, today, moving[0]!.id!, targetId, place);
  if (moving.some((task) => task.id === targetId)) return null;
  const segment = trayTasks.filter((task) => todayTraySegmentKey(task, today) === key);
  if (!segment.some((task) => task.id === targetId)) return null;
  const movingIds = new Set(moving.map((task) => task.id as string));
  const remainingSegment = segment.filter((task) => !(task.id && movingIds.has(task.id)));
  const anchor = remainingSegment.findIndex((task) => task.id === targetId);
  if (anchor < 0) return null;
  const to = place === "before" ? anchor : anchor + 1;
  const reorderedSegment = [...remainingSegment.slice(0, to), ...moving, ...remainingSegment.slice(to)];
  const next = [...trayTasks];
  let cursor = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (todayTraySegmentKey(next[index]!, today) === key) {
      next[index] = reorderedSegment[cursor]!;
      cursor += 1;
    }
  }
  return next;
}

/**
 * Persist a displayed order into the long-term Markdown data: each listed id gets
 * the rank for its position. Tasks not listed keep their rank untouched so a tray
 * reorder never shuffles unrelated views (the board sorts purely by rank).
 */
export function withReassignedRanks(
  tasks: readonly BrainTaskSnapshot[],
  idsInOrder: readonly (string | null | undefined)[],
): BrainTaskSnapshot[] {
  const rankById = new Map<string, string>();
  idsInOrder.forEach((id, index) => {
    if (id) rankById.set(id, rankForIndex(index));
  });
  if (rankById.size === 0) return [...tasks];
  return tasks.map((task) => {
    const rank = task.id ? rankById.get(task.id) : undefined;
    return rank && rank !== task.rank ? { ...task, rank } : task;
  });
}

/** Ids whose display position changed between two orderings of the same items. */
export function movedIds(
  before: readonly { id?: string | null }[],
  after: readonly { id?: string | null }[],
): string[] {
  const ids: string[] = [];
  for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
    if (before[index]!.id !== after[index]!.id) {
      const id = after[index]!.id;
      if (id) ids.push(id);
    }
  }
  return ids;
}
