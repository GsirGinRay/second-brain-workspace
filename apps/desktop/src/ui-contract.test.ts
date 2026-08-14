import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = () => readFileSync(resolve(import.meta.dirname, "App.tsx"), "utf8");
const css = () => readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");
const tauriConfig = () =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"),
      "utf8",
    ),
  ) as { app?: { windows?: Array<{ dragDropEnabled?: boolean }> } };
const publisherTauriExample = () =>
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../private/publisher-profile.tauri.example.json",
      ),
      "utf8",
    ),
  ) as { app?: { windows?: Array<{ dragDropEnabled?: boolean }> } };
const publisherInstallerScript = () =>
  readFileSync(
    resolve(import.meta.dirname, "../../../scripts/build-publisher-installer.mjs"),
    "utf8",
  );

test("desktop includes today, calendar, board, projects and settings views", () => {
  const source = app();
  for (const view of ["today", "calendar", "board", "projects", "sync"])
    assert.match(source, new RegExp(`\\b${view}\\b`));
  assert.match(source, /calendar-task-title/);
  assert.match(source, /most-important/);
  assert.match(source, /vault-changed/);
});

test("desktop supports quick add, editing, task actions and readable icons", () => {
  const source = app();
  for (const icon of [
    "Trash2", "CheckCircle2", "RefreshCw", "Plus", "Pencil", "Search",
    "Star", "Menu", "Eye", "Save", "RotateCcw",
  ]) assert.match(source, new RegExp(`<${icon}\\b`));
  assert.match(source, /<TaskEditor/);
  assert.match(source, /deleteTaskPermanently/);
  assert.match(source, /markMostImportant/);
});

test("desktop has no Google Calendar integration surface", () => {
  const source = app();
  assert.doesNotMatch(source, /Google Calendar|calendarSyncEnabled|CalendarIntegration/);
  assert.doesNotMatch(readFileSync(resolve(import.meta.dirname, "device-client.ts"), "utf8"), /getCalendarIntegrationStatus/);
});

test("quick add opens with N outside editable controls", () => {
  const source = app();
  assert.match(source, /event\.key\.toLowerCase\(\) === "n"/);
  assert.match(source, /!isEditableElement\(event\.target\)/);
});

test("board and calendar expose direct date editing and task-level drag feedback", () => {
  const source = app();
  const styles = css();
  assert.match(source, /className="board-date-input"/);
  assert.match(source, /className="calendar-task-drag-handle"/);
  assert.match(source, /dragTaskId === entry\.task\.id \? "dragging"/);
  assert.match(source, /event\.stopPropagation\(\)/);
  assert.match(styles, /\.calendar-task-title\.dragging/);
  assert.match(styles, /\.week-task-list article\.dragging/);
});

test("Windows WebView permits HTML task drag and carries the task id through dataTransfer", () => {
  const source = app();
  assert.equal(tauriConfig().app?.windows?.[0]?.dragDropEnabled, false);
  assert.match(source, /dataTransfer\.setData\("text\/plain"/);
  assert.match(source, /dataTransfer\.getData\("text\/plain"\)/);
});

test("private Publisher builds cannot override the Windows HTML drag setting", () => {
  assert.equal(
    publisherTauriExample().app?.windows?.[0]?.dragDropEnabled,
    false,
  );
  assert.match(
    publisherInstallerScript(),
    /dragDropEnabled\s*!==\s*false/,
  );
});

test("calendar drag feedback dims the source day, raises the task, and marks the drop target", () => {
  const source = app();
  const styles = css();
  assert.match(source, /dragOriginDate/);
  assert.match(source, /dropTargetDate/);
  assert.match(source, /"drag-origin"/);
  assert.match(source, /"drop-target"/);
  assert.match(styles, /\.calendar-day\.drag-origin/);
  assert.match(styles, /\.calendar-day\.drop-target/);
  assert.match(styles, /\.calendar-task-title\.selected-task[^}]*translateY/);
  assert.doesNotMatch(styles, /\.calendar-task-title\.selected-task[^}]*0 0 0 4px/);
});

test("week calendar and idea inbox use compact responsive cards", () => {
  const styles = css();
  assert.match(styles, /\.idea-grid\{display:grid/);
  assert.match(styles, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.week-task-list article[^}]*min-height:0/);
  assert.doesNotMatch(styles, /\.idea-drawer article[^}]*min-width:220px/);
});

test("idea inbox is calm by default and supports accessible quick deletion", () => {
  const source = app();
  const styles = css();
  assert.match(source, /ideasExpanded \? ideas : ideas\.slice\(0, 8\)/);
  assert.match(source, /className="idea-delete-button"/);
  assert.match(source, /aria-label=\{\`永久刪除想法/);
  assert.match(source, /onContextMenu=/);
  assert.match(source, /role="menu"/);
  assert.match(styles, /\.idea-card-body/);
  assert.match(styles, /\.idea-delete-button/);
  assert.match(styles, /\.idea-context-menu/);
});

test("task actions are compact accessible icons and permanent delete is never archived", () => {
  const source = app();
  const styles = css();
  assert.match(source, /function TaskActionBar/);
  for (const label of ["設為最重要", "標記完成", "編輯任務", "永久刪除"]) {
    assert.match(source, new RegExp(`aria-label=\\{?[^\\n]*${label}`));
  }
  assert.match(source, /onDelete=\{onDelete\}/);
  assert.doesNotMatch(source, /永久刪除[\s\S]{0,180}archive\(/);
  assert.match(styles, /\.task-action-button[^}]*min-width:\s*40px/);
  assert.match(styles, /\.agenda-actions[^}]*grid-template-columns:\s*repeat\(4/);
});

test("desktop exposes global task and project search with keyboard shortcuts", () => {
  const source = app();
  assert.match(source, /WorkspaceSearch/);
  assert.match(source, /Ctrl\/Cmd\+K/);
  assert.match(source, /event\.key === "\/"/);
  assert.match(source, /關聯性/);
  assert.match(source, /日期/);
});

test("desktop calendar and board expose the task editor", () => {
  const source = app();
  assert.match(source, /<Board[\s\S]*projects=\{projects\}/);
  assert.match(source, /<Calendar[\s\S]*projects=\{projects\}/);
  assert.match(source, /<TaskEditor[\s\S]*task=\{task\}[\s\S]*projects=\{projects\}/);
});

test("completed tasks are hidden by default and the preference is local", () => {
  const source = app();
  assert.match(source, /second-brain\.showCompletedTasks/);
  assert.match(source, /filterCompletedTasks/);
  assert.match(css(), /text-decoration:\s*line-through/);
});

test("theme is monochrome with red reserved for important and destructive actions", () => {
  const styles = css();
  assert.match(styles, /--accent-red:/);
  assert.match(styles, /\.task-card\.most-important/);
  assert.match(styles, /\.calendar-task-title\.most-important/);
  assert.match(styles, /\.danger/);
});

test("remote cloud access is absent from the default Tauri CSP", () => {
  const config = readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8");
  assert.doesNotMatch(config, /gsir\.zeabur\.app/);
  assert.doesNotMatch(config, /connect-src[^;]*\shttps:/);
  assert.match(config, /http:\/\/localhost:\*/);
});
