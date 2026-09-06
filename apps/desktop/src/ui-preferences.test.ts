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

test("knowledge view uses 知識 / Knowledge on the menu, title and add button", () => {
  assert.equal(translate("zh-TW", "view.collections"), "知識");
  assert.equal(translate("en", "view.collections"), "Knowledge");
  assert.equal(translate("zh-TW", "view.collections.title"), "知識");
  assert.equal(translate("en", "view.collections.title"), "Knowledge");
  assert.equal(translate("zh-TW", "collection.title"), "知識");
  assert.equal(translate("en", "collection.title"), "Knowledge");
  assert.equal(translate("zh-TW", "collection.action.add"), "新增知識");
  assert.equal(translate("en", "collection.action.add"), "Add knowledge");
  assert.equal(translate("zh-TW", "entity.collection.title"), "新增知識");
  assert.equal(translate("en", "entity.collection.title"), "Add knowledge");
  assert.doesNotMatch(translate("en", "view.collections"), /Collection/i);
  assert.doesNotMatch(translate("en", "collection.action.add"), /Collection/i);
});

test("save as knowledge and related knowledge labels stay off the main menu", () => {
  assert.equal(translate("zh-TW", "knowledge.action.save"), "存成知識");
  assert.equal(translate("en", "knowledge.action.save"), "Save as knowledge");
  assert.equal(translate("zh-TW", "knowledge.save.help"), "會建成一篇長期筆記；原本的任務或日誌不會被改掉。");
  assert.equal(translate("en", "project.relatedKnowledge"), "Related knowledge");
  assert.equal(translate("zh-TW", "project.relatedKnowledge"), "相關知識");
  assert.doesNotMatch(translate("zh-TW", "view.today"), /知識/);
  assert.doesNotMatch(translate("zh-TW", "view.projects"), /知識/);
});

test("today journal labels stay in the Today view, not a new menu item", () => {
  assert.equal(translate("zh-TW", "today.journal"), "今天的日誌");
  assert.equal(translate("en", "today.journal"), "Today's journal");
  assert.equal(translate("zh-TW", "today.journal.hint"), "會議可放在日曆上；結論寫在這裡。");
  assert.equal(translate("en", "today.journal.hint"), "Meetings can stay on the calendar. Write conclusions here.");
  assert.doesNotMatch(translate("zh-TW", "view.today"), /日誌/);
});

test("empty states use plain-language first actions", () => {
  assert.equal(translate("zh-TW", "today.emptyAction"), "新增第一個任務");
  assert.equal(translate("en", "today.emptyAction"), "Add your first task");
  assert.equal(translate("zh-TW", "calendar.emptyDayAction"), "新增第一個任務");
  assert.equal(translate("en", "calendar.emptyDayAction"), "Add your first task");
  assert.equal(translate("zh-TW", "project.emptyFirstAction"), "從模板建立");
  assert.equal(translate("en", "project.emptyFirstAction"), "Create from template");
  assert.equal(translate("zh-TW", "project.emptyFirst"), "還沒有專案。");
});
