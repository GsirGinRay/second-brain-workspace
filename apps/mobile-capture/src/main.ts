import { INBOX_TEXT_BYTES_LIMIT, type SnapshotTask } from "@second-brain/brain-core";
import {
  clearPairing,
  createCompleteEntry,
  createEntry,
  fetchSnapshot,
  groupSnapshot,
  loadCachedSnapshot,
  pairingFragment,
  saveCachedSnapshot,
  type CachedSnapshot,
  type SnapshotResult,
  flushOutbox,
  isTextWithinLimit,
  loadOutbox,
  loadPairing,
  parsePairingFragment,
  resealQueued,
  saveOutbox,
  savePairing,
  textBytes,
  type OutboxEntry,
  type Pairing,
} from "./capture";
import { MESSAGES, type MessageKey } from "./messages";
import "./styles.css";

const language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
const t = (key: MessageKey, n?: number) => MESSAGES[language][key].replace("{n}", String(n ?? ""));
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

let pairing: Pairing | null = loadPairing(store);
let outbox: OutboxEntry[] = loadOutbox(store);
let flushing = false;
let cachedSnapshot: CachedSnapshot | null = pairing ? loadCachedSnapshot(store, pairing) : null;
let snapshotState: SnapshotResult["kind"] | "loading" = "loading";

document.documentElement.lang = language === "zh" ? "zh-Hant-TW" : "en";
document.title = t("title");
for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
  element.textContent = t(element.dataset.i18n as MessageKey);
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

function updatedLabel(generatedAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(generatedAt)) / 60_000));
  if (minutes < 2) return t("updatedJustNow");
  if (minutes < 60) return t("updatedMinutes", minutes);
  if (minutes < 48 * 60) return t("updatedHours", Math.floor(minutes / 60));
  return t("updatedDays", Math.floor(minutes / (24 * 60)));
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  const weekday = new Date(`${date}T00:00:00`).toLocaleDateString(language === "zh" ? "zh-TW" : "en", { weekday: "short" });
  return `${month}/${day} ${weekday}`;
}

function taskRow(task: SnapshotTask): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "task-row";
  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.setAttribute("aria-label", `${t("tick")}：${task.title}`);
  tick.addEventListener("click", () => void complete(task));
  const body = document.createElement("div");
  body.className = "task-body";
  const title = document.createElement("span");
  title.textContent = task.title;
  body.append(title);
  const details = [task.time, task.project].filter(Boolean).join(" · ");
  if (details) {
    const small = document.createElement("small");
    small.textContent = details;
    body.append(small);
  }
  row.append(tick, body);
  return row;
}

function taskGroup(name: string, label: string, tasks: SnapshotTask[]): HTMLElement {
  const group = document.createElement("section");
  group.className = "task-group";
  group.dataset.group = name;
  const heading = document.createElement("h3");
  heading.textContent = label;
  const list = document.createElement("ul");
  list.className = "task-list";
  list.append(...tasks.map(taskRow));
  group.append(heading, list);
  return group;
}

function renderToday() {
  const hasViewKey = Boolean(pairing?.viewKey);
  todaySection.hidden = !pairing;
  todayLists.replaceChildren();
  todayUpdated.textContent = "";
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
  if (!hasViewKey || !cachedSnapshot || snapshotState === "not_entitled") return;

  const ticked = new Set(outbox.flatMap((entry) => (entry.completes ? [entry.completes] : [])));
  const groups = groupSnapshot(cachedSnapshot.snapshot, ticked);
  todayUpdated.textContent = updatedLabel(cachedSnapshot.snapshot.generatedAt);
  if (groups.focus) {
    const card = document.createElement("div");
    card.className = "focus-card";
    const label = document.createElement("small");
    label.textContent = t("focus");
    const list = document.createElement("ul");
    list.className = "task-list";
    list.append(taskRow(groups.focus));
    card.append(label, list);
    todayLists.append(card);
  }
  if (groups.overdue.length) todayLists.append(taskGroup("overdue", t("overdue"), groups.overdue));
  if (groups.today.length) todayLists.append(taskGroup("today", t("todayList"), groups.today));
  if (!groups.focus && !groups.today.length && !groups.overdue.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = t("emptyToday");
    todayLists.append(empty);
  }
  for (const day of groups.upcoming) {
    todayLists.append(taskGroup("upcoming", `${t("upcoming")} · ${shortDate(day.date)}`, day.tasks));
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

async function complete(task: SnapshotTask) {
  if (!pairing) return;
  try {
    outbox = [...outbox, await createCompleteEntry(pairing, task)];
    persist();
    render();
    await flush();
  } catch {
    showNotice(t("sealFailed"));
  }
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

  historyList.replaceChildren(...[...outbox].reverse().map((entry) => {
    const item = document.createElement("li");
    item.dataset.state = entry.state;
    const text = document.createElement("span");
    text.className = "entry-text";
    text.textContent = entry.text;
    const state = document.createElement("small");
    state.textContent = entry.completes
      ? t(entry.state === "queued" ? "stateCompleteQueued" : entry.state === "failed" ? "stateFailed" : "completed")
      : t(entry.state === "sent" ? "stateSent" : entry.state === "failed" ? "stateFailed" : "stateQueued");
    item.append(text, state);
    return item;
  }));
  historySection.hidden = outbox.length === 0;
  renderToday();
}

async function flush() {
  if (!pairing || flushing || !outbox.some((entry) => entry.state === "queued")) return;
  flushing = true;
  try {
    const outcome = await flushOutbox(origin, pairing, outbox, (url, init) => fetch(url, init));
    outbox = outcome.entries;
    persist();
    if (outcome.unpaired) {
      pairing = null;
      clearPairing(store);
      showNotice(t("expired"));
    } else if (outcome.entries.some((entry) => entry.state === "queued")) {
      showNotice(navigator.onLine ? t("retrying") : t("offline"));
    } else if (outcome.sent > 0) {
      showNotice("");
    }
  } finally {
    flushing = false;
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

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = textArea.value;
  if (!pairing || !isTextWithinLimit(text)) return;
  sendButton.disabled = true;
  void createEntry(pairing, text)
    .then((entry) => {
      outbox = [...outbox, entry];
      persist();
      textArea.value = "";
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
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void flush();
    void refreshToday();
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
  if (pairing) textArea.focus();
  void flush();
  void refreshToday();
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

void start();
