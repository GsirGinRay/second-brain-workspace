import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMinutesAsTime,
  layoutTimedBlocks,
  minutesFromOffset,
  parseTimeToMinutes,
  PX_PER_HOUR,
  snapMinutes,
  timeFromSlotDrop,
} from "./day-schedule";

test("clock times round-trip through minutes and snap to quarter hours", () => {
  assert.equal(parseTimeToMinutes("09:30"), 570);
  assert.equal(parseTimeToMinutes("24:00"), null);
  assert.equal(formatMinutesAsTime(570), "09:30");
  assert.equal(snapMinutes(37), 30);
  assert.equal(snapMinutes(38), 45);
  assert.equal(formatMinutesAsTime(minutesFromOffset(PX_PER_HOUR * 9)), "09:00");
});

test("dropping on an hour slot uses the slot's hour when height is unknown", () => {
  assert.equal(timeFromSlotDrop(9 * 60, 10, 0, 0), "09:00");
  assert.equal(timeFromSlotDrop(9 * 60, 42, 0, 56), "09:45");
});

test("timed blocks stack into columns when they overlap", () => {
  const layout = layoutTimedBlocks([
    { id: "a", startTime: "09:00", durationMinutes: 60 },
    { id: "b", startTime: "09:30", durationMinutes: 60 },
    { id: "c", startTime: "11:00", durationMinutes: 30 },
  ]);
  const byId = Object.fromEntries(layout.map((item) => [item.id, item]));
  assert.equal(byId.a?.columns, 2);
  assert.equal(byId.b?.columns, 2);
  assert.notEqual(byId.a?.column, byId.b?.column);
  assert.equal(byId.c?.columns, 1);
  assert.equal(byId.a?.top, 9 * PX_PER_HOUR);
  assert.equal(byId.a?.height, PX_PER_HOUR);
});
