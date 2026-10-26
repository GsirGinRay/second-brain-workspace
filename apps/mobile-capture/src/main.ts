import {
  INBOX_TEXT_BYTES_LIMIT,
  describeRecurrence,
  parseRecurrence,
  type InboxSnapshot,
  type SnapshotFeature,
  type SnapshotTask,
} from "@second-brain/brain-core";
import {
  UNDO_MS,
  addDays,
  applyLocalChanges,
  clearPairing,
  createChangeEntry,
  createEntry,
  dateKey,
  effectiveToday,
  endTime,
  fetchSnapshot,
  flushOutbox,
  groupSnapshot,
  isTextWithinLimit,
  loadCachedSnapshot,
  loadOutbox,
  loadPairing,
  loadView,
  nextMonday,
  pairingFragment,
  parsePairingFragment,
  resealQueued,
  saveCachedSnapshot,
  saveOutbox,
  savePairing,
  saveView,
  shellScript,
  textBytes,
  todayProgress,
  type CachedSnapshot,
  type LocalView,
  type OutboxEntry,
  type Pairing,
  type SnapshotResult,
  type TaskChange,
  type ViewOptions,
} from "./capture";
import { MESSAGES, format, type MessageKey } from "./messages";
import "./styles.css";

const language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const t = (key: MessageKey, values?: Record<string, string | number>) => format(MESSAGES[language][key], values);
const store = window.localStorage;
const origin = window.location.origin;
const standalone = window.matchMedia("(display-mode: standalone)").matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
const RETRY_MS = 30_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const composer = $<HTMLFormElement>("composer");
const textArea = $<HTMLTextAreaElement>("text");
const sendButton = $<HTMLButtonElement>("send");
const counter = $<HTMLElement>("counter");
const composerOptions = $<HTMLElement>("composer-options");
const addDateInput = $<HTMLInputElement>("add-date");
const addDateLabel = $<HTMLElement>("add-date-label");
const addProject = $<HTMLSelectElement>("add-project");
const notice = $<HTMLElement>("notice");
const unpaired = $<HTMLElement>("unpaired");
const pasteForm = $<HTMLFormElement>("paste-form");
const pasteInput = $<HTMLInputElement>("paste");
const install = $<HTMLElement>("install");
const installBody = $<HTMLElement>("install-body");
const copyLink = $<HTMLButtonElement>("copy-link");
const historySection = $<HTMLElement>("history-section");
const historyList = $<HTMLUListElement>("history");
const subtitle = $<HTMLElement>("subtitle");
const todaySection = $<HTMLElement>("today");
const todayUpdated = $<HTMLElement>("today-updated");
const todayNote = $<HTMLElement>("today-note");
const todayLists = $<HTMLElement>("today-lists");
const progress = $<HTMLElement>("progress");
const progressText = $<HTMLElement>("progress-text");
const progressBar = $<HTMLProgressElement>("progress-bar");
const viewBar = $<HTMLElement>("view-bar");
const viewProject = $<HTMLSelectElement>("view-project");
const sheet = $<HTMLDialogElement>("task-sheet");
const sheetTitle = $<HTMLElement>("sheet-title");
const sheetPending = $<HTMLElement>("sheet-pending");
const sheetDetails = $<HTMLElement>("sheet-details");
const sheetNotes = $<HTMLElement>("sheet-notes");
const sheetComplete = $<HTMLButtonElement>("sheet-complete");
const sheetFocus = $<HTMLButtonElement>("sheet-focus");
const sheetMove = $<HTMLElement>("sheet-move");
const sheetDate = $<HTMLInputElement>("sheet-date");
const sheetClose = $<HTMLButtonElement>("sheet-close");
const toast = $<HTMLElement>("toast");
const toastText = $<HTMLElement>("toast-text");
const toastUndo = $<HTMLButtonElement>("toast-undo");

let pairing: Pairing | null = loadPairing(store);
let outbox: OutboxEntry[] = loadOutbox(store);
let flushing = false;
let cachedSnapshot: CachedSnapshot | null = pairing ? loadCachedSnapshot(store, pairing) : null;
let snapshotState: SnapshotResult["kind"] | "loading" = "loading";
let view: ViewOptions = loadView(store);
/** Date picked for the next task: "today", "tomorrow" or YYYY-MM-DD. */
let addDate: string | null = null;
/** The task open in the sheet. */
let sheetTask: SnapshotTask | null = null;
let toastEntryId: string | null = null;
let toastTimer: number | undefined;

