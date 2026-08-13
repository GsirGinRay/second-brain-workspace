import assert from "node:assert/strict";
import test from "node:test";
import { TaipeiTodayController } from "./taipei-clock";

test("today rolls over at Taipei midnight and can be refreshed by focus/visibility", () => {
  let now = new Date("2026-01-01T15:59:59.999Z");
  const timers: Array<{ runAt: number; callback: () => void }> = [];
  const controller = new TaipeiTodayController({
    now: () => now,
    setTimeout: (callback, delay) => {
      timers.push({ runAt: now.getTime() + delay, callback });
      return timers.length;
    },
    clearTimeout: () => undefined,
  });
  const changes: string[] = [];
  controller.subscribe((today) => changes.push(today));

  controller.start();
  assert.equal(controller.getToday(), "2026-01-01");
  now = new Date("2026-01-01T16:00:00.000Z");
  timers.shift()?.callback();
  assert.equal(controller.getToday(), "2026-01-02");

  now = new Date("2026-01-02T15:59:59.999Z");
  controller.refresh();
  assert.equal(controller.getToday(), "2026-01-02");
  now = new Date("2026-01-02T16:00:00.000Z");
  controller.refresh();
  assert.equal(controller.getToday(), "2026-01-03");
  assert.deepEqual(changes, ["2026-01-02", "2026-01-03"]);
  controller.stop();
});
