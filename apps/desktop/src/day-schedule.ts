export const MINUTES_PER_DAY = 24 * 60;
export const PX_PER_HOUR = 56;
export const SNAP_MINUTES = 15;
export const MIN_BLOCK_HEIGHT = 22;
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 8 * 60;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = TIME_RE.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatMinutesAsTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(minutes)));
  const hours = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  const snapped = Math.round(minutes / step) * step;
  return Math.max(0, Math.min(MINUTES_PER_DAY - step, snapped));
}

export function durationFromResize(
  startMinutes: number,
  originDuration: number,
  deltaY: number,
  pxPerHour = PX_PER_HOUR,
): number {
  const raw = originDuration + (deltaY / pxPerHour) * 60;
  const snapped = Math.round(raw / SNAP_MINUTES) * SNAP_MINUTES;
  const remaining = MINUTES_PER_DAY - startMinutes;
  const max = Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, remaining));
  return Math.max(MIN_DURATION_MINUTES, Math.min(max, snapped));
}

export function minutesFromOffset(
  offsetY: number,
  pxPerHour = PX_PER_HOUR,
  snap = SNAP_MINUTES,
): number {
  return snapMinutes((offsetY / pxPerHour) * 60, snap);
}

export function timeFromSlotDrop(
  baseMinutes: number,
  clientY: number,
  slotTop: number,
  slotHeight: number,
): string {
  if (slotHeight <= 0) return formatMinutesAsTime(snapMinutes(baseMinutes));
  const ratio = Math.max(0, Math.min(0.999, (clientY - slotTop) / slotHeight));
  return formatMinutesAsTime(snapMinutes(baseMinutes + ratio * 60));
}

export interface TimedBlockLayout {
  id: string;
  startMinutes: number;
  endMinutes: number;
  top: number;
  height: number;
  column: number;
  columns: number;
}

export function layoutTimedBlocks(
  tasks: Array<{ id: string; startTime: string; durationMinutes: number | null }>,
  pxPerHour = PX_PER_HOUR,
): TimedBlockLayout[] {
  const items: TimedBlockLayout[] = tasks
    .map((task) => {
      const startMinutes = parseTimeToMinutes(task.startTime);
      if (startMinutes == null) return null;
      const duration = Math.max(5, task.durationMinutes ?? 30);
      const endMinutes = Math.min(MINUTES_PER_DAY, startMinutes + duration);
      return {
        id: task.id,
        startMinutes,
        endMinutes,
        top: (startMinutes / 60) * pxPerHour,
        height: Math.max(MIN_BLOCK_HEIGHT, ((endMinutes - startMinutes) / 60) * pxPerHour),
        column: 0,
        columns: 1,
      };
    })
    .filter((item): item is TimedBlockLayout => item !== null)
    .sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);

  const active: TimedBlockLayout[] = [];
  let groupStart = 0;
  const closeGroup = (endIndex: number) => {
    const group = items.slice(groupStart, endIndex);
    const columns = Math.max(1, ...group.map((item) => item.column + 1));
    for (const item of group) item.columns = columns;
    groupStart = endIndex;
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    for (let cursor = active.length - 1; cursor >= 0; cursor -= 1) {
      if (active[cursor]!.endMinutes <= item.startMinutes) active.splice(cursor, 1);
    }
    if (active.length === 0 && index > groupStart) closeGroup(index);
    const used = new Set(active.map((entry) => entry.column));
    let column = 0;
    while (used.has(column)) column += 1;
    item.column = column;
    active.push(item);
  }
  if (items.length > 0) closeGroup(items.length);
  return items;
}

export function taipeiMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}
