import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = () => readFileSync(resolve(import.meta.dirname, "App.tsx"), "utf8");
const css = () => readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");
const detail = () => readFileSync(resolve(import.meta.dirname, "entity-detail-dialog.tsx"), "utf8");
const blockEditor = () => readFileSync(resolve(import.meta.dirname, "markdown-block-editor.tsx"), "utf8");
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
  assert.match(source, /<TaskDetailDialog/);
  assert.match(source, /<ProjectDetailDialog/);
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
  assert.match(source, /armLabel=\{`永久刪除想法/);
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
  assert.match(source, /onOpenTask=\{\(id\) => openDetail\("task", id\)\}/);
  assert.match(source, /className="week-task-actions"/);
  assert.match(source, /className=\{`calendar-quick-check/);
  assert.match(source, /className="agenda-drag-handle"[\s\S]{0,400}setPointerCapture/);
  assert.match(source, /remoteEnabled:\s*devicePaired/);
  assert.match(source, /if \(devicePaired\) \{[\s\S]{0,160}runSync\(\{ background: true \}\)/);
});

test("tasks use one Notion-like live Markdown detail canvas", () => {
  const source = app();
  const styles = css();
  const detailSource = detail();
  const blockSource = blockEditor();
  assert.match(source, /activeDetail\?\.kind === "task"/);
  assert.match(detailSource, /<MarkdownBlockEditor/);
  assert.doesNotMatch(detailSource, /<MarkdownEditor/);
  assert.doesNotMatch(detailSource, /role="tablist"/);
  assert.match(blockSource, /data-markdown-drag-handle/);
  assert.match(blockSource, /className="markdown-block-add-inline"[\s\S]{0,700}className="markdown-block-grip"/);
  assert.match(blockSource, /type="checkbox"/);
  assert.match(styles, /\.markdown-block-editor/);
});

test("today command center exposes template management from the hero", () => {
  const source = app();
  const styles = css();
  assert.match(source, /className="command-hero"/);
  assert.match(source, /hero-actions/);
  assert.match(source, /today\.template\.manage/);
  assert.match(source, /today\.template\.collapse/);
  assert.ok(!/className="routine-template-card"/.test(source), "template card was folded into the hero");
  assert.match(styles, /\.routine-template-card/);
  assert.match(styles, /\.hero-actions/);
});

test("desktop exposes global task and project search with keyboard shortcuts", () => {
  const source = app();
  assert.match(source, /WorkspaceSearch/);
  assert.match(source, /Ctrl\/Cmd\+K/);
  assert.match(source, /event\.key === "\/"/);
  assert.match(source, /search\.relevance/);
  assert.match(source, /search\.date/);
});

test("detail panels support multiple views while capture defaults to today", () => {
  const source = app();
  const detailSource = detail();
  const styles = css();
  assert.match(source, /const \[detailTargets, setDetailTargets\]/);
  assert.match(source, /setView\("projects"\);[\s\S]{0,80}openDetail\("project", result\.id\)/);
  assert.match(source, /const \[ideaInbox, setIdeaInbox\] = useState\(false\)/);
  assert.match(source, /className="today-quick-add-fab"/);
  assert.match(detailSource, /className="detail-panel-resizer"/);
  assert.match(detailSource, /className="detail-dialog-tabs"/);
  assert.match(detailSource, /expanded \? <Minimize2/);
  assert.match(styles, /\.detail-dialog-panel\.detail-dialog-expanded/);
  assert.match(styles, /\[data-theme="dark"\] \.board-card small/);
});

test("projects navigate to an id-filtered board and expose planning, filters and safe deletion", () => {
  const source = app();
  assert.match(source, /selectedBoardProjectId/);
  assert.match(source, /task\.projectId === selectedProjectId/);
  assert.match(source, /value="planning">\{t\("project\.status\.planning"\)\}/);
  assert.match(source, /second-brain\.projectView/);
  assert.match(source, /buildProjectDeleteChanges/);
  // Deletion is confirmed by the in-place armed button, not a detached
  // window.confirm dialog standing between the user and the control.
  assert.doesNotMatch(source, /window\.confirm\([^)]*解除專案連結/s);
  assert.match(source, /onDelete=\{\(\) => \{ void permanentlyDeleteProject\(selectedProjectDetail\); if \(activeDetailKey\) closeDetail\(activeDetailKey\); \}\}/);
});

