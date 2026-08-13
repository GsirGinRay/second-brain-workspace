import { addDateDays, taipeiDateKey } from "./calendar";

export interface TaipeiTodayControllerOptions {
  now?: () => Date;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

type TodayListener = (today: string) => void;

export class TaipeiTodayController {
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly listeners = new Set<TodayListener>();
  private timer: unknown = null;
  private started = false;
  private today: string;

  constructor(options: TaipeiTodayControllerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.today = taipeiDateKey(this.now());
  }

  getToday(): string {
    return this.today;
  }

  subscribe(listener: TodayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  refresh(): string {
    const next = taipeiDateKey(this.now());
    if (next !== this.today) {
      this.today = next;
      for (const listener of this.listeners) listener(next);
    }
    if (this.started) this.scheduleNextMidnight();
    return this.today;
  }

  private scheduleNextMidnight(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    const nextDate = addDateDays(this.today, 1);
    const nextMidnight = new Date(`${nextDate}T00:00:00+08:00`).getTime();
    const delay = Math.max(1, nextMidnight - this.now().getTime());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.refresh();
    }, delay);
  }
}
