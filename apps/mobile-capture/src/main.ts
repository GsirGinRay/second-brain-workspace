import { INBOX_TEXT_BYTES_LIMIT } from "@second-brain/brain-core";
import {
  clearPairing,
  createEntry,
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
const t = (key: MessageKey) => MESSAGES[language][key];
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

let pairing: Pairing | null = loadPairing(store);
let outbox: OutboxEntry[] = loadOutbox(store);
let flushing = false;

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
  return `${origin}/#v=1&i=${value.inboxId}&t=${value.token}&k=${value.publicKey}`;
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
    state.textContent = t(entry.state === "sent" ? "stateSent" : entry.state === "failed" ? "stateFailed" : "stateQueued");
    item.append(text, state);
    return item;
  }));
  historySection.hidden = outbox.length === 0;
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
    return flush();
  });
});

copyLink.addEventListener("click", () => {
  if (!pairing) return;
  void navigator.clipboard.writeText(pairingLink(pairing))
    .then(() => showNotice(t("copied")))
    .catch(() => showNotice(t("copyFailed")));
});

window.addEventListener("online", () => void flush());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void flush();
});
window.setInterval(() => void flush(), RETRY_MS);

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
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
}

void start();