test("desktop separates collections from outcome projects and supports promotion", () => {
  const source = app();
  assert.match(source, /type View = [^;]*"collections"/);
  assert.match(source, /function Collections/);
  assert.match(source, /buildCollectionCreateChange/);
  assert.match(source, /task\.action\.promote/);
  assert.match(source, /search\.placeholder/);
});

test("desktop calendar and board open the shared task detail", () => {
  const source = app();
  assert.match(source, /<Board[\s\S]*projects=\{projects\}/);
  assert.match(source, /<Calendar[\s\S]*projects=\{projects\}/);
  assert.match(source, /<Board[\s\S]*onOpenTask=\{\(id\) => openDetail\("task", id\)\}/);
  assert.match(source, /<Calendar[\s\S]*onOpenTask=\{\(id\) => openDetail\("task", id\)\}/);
  assert.match(source, /<TaskDetailDialog[\s\S]*task=\{selectedTask\}/);
});

test("completed tasks are hidden by default and the preference is local", () => {
  const source = app();
  assert.match(source, /second-brain\.showCompletedTasks/);
  assert.match(source, /filterCompletedTasks/);
  assert.match(css(), /text-decoration:\s*line-through/);
});

test("completed visibility lives in each panel as an icon without a checkbox", () => {
  const source = app();
  assert.match(source, /function CompletedVisibilityButton/);
  assert.match(source, /<CompletedVisibilityButton/);
  assert.doesNotMatch(source, /completed-visibility-toggle/);
  assert.doesNotMatch(source, /className="icon-button top-icon-action completed-visibility-toggle/);
});

test("density toggle is removed from the visible toolbar", () => {
  const source = app();
  assert.doesNotMatch(source, /切換顯示密度/);
  assert.doesNotMatch(source, /Toggle density/);
});

test("today and calendar share a full-day schedule surface", () => {
  const source = app();
  const styles = css();
  assert.match(source, /<DaySchedule/);
  assert.match(source, /calendar\.schedule/);
  assert.match(source, /openSchedule/);
  assert.match(source, /<Maximize2\b/);
  assert.match(styles, /\.day-schedule\{display:grid/);
  assert.match(styles, /\.calendar-stage/);
  assert.match(styles, /\.week-grid\{[^}]*height:min\(52vh,520px\)/);
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

test("every drag lands in one undo funnel with toolbar buttons and shortcuts", () => {
  const source = app();
  const scheduleSource = readFileSync(resolve(import.meta.dirname, "day-schedule-view.tsx"), "utf8");
  assert.match(source, /applyPersistLocal/, "persistLocal wraps the single write funnel");
  assert.match(source, /recordUndo\(undoRef\.current/);
  assert.match(source, /function performUndo\(\)/);
  assert.match(source, /event\.shiftKey\) performRedo\(\)/);
  assert.match(source, /isEditableElement\(event\.target\)\) return;\s*event\.preventDefault\(\);\s*if \(event\.shiftKey\)/s);
  assert.match(source, /<Undo2 aria-hidden="true" \/>/);
  assert.match(source, /<Redo2 aria-hidden="true" \/>/);
  assert.match(source, /onReorderTray=\{\(/);
  assert.match(scheduleSource, /onReorderTray\?:/);
  assert.match(scheduleSource, /data-tray-card-id/);
  assert.match(scheduleSource, /fromTray: true/, "tray-origin drags reorder instead of clearing");
});

test("the Notion canvas drags with live feedback and its own undo", () => {
  const source = readFileSync(resolve(import.meta.dirname, "markdown-block-editor.tsx"), "utf8");
  const styles = css();
  const detailSource = detail();
  assert.match(source, /markdown-drop-indicator/);
  assert.match(source, /historyRef/);
  assert.match(source, /ArrowUp/);
  assert.match(source, /ArrowDown/);
  assert.match(source, /"上移此區塊"/);
  assert.match(source, /"下移此區塊"/);
  assert.match(styles, /\.markdown-drop-indicator/);
  assert.match(styles, /\.markdown-block-move/);
  assert.ok(detailSource.includes("<MarkdownBlockEditor"));
});

test("capture, detail and project surfaces accept tasks and projects inline", () => {
  const source = app();
  const styles = css();
  // Quick add: Notion canvas + searchable picker that can create a project.
  assert.match(source, /className="quick-content-field"[\s\S]{0,100}<span>\{t\("quick\.content"\)\}<\/span>[\s\S]{0,100}<MarkdownBlockEditor value=\{body\}/);
  assert.match(styles, /\.quick-content-field\{[^}]*margin-top:\s*18px/);
  assert.match(styles, /\.quick-content-field \.markdown-block-editor\{padding-top:\s*0\}/);
  assert.match(styles, /\.quick-content-field \.markdown-block\{grid-template-columns:\s*24px/);
  assert.match(styles, /\.quick-content-field \.markdown-block-add-inline\{position:\s*absolute;right:\s*24px\}/);
  assert.match(styles, /\.quick-content-field \.markdown-block-add\{margin:\s*0 0 4px 24px\}/);
  assert.doesNotMatch(styles, /\.quick-content-field \.markdown-block-editor\{[^}]*border:/);
  assert.doesNotMatch(styles, /\.quick-add-modal>\.modal-header\+label\{margin-left:/);
  assert.doesNotMatch(styles, /\.quick-content-field>span\{margin-left:/);
  assert.match(source, /<ProjectPicker[\s\S]{0,400}onCreateProject=\{onCreateProject\}/);
  assert.match(source, /onCreateProject=\{\(name\) => createProject\(name, null, null\)\}/);
  // Stray clicks and Escape auto-save a titled draft instead of discarding it.
  assert.match(source, /const closeGracefully = \(\) => \{[\s\S]{0,200}if \(!submit\(\)\) onClose\(\);/);
  // Project dialog binds new tasks to the open project.
  assert.match(source, /projectName: selectedProjectDetail\.name/);
  assert.match(styles, /\.detail-task-composer/);
});

test("today's focus panel widens the tray and surfaces star, time and delete inline", () => {
  const source = app();
  const styles = css();
  const schedule = readFileSync(resolve(import.meta.dirname, "day-schedule-view.tsx"), "utf8");
  assert.match(source, /toggleMostImportant/);
  assert.match(schedule, /onStar\?/);
  assert.match(schedule, /onPickProject\?/);
  assert.match(schedule, /schedule-tray-title-row/);
  assert.match(schedule, /schedule-tray-inline|timed-block-head/);
  // The tray lane is now the wide column; the timeline narrows accordingly,
  // and a draggable splitter lives between the two so the user can resize.
  assert.match(styles, /\.day-schedule\.has-tray\{grid-template-columns:var\(--tray-width,340px\) 6px minmax\(0,1fr\)\}/);
  assert.match(styles, /\.day-schedule-resizer\{[^}]*cursor:col-resize/);
  assert.match(styles, /\.danger-confirm\.armed[^}]*#b42318/);
  assert.doesNotMatch(styles, /\.danger-confirm\.armed\{[^}]*(?:width:auto|padding:6px 12px)/);
  assert.doesNotMatch(styles, /\.clear-check\{[^}]*width:\s*40px/);
  assert.match(styles, /\.inline-task-card\{[^}]*26px minmax\(0,1fr\)/);
});

test("board lanes offer an inline add button bound to the active project filter", () => {
  const source = app();
  const styles = css();
  assert.match(source, /lane-add-button/);
  assert.match(source, /t\("board\.lane\.add"\)/);
  assert.match(source, /createInLane\(lane\.id/);
  assert.match(source, /moveTaskToLane\(base, lane, today\)/);
  assert.match(styles, /\.lane-composer input/);
});
