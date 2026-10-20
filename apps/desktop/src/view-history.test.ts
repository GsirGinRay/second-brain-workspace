import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyViewHistory,
  goBack,
  goForward,
  navigateTo,
  VIEW_HISTORY_LIMIT,
} from "./view-history";

test("navigating records the previous view so back returns to it", () => {
  const start = emptyViewHistory("today");
  const atKnowledge = navigateTo(start, "collections");
  assert.equal(atKnowledge.current, "collections");
  assert.deepEqual(atKnowledge.back, ["today"]);
  const back = goBack(atKnowledge);
  assert.equal(back.current, "today");
  assert.deepEqual(back.back, []);
  assert.deepEqual(back.forward, ["collections"]);
  const forward = goForward(back);
  assert.equal(forward.current, "collections");
  assert.deepEqual(forward.back, ["today"]);
});

test("re-selecting the current view does not add a history step", () => {
  const start = emptyViewHistory("today");
  assert.equal(navigateTo(start, "today"), start);
});

test("a new navigation clears the forward stack", () => {
  const back = goBack(navigateTo(navigateTo(emptyViewHistory("today"), "calendar"), "board"));
  assert.deepEqual(back.forward, ["board"]);
  const branched = navigateTo(back, "projects");
  assert.deepEqual(branched.forward, []);
  assert.deepEqual(branched.back, ["today", "calendar"]);
});

test("back and forward are no-ops at the ends and never mutate input", () => {
  const start = emptyViewHistory("today");
  assert.equal(goBack(start), start);
  assert.equal(goForward(start), start);
  const moved = navigateTo(start, "board");
  const frozen = JSON.stringify(moved);
  goBack(moved);
  assert.equal(JSON.stringify(moved), frozen);
});

test("history keeps only the most recent steps", () => {
  let state = emptyViewHistory<"today" | "calendar" | "board">("today");
  for (let index = 0; index < VIEW_HISTORY_LIMIT + 10; index += 1) {
    state = navigateTo(state, index % 2 === 0 ? "calendar" : "board");
  }
  assert.equal(state.back.length, VIEW_HISTORY_LIMIT);
});