document.documentElement.lang = language === "zh" ? "zh-Hant-TW" : "en";
document.title = t("title");
for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
  node.textContent = t(node.dataset.i18n as MessageKey);
}
textArea.placeholder = t("placeholder");
pasteInput.placeholder = `${origin}/#v=1…`;

function showNotice(message: string) {
  notice.textContent = message;
  notice.hidden = message === "";
}

function persist() {
  saveOutbox(store, outbox);
  outbox = loadOutbox(store);
}

function pairingLink(value: Pairing) {
  return `${origin}/${pairingFragment(value)}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updatedLabel(generatedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 60_000));
  if (minutes < 2) return t("updatedJustNow");
  if (minutes < 60) return t("updatedMinutes", { n: minutes });
  if (minutes < 48 * 60) return t("updatedHours", { n: Math.floor(minutes / 60) });
  return t("updatedDays", { n: Math.floor(minutes / (24 * 60)) });
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  const weekday = new Date(`${date}T00:00:00`).toLocaleDateString(language === "zh" ? "zh-TW" : "en", { weekday: "short" });
  return `${month}/${day} ${weekday}`;
}

/** "今天", "明天", "昨天" or a short date. */
function relativeDate(date: string, today: string): string {
  if (date === today) return t("today");
  if (date === addDays(today, 1)) return t("tomorrow");
  if (date === addDays(today, -1)) return t("yesterday");
  return shortDate(date);
}

function features(): ReadonlySet<SnapshotFeature> {
  return new Set(cachedSnapshot?.snapshot.features ?? []);
}

function currentToday(): string {
  return cachedSnapshot ? effectiveToday(cachedSnapshot.snapshot) : dateKey(new Date());
}

function localView(): LocalView | null {
  return cachedSnapshot ? applyLocalChanges(cachedSnapshot.snapshot, outbox, currentToday()) : null;
}

function isHeld(entry: OutboxEntry, now = Date.now()): boolean {
  return entry.state === "queued" && entry.holdUntil !== undefined && entry.holdUntil > now;
}

// ---------------------------------------------------------------------------
// Today list

function taskRow(task: SnapshotTask, pending: ReadonlySet<string>, today: string, timeline = false): HTMLLIElement {
  const row = element("li", "task-row");
  row.dataset.priority = task.priority;
  const tick = element("button", "tick");
  tick.type = "button";
  tick.setAttribute("aria-label", `${t("tick")}：${task.title}`);
  tick.addEventListener("click", () => void change(task, { action: "complete" }));

  const open = element("button", "task-open");
  open.type = "button";
  open.setAttribute("aria-label", `${t("open")}：${task.title}`);
  open.addEventListener("click", () => openSheet(task.id));
  open.append(element("span", "task-title", task.title));
  const details = [
    task.project,
    task.recurrence ? "↻" : null,
    task.notes ? "≡" : null,
    !timeline && task.date && task.date < today ? relativeDate(task.date, today) : null,
    !timeline && task.time ? task.time : null,
  ].filter(Boolean).join(" · ");
  if (details || pending.has(task.id)) {
    const small = element("small", "task-meta", details);
    if (pending.has(task.id)) small.append(element("span", "pending-badge", t("pendingSync")));
    open.append(small);
  }

  if (timeline) {
    const time = element("span", "task-time");
    if (task.time) {
      time.append(element("strong", undefined, task.time));
      if (task.durationMinutes) time.append(element("small", undefined, endTime(task.time, task.durationMinutes)));
    }
    row.append(time);
    row.classList.add("timed");
  }
  row.append(tick, open);
  return row;
}

function taskGroup(name: string, label: string, rows: HTMLLIElement[]): HTMLElement {
  const group = element("section", "task-group");
  group.dataset.group = name;
  const list = element("ul", "task-list");
  list.append(...rows);
  group.append(element("h3", undefined, label), list);
  return group;
}

function renderViewBar(snapshot: InboxSnapshot) {
  viewBar.hidden = false;
  for (const button of viewBar.querySelectorAll<HTMLButtonElement>("[data-days]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.days) === view.days));
  }
  const names = [...new Set(snapshot.tasks.map((task) => task.project).filter((name): name is string => Boolean(name)))]
    .sort((left, right) => left.localeCompare(right, "zh-Hant"));
  if (view.project && !names.includes(view.project)) names.unshift(view.project);
  viewProject.replaceChildren(new Option(t("allProjects"), ""), ...names.map((name) => new Option(name, name)));
  viewProject.value = view.project ?? "";
  viewProject.hidden = names.length === 0;
}

function renderToday() {
  const hasViewKey = Boolean(pairing?.viewKey);
  todaySection.hidden = !pairing;
  todayLists.replaceChildren();
  todayUpdated.textContent = "";
  progress.hidden = true;
  viewBar.hidden = true;
  const note = !hasViewKey
    ? t("noViewKey")
    : snapshotState === "not_entitled"
      ? t("notEntitled")
      : snapshotState === "none"
        ? t("noSnapshot")
        : snapshotState === "error" && !cachedSnapshot
          ? t("snapshotError")
          : "";
  todayNote.textContent = note;
  todayNote.hidden = note === "";
  const local = localView();
  if (!hasViewKey || !cachedSnapshot || !local || snapshotState === "not_entitled") return;

  const today = currentToday();
  const groups = groupSnapshot(local.snapshot, view, today);
  todayUpdated.textContent = updatedLabel(cachedSnapshot.snapshot.generatedAt);
  renderViewBar(local.snapshot);

  const { done, total } = todayProgress(local, today);
  if (total > 0) {
    progress.hidden = false;
    progressText.textContent = done === total ? t("progressAllDone") : t("progress", { done, total });
    progressBar.max = total;
    progressBar.value = done;
  }

  if (groups.focus) {
    const card = element("div", "focus-card");
    const list = element("ul", "task-list");
    list.append(taskRow(groups.focus, local.pending, today));
    card.append(element("small", undefined, t("focus")), list);
    todayLists.append(card);
  }
  if (groups.overdue.length) {
    todayLists.append(taskGroup("overdue", t("overdue"), groups.overdue.map((task) => taskRow(task, local.pending, today))));
  }
  if (groups.today.length) {
    todayLists.append(taskGroup("today", t("todayList"), groups.today.map((task) => taskRow(task, local.pending, today, true))));
  }
  if (!groups.focus && !groups.today.length && !groups.overdue.length) {
    todayLists.append(element("p", "hint", t("emptyToday")));
  }
  for (const day of groups.upcoming) {
    todayLists.append(taskGroup("upcoming", relativeDate(day.date, today), day.tasks.map((task) => taskRow(task, local.pending, today))));
  }
}

// ---------------------------------------------------------------------------
// Task sheet

function detailRow(label: string, value: string): HTMLElement[] {
  return [element("dt", undefined, label), element("dd", undefined, value)];
}

function renderSheet() {
  const local = localView();
  const task = sheetTask ? local?.snapshot.tasks.find((item) => item.id === sheetTask?.id) : undefined;
  if (!task || task.status === "done") {
    if (sheet.open) sheet.close();
    return;
  }
  const today = currentToday();
  const available = features();
  sheetTitle.textContent = task.title;
  sheetPending.hidden = !local?.pending.has(task.id);
  const relative = task.date ? relativeDate(task.date, today) : null;
  const dateText = !task.date || !relative ? t("noDate") : relative === shortDate(task.date) ? relative : `${relative}（${shortDate(task.date)}）`;
  const rows: HTMLElement[] = [...detailRow(t("date"), dateText)];
  if (task.time) {
    const span = task.durationMinutes ? `${task.time}–${endTime(task.time, task.durationMinutes)}・${t("minutes", { n: task.durationMinutes })}` : task.time;
    rows.push(...detailRow(t("time"), span));
  }
  if (task.project) rows.push(...detailRow(t("projectLabel"), task.project));
  if (task.recurrence) {
    const rule = parseRecurrence(task.recurrence);
    rows.push(...detailRow(t("repeat"), rule ? describeRecurrence(rule, language === "zh" ? "zh-TW" : "en") : task.recurrence));
  }
  if (task.priority === "highest" && task.date === today) rows.push(...detailRow(t("priority"), t("focus")));
  sheetDetails.replaceChildren(...rows);
  sheetNotes.textContent = task.notes ?? "";
  sheetNotes.hidden = !task.notes;
  sheetFocus.hidden = !available.has("focus") || (task.priority === "highest" && task.date === today);
  sheetMove.hidden = !available.has("reschedule");
  for (const button of sheetMove.querySelectorAll<HTMLButtonElement>("[data-move]")) {
    button.hidden = button.dataset.move === "today" && task.date === today;
  }
  sheetDate.value = task.date ?? "";
  sheetDate.min = today;
}

function openSheet(taskId: string) {
  sheetTask = cachedSnapshot?.snapshot.tasks.find((task) => task.id === taskId) ?? null;
  if (!sheetTask) return;
  renderSheet();
  if (!sheet.open) sheet.showModal();
}

function closeSheet() {
  sheetTask = null;
  if (sheet.open) sheet.close();
}

sheetClose.addEventListener("click", closeSheet);
sheet.addEventListener("close", () => {
  sheetTask = null;
});
// A tap on the dimmed backdrop closes the sheet.
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});
sheetComplete.addEventListener("click", () => {
  if (sheetTask) void change(sheetTask, { action: "complete" });
});
sheetFocus.addEventListener("click", () => {
  if (sheetTask) void change(sheetTask, { action: "focus" });
});
for (const button of sheetMove.querySelectorAll<HTMLButtonElement>("[data-move]")) {
  button.addEventListener("click", () => {
    if (!sheetTask) return;
    const today = currentToday();
    const target = button.dataset.move === "today" ? today : button.dataset.move === "tomorrow" ? addDays(today, 1) : nextMonday(today);
    void change(sheetTask, { action: "reschedule", date: target });
  });
}
sheetDate.addEventListener("change", () => {
  if (sheetTask && /^\d{4}-\d{2}-\d{2}$/.test(sheetDate.value) && sheetDate.value !== sheetTask.date) {
    void change(sheetTask, { action: "reschedule", date: sheetDate.value });
  }
});

// ---------------------------------------------------------------------------
// Changes with undo

function showToast(message: string, entryId: string) {
  window.clearTimeout(toastTimer);
  toastText.textContent = message;
  toastUndo.hidden = false;
  toastEntryId = entryId;
  toast.hidden = false;
  toastTimer = window.setTimeout(hideToast, UNDO_MS);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  toast.hidden = true;
  toastEntryId = null;
}

async function change(task: SnapshotTask, request: TaskChange) {
  if (!pairing) return;
  try {
    const entry = await createChangeEntry(pairing, task, request);
    outbox = [...outbox, entry];
    persist();
    closeSheet();
    render();
    const message = request.action === "complete"
      ? t("toastDone", { title: task.title })
      : request.action === "reschedule" && request.date
        ? t("toastMoved", { date: relativeDate(request.date, currentToday()) })
        : t("toastFocus");
    showToast(message, entry.id);
    // Sent once the undo window has passed.
    window.setTimeout(() => void flush(), UNDO_MS + 200);
  } catch {
    showNotice(t("sealFailed"));
  }
}

toastUndo.addEventListener("click", () => {
  const entry = outbox.find((item) => item.id === toastEntryId);
  if (entry && isHeld(entry)) {
    outbox = outbox.filter((item) => item !== entry);
    persist();
    render();
    toastText.textContent = t("undone");
    toastUndo.hidden = true;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(hideToast, 1_500);
  } else {
    hideToast();
  }
});

// ---------------------------------------------------------------------------
// Composer

function resolvedAddDate(): string | undefined {
  const today = currentToday();
  if (addDate === "today") return today;
  if (addDate === "tomorrow") return addDays(today, 1);
  return addDate ?? undefined;
}

function renderComposerOptions() {
  const snapshot = cachedSnapshot?.snapshot;
  const enabled = Boolean(snapshot && features().has("add-options") && snapshotState !== "not_entitled");
  composerOptions.hidden = !enabled;
  if (!enabled || !snapshot) return;
  for (const chip of composerOptions.querySelectorAll<HTMLButtonElement>("[data-add-date]")) {
    chip.setAttribute("aria-pressed", String(addDate === chip.dataset.addDate));
  }
  const picked = addDate && /^\d{4}-/.test(addDate) ? addDate : null;
  addDateLabel.textContent = picked ? shortDate(picked) : t("pickDate");
  addDateLabel.parentElement?.setAttribute("aria-pressed", String(Boolean(picked)));
  addDateInput.min = currentToday();
  const projects = snapshot.projects ?? [];
  const selected = addProject.value;
  addProject.replaceChildren(new Option(t("noProject"), ""), ...projects.map((project) => new Option(project.name, project.id)));
  addProject.value = projects.some((project) => project.id === selected) ? selected : "";
  addProject.hidden = projects.length === 0;
  addProject.setAttribute("aria-pressed", String(addProject.value !== ""));
}

for (const chip of composerOptions.querySelectorAll<HTMLButtonElement>("[data-add-date]")) {
  chip.addEventListener("click", () => {
    addDate = addDate === chip.dataset.addDate ? null : (chip.dataset.addDate ?? null);
    addDateInput.value = "";
    renderComposerOptions();
  });
}
addDateInput.addEventListener("change", () => {
  addDate = /^\d{4}-\d{2}-\d{2}$/.test(addDateInput.value) ? addDateInput.value : null;
  renderComposerOptions();
});
addProject.addEventListener("change", renderComposerOptions);

// ---------------------------------------------------------------------------

function historyText(entry: OutboxEntry): string {
  if (entry.action === "complete") return t("historyDone", { title: entry.text });
  if (entry.action === "focus") return t("historyFocus", { title: entry.text });
  if (entry.action === "reschedule" && entry.date) return t("historyMoved", { title: entry.text, date: shortDate(entry.date) });
  return entry.text;
}

function render() {
  composer.hidden = !pairing;
  unpaired.hidden = Boolean(pairing);
  subtitle.textContent = pairing ? t("paired") : t("notPaired");

  const bytes = textBytes(textArea.value);
  counter.textContent = bytes > INBOX_TEXT_BYTES_LIMIT * 0.8 ? `${bytes} / ${INBOX_TEXT_BYTES_LIMIT}` : "";
  counter.classList.toggle("over", bytes > INBOX_TEXT_BYTES_LIMIT);
  sendButton.disabled = !isTextWithinLimit(textArea.value);

  install.hidden = standalone || !pairing;
  installBody.textContent = ios ? t("installIos") : t("installAndroid");
  copyLink.hidden = !ios;

  const now = Date.now();
  historyList.replaceChildren(...[...outbox].reverse().map((entry) => {
    const item = element("li");
    item.dataset.state = isHeld(entry, now) ? "held" : entry.state;
    const state = isHeld(entry, now)
      ? t("stateHeld")
      : t(entry.state === "sent" ? "stateSent" : entry.state === "failed" ? "stateFailed" : "stateQueued");
    item.append(element("span", "entry-text", historyText(entry)), element("small", undefined, state));
    return item;
  }));
  historySection.hidden = outbox.length === 0;
  renderComposerOptions();
  renderToday();
  if (sheet.open) renderSheet();
}

async function flush() {
  if (!pairing || flushing || !outbox.some((entry) => entry.state === "queued")) return;
  flushing = true;
  try {
    const outcome = await flushOutbox(origin, pairing, outbox, (url, init) => fetch(url, init));
    outbox = outcome.entries;
    persist();
    const now = Date.now();
    if (outcome.unpaired) {
      pairing = null;
      clearPairing(store);
      showNotice(t("expired"));
    } else if (outcome.entries.some((entry) => entry.state === "queued" && !isHeld(entry, now))) {
      showNotice(navigator.onLine ? t("retrying") : t("offline"));
    } else if (outcome.sent > 0) {
      showNotice("");
    }
  } finally {
    flushing = false;
    render();
  }
}

let refreshing = false;
async function refreshToday() {
  if (!pairing?.viewKey || refreshing) return;
  refreshing = true;
  try {
    const result = await fetchSnapshot(origin, pairing, (url, init) => fetch(url, init));
    snapshotState = result.kind;
    if (result.kind === "ok") {
      // Never step back to an older list than one already shown.
      if (!cachedSnapshot || result.version >= cachedSnapshot.version) {
        cachedSnapshot = { inboxId: pairing.inboxId, version: result.version, snapshot: result.snapshot };
        saveCachedSnapshot(store, cachedSnapshot);
      }
    } else if (result.kind === "not_entitled" || result.kind === "none") {
      cachedSnapshot = null;
      saveCachedSnapshot(store, null);
    } else if (result.kind === "unpaired") {
      pairing = null;
      clearPairing(store);
      showNotice(t("expired"));
    }
  } finally {
    refreshing = false;
    render();
  }
}

async function adoptPairing(next: Pairing) {
  const changed = !pairing || pairing.inboxId !== next.inboxId || pairing.token !== next.token || pairing.publicKey !== next.publicKey;
  pairing = next;
  savePairing(store, next);
  if (changed) {
    outbox = await resealQueued(next, outbox);
    persist();
    cachedSnapshot = loadCachedSnapshot(store, next);
    showNotice(t("pairedNow"));
  }
}

for (const button of viewBar.querySelectorAll<HTMLButtonElement>("[data-days]")) {
  button.addEventListener("click", () => {
    view = { ...view, days: button.dataset.days === "7" ? 7 : 3 };
    saveView(store, view);
    render();
  });
}
viewProject.addEventListener("change", () => {
  view = { ...view, project: viewProject.value || null };
  saveView(store, view);
  render();
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textArea.value;
  if (!pairing || !isTextWithinLimit(text)) return;
  sendButton.disabled = true;
  const options = composerOptions.hidden ? {} : { date: resolvedAddDate(), projectId: addProject.value || undefined };
  void createEntry(pairing, text, new Date(), options)
    .then((entry) => {
      outbox = [...outbox, entry];
      persist();
      textArea.value = "";
      addDate = null;
      addDateInput.value = "";
      addProject.value = "";
      showNotice(t("saved"));
      render();
      return flush();
    })
    .catch(() => {
      showNotice(t("sealFailed"));
      render();
    });
});

textArea.addEventListener("input", render);
textArea.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) composer.requestSubmit();
});

pasteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = pasteInput.value.trim();
  const fragment = value.includes("#") ? value.slice(value.indexOf("#")) : "";
  const next = parsePairingFragment(fragment);
  if (!next || (value.startsWith("http") && !value.startsWith(`${origin}/`))) {
    showNotice(t("pasteInvalid"));
    return;
  }
  pasteInput.value = "";
  void adoptPairing(next).then(() => {
    render();
    void refreshToday();
    return flush();
  });
});

copyLink.addEventListener("click", () => {
  if (!pairing) return;
  void navigator.clipboard.writeText(pairingLink(pairing))
    .then(() => showNotice(t("copied")))
    .catch(() => showNotice(t("copyFailed")));
});

window.addEventListener("online", () => {
  void flush();
  void refreshToday();
});
/**
 * An installed app resumes from the background without reloading, so it can
 * run an old version for days. Reload onto a new deploy when nothing is typed
 * and no task sheet is open; queued tasks are kept in storage either way.
 */
async function checkForUpdate() {
  const running = document.querySelector<HTMLScriptElement>("script[type=\"module\"][src]")?.getAttribute("src");
  if (!running || !navigator.onLine) return;
  void navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
  try {
    const response = await fetch(`/?update-check=${Date.now()}`, { cache: "no-store" });
    const latest = response.ok ? shellScript(await response.text()) : null;
    if (latest && latest !== running && !textArea.value.trim() && !sheet.open) window.location.reload();
  } catch {
    // Offline or the server is down: keep the running version.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void flush();
    void refreshToday();
    void checkForUpdate();
  }
});
window.setInterval(() => void flush(), RETRY_MS);
window.setInterval(() => {
  if (document.visibilityState === "visible") void refreshToday();
}, 60_000);

async function start() {
  const fromQr = parsePairingFragment(window.location.hash);
  if (fromQr) {
    await adoptPairing(fromQr);
    // Inside Safari the address keeps the pairing, so "Add to Home Screen"
    // can carry it; an installed app drops it from the address bar.
    if (standalone) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  // Android share sheet: /?title=…&text=…&url=…
  const params = new URLSearchParams(window.location.search);
  const shared = [params.get("title"), params.get("text"), params.get("url")]
    .map((value) => value?.trim() ?? "")
    .filter((value, index, all) => value !== "" && all.indexOf(value) === index)
    .join("\n");
  if (shared) {
    textArea.value = shared;
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }

  render();
  // The list is what people open the app for; only a share jumps to typing.
  if (pairing && shared) textArea.focus();
  void flush();
  void refreshToday();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

void start();
