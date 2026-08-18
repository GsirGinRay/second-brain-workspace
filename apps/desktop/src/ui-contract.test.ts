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
  ) as { productName?: string; version?: string; identifier?: string; app?: { windows?: Array<{ dragDropEnabled?: boolean }> }; bundle?: { windows?: { allowDowngrades?: boolean; nsis?: { installMode?: string } } } };
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

test("Windows task drag uses pointer events because HTML5 drag is unreliable in the WebView", () => {
  const source = app();
  assert.equal(tauriConfig().app?.windows?.[0]?.dragDropEnabled, false);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /elementFromPoint/);
  assert.match(source, /finishPointerDrag/);
  assert.match(source, /finishBoardPointer/);
  assert.doesNotMatch(source, /dataTransfer\.setData/);
  assert.doesNotMatch(source, /dataTransfer\.getData/);
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
  for (const key of ["task.action.important", "task.action.complete", "task.action.edit", "task.action.delete"]) {
    assert.ok(source.includes(`t("${key}")`));
  }
  assert.match(source, /aria-label=\{done \? t\("task\.action\.reopen"\) : t\("task\.action\.complete"\)\}/);
  assert.match(source, /onDelete=\{onDelete\}/);
  assert.doesNotMatch(source, /永久刪除[\s\S]{0,180}archive\(/);
  assert.match(styles, /\.task-action-button[^}]*min-width:\s*40px/);
  assert.match(styles, /\.agenda-actions[^}]*grid-template-columns:\s*repeat\(4/);
  assert.match(source, /function AgendaInlineTitle/);
  assert.match(source, /onEdit=\{\(\) => setEditingTaskId/);
  assert.match(source, /className="agenda-drag-handle"[\s\S]{0,400}setPointerCapture/);
  assert.match(source, /remoteEnabled:\s*devicePaired/);
  assert.match(source, /if \(devicePaired\) \{[\s\S]{0,160}runSync\(\{ background: true \}\)/);
});

test("today focus and calendar agenda expose the task body editor", () => {
  const source = app();
  const styles = css();
  assert.match(source, /inline-task-editor/);
  assert.match(source, /agenda-editor/);
  assert.match(source, /onEdit=\{\(\) => setEditingTaskId/);
  assert.match(source, /aria-label="編輯任務"/);
  assert.match(styles, /\.inline-task-editor,\.agenda-editor\{grid-column:1\/-1/);
});

test("today command center makes the daily template visible and understandable", () => {
  const source = app();
  const styles = css();
  assert.match(source, /className="routine-template-card"/);
  assert.match(source, /today\.template/);
  assert.match(source, /enabledRoutineItems/);
  assert.match(source, /today\.template\.manage/);
  assert.match(styles, /\.routine-template-card/);
  assert.match(styles, /\.routine-template-action/);
});

test("desktop exposes global task and project search with keyboard shortcuts", () => {
  const source = app();
  assert.match(source, /WorkspaceSearch/);
  assert.match(source, /Ctrl\/Cmd\+K/);
  assert.match(source, /event\.key === "\/"/);
  assert.match(source, /search\.relevance/);
  assert.match(source, /search\.date/);
});

test("projects navigate to an id-filtered board and expose planning, filters and safe deletion", () => {
  const source = app();
  assert.match(source, /selectedBoardProjectId/);
  assert.match(source, /task\.projectId === selectedProjectId/);
  assert.match(source, /value="planning">\{t\("project\.status\.planning"\)\}/);
  assert.match(source, /second-brain\.projectView/);
  assert.match(source, /buildProjectDeleteChanges/);
  assert.match(source, /保留 .*項未完成任務並解除專案連結/);
});

test("desktop separates collections from outcome projects and supports promotion", () => {
  const source = app();
  assert.match(source, /type View = [^;]*"collections"/);
  assert.match(source, /function Collections/);
  assert.match(source, /buildCollectionCreateChange/);
  assert.match(source, /task\.action\.promote/);
  assert.match(source, /search\.placeholder/);
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

test("global language and light-dark theme controls are persisted and accessible", () => {
  const source = app();
  const styles = css();
  assert.match(source, /UI_PREFERENCES_KEY/);
  assert.match(source, /data-theme=\{preferences\.theme\}/);
  assert.match(source, /aria-label=\{t\("app\.language"\)\}/);
  assert.match(source, /aria-label=\{t\("app\.theme"\)\}/);
  assert.match(styles, /\[data-theme="dark"\]/);
  assert.match(styles, /color-scheme:\s*dark/);
});

test("language switching keeps the top actions in a fixed icon toolbar", () => {
  const source = app();
  const styles = css();
  assert.match(source, /className="icon-button top-icon-action sync-icon-action"/);
  assert.doesNotMatch(source, /<div className="sync-state">\s*<span>/);
  assert.match(styles, /\.top-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(styles, /\.sync-state \.sync-icon-action\s*\{[^}]*width:\s*38px/);
});

test("dark mode keeps project and collection controls readable", () => {
  const styles = css();
  assert.match(styles, /\[data-theme="dark"\] \.project-filters select\s*\{[^}]*background:\s*var\(--paper\)[^}]*color:\s*var\(--ink\)/);
  assert.match(styles, /\[data-theme="dark"\] \.project-tabs span\s*\{[^}]*background:/);
});

test("desktop branding uses the generated app logo", () => {
  const source = app();
  assert.match(source, /import appLogo from "\.\/assets\/app-logo\.png"/);
  assert.match(source, /<img className="brand-logo" src=\{appLogo\}/);
});

test("beginner workflow supports Markdown drafts, onboarding and close-time folder selection", () => {
  const source = app();
  assert.match(source, /<MarkdownEditor/);
  assert.match(source, /loadDraftWorkspace/);
  assert.match(source, /onCloseRequested/);
  assert.match(source, /onboardingOpen/);
  assert.match(source, /flushDraftsToSelectedVault/);
});

test("Windows installer keeps a stable upgrade identity", () => {
  const config = tauriConfig();
  assert.equal(config.productName, "Second Brain Workspace");
  assert.equal(config.identifier, "app.secondbrain.workspace");
  assert.equal(config.version, "0.4.1");
  assert.equal(config.bundle?.windows?.nsis?.installMode, "currentUser");
  assert.equal(config.bundle?.windows?.allowDowngrades, false);
});

test("project actions use accessible icon-only controls while state labels remain visible", () => {
  const source = app();
  assert.match(source, /className="project-actions project-icon-actions"/);
  for (const icon of ["Save", "CheckCircle2", "Archive", "Trash2"]) {
    assert.match(source, new RegExp(`<${icon}\\b`));
  }
  assert.match(source, /aria-label=\{t\("project\.action\.delete"\)\}/);
  assert.match(source, /task\.status\.waitingHelp/);
});

test("remote cloud access is absent from the default Tauri CSP", () => {
  const config = readFileSync(resolve(import.meta.dirname, "../src-tauri/tauri.conf.json"), "utf8");
  assert.doesNotMatch(config, /gsir\.zeabur\.app/);
  assert.doesNotMatch(config, /connect-src[^;]*\shttps:/);
  assert.match(config, /http:\/\/localhost:\*/);
});

test("vault-changed refreshes local-only mode without a server", () => {
  const source = app();
  assert.match(source, /listen\("vault-changed"/);
  assert.match(
    source,
    /if \(engine\) void runSync\(\{ background: true \}\);\s*else void reloadLocal\(false\)/s,
  );
  assert.match(source, /lastScanRef/);
  assert.match(source, /unchanged && !updateStatus/);
});
