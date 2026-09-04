import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_PREFERENCES,
  normalizeUiPreferences,
  translate,
  type UiPreferences,
} from "./ui-preferences";

test("UI preferences default to Traditional Chinese, light theme and comfortable density", () => {
  assert.deepEqual(DEFAULT_UI_PREFERENCES, {
    language: "zh-TW",
    theme: "light",
    density: "comfortable",
    detailSurface: "dialog",
  });
});

test("UI preferences accept only supported persisted values", () => {
  assert.deepEqual(
    normalizeUiPreferences({ language: "en", theme: "dark" }),
    { language: "en", theme: "dark", density: "comfortable", detailSurface: "dialog" },
  );
  assert.deepEqual(
    normalizeUiPreferences({ language: "ja", theme: "system" }),
    DEFAULT_UI_PREFERENCES,
  );
  assert.deepEqual(normalizeUiPreferences(null), DEFAULT_UI_PREFERENCES);
});

test("density normalizes to a supported value", () => {
  assert.equal(normalizeUiPreferences({ language: "en", theme: "dark", density: "compact" }).density, "compact");
  assert.equal(normalizeUiPreferences({ language: "en", theme: "dark", density: "huge" }).density, "comfortable");
});

test("translations preserve stable data values while localizing visible labels", () => {
  assert.equal(translate("zh-TW", "task.status.waiting"), "等待");
  assert.equal(translate("en", "task.status.waiting"), "Waiting");
  assert.equal(translate("en", "task.status.waitingHelp"), "Waiting for a reply, material, approval, date, or another external condition");
  assert.equal(translate("en", "project.action.delete"), "Delete permanently");
  assert.equal(translate("en", "missing.key"), "missing.key");
});

test("Traditional Chinese project view labels do not mix in English View", () => {
  assert.equal(translate("zh-TW", "project.view.list"), "清單");
  assert.equal(translate("zh-TW", "project.view.board"), "狀態看板");
  assert.doesNotMatch(translate("zh-TW", "project.view.list"), /View/i);
  assert.doesNotMatch(translate("zh-TW", "project.view.board"), /View/i);
});

test("detail surface accepts the panel and rejects unknown persisted values", () => {
  assert.equal(normalizeUiPreferences({ language: "en", theme: "dark", detailSurface: "panel" }).detailSurface, "panel");
  assert.equal(normalizeUiPreferences({ language: "en", theme: "dark", detailSurface: "drawer" }).detailSurface, "dialog");
});

test("all UI choices round-trip as a complete preference", () => {
  const value: UiPreferences = { language: "en", theme: "dark", density: "compact", detailSurface: "panel" };
  assert.deepEqual(normalizeUiPreferences(JSON.parse(JSON.stringify(value))), value);
});
