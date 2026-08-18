import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { NativeAdapter } from "./ipc";

register("./asset-loader.mjs", import.meta.url);

process.on("unhandledRejection", () => undefined);

const { App } = await import("./App");

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globals.localStorage = window.localStorage;
globals.HTMLElement = window.HTMLElement;
globals.Node = window.Node;
globals.Event = window.Event;
globals.KeyboardEvent = window.KeyboardEvent;
globals.MouseEvent = window.MouseEvent;
globals.PointerEvent = window.PointerEvent;
globals.DragEvent = window.DragEvent;
globals.CustomEvent = window.CustomEvent;
globals.IntersectionObserver = window.IntersectionObserver;
globals.getComputedStyle = window.getComputedStyle.bind(window);

function clickEvent(element: Element, type: string) {
  element.dispatchEvent(new window.MouseEvent(type, { bubbles: true }) as unknown as Event);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function createVaultAdapter(root: string): NativeAdapter {
  const mdFiles = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.toLowerCase().endsWith(".md")) out.push(relative(root, full).replace(/\\/g, "/"));
      }
    };
    walk(root);
    return out.sort();
  };
  return {
    async getDiagnostics() {
      return {
        selectedVault: root,
        watcherStatus: "watching",
        keyFingerprint: "sha256:" + "0".repeat(64),
        keyBackend: "memory",
        recoveryStatus: "ok",
        syncEnabled: false,
        publisherOrigin: null,
        closeBehavior: "exit",
        autostartEnabled: false,
      };
    },
    async scanVault() {
      return mdFiles().map((relativePath) => {
        const bytes = readFileSync(join(root, relativePath));
        return { relativePath, sha256: sha256(bytes), bytes: bytes.length, hasBom: bytes[0] === 0xef, newline: "cr_lf" as const };
      });
    },
    async readMarkdownFiles(relativePaths) {
      return relativePaths.map((relativePath) => {
        const bytes = readFileSync(join(root, relativePath));
        return { relativePath, sha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
      });
    },
    async applyMarkdownChanges(changes) {
      for (const change of changes) {
        const target = join(root, change.relativePath);
        const exists = statSync(target, { throwIfNoEntry: false });
        const current = exists?.isFile() ? readFileSync(target) : null;
        if (change.operation === "delete") {
          if (!current) throw new Error("HASH_PRECONDITION");
          if (sha256(current) !== change.expectedSha256.toLowerCase()) throw new Error("HASH_PRECONDITION");
          rmSync(target, { force: true });
        } else {
          const replacement = Buffer.from(change.replacementBase64, "base64");
          if (current) {
            if (sha256(current) !== change.expectedSha256.toLowerCase()) throw new Error("HASH_PRECONDITION");
          } else if (change.expectedSha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
            throw new Error("HASH_PRECONDITION");
          }
          writeFileSync(target, replacement);
        }
      }
      return { journalPath: "journal.journal.json", backupPath: "backup.zip" };
    },
    async confirmServerCommit() { /* no-op */ },
    async savePendingCommit() { /* no-op */ },
    async loadPendingCommit() { return null; },
    async clearPendingCommit() { /* no-op */ },
    async pendingJournals() { return []; },
    async getDeviceIdentity() {
      return { deviceId: "device-1", publicKeyBase64Url: "A".repeat(43), fingerprint: "sha256:" + "0".repeat(64), backend: "memory" };
    },
    async completeDevicePairing() { /* no-op */ },
    async signCanonicalRequest() { return { signatureBase64Url: "S".repeat(86) }; },
    async publisherHttpRequest() {
      return { status: 404, headers: {}, body: "{}" };
    },
    async openPublisherPairing() { /* no-op */ },
    async pickVaultFolder() { return null; },
    async selectVault() { return { vaultId: "vault-1", root }; },
    async setAutostart() { /* no-op */ },
    async setCloseBehavior() { /* no-op */ },
    async loadRoutineTemplate() { return null; },
    async saveRoutineTemplate() { /* no-op */ },
  };
}

const TASK_LINE =
  '- [ ] #task 買牛奶 ⏳ 2026-08-15 <!-- publisher-task:{"id":"11111111-1111-1111-1111-111111111111","status":"todo","rank":"aaaa"} -->';

function setupVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sb-vault-"));
  writeFileSync(join(root, "Inbox.md"), "# 待辦收件匣\r\n\r\n" + TASK_LINE + "\r\n", "utf8");
  return root;
}

function waitFor(condition: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function dayCell(container: HTMLElement, date: string): HTMLElement | null {
  return container.querySelector(`[data-calendar-date="${date}"]`);
}

function stubPointerDragSupport() {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== "function") {
    Object.defineProperty(proto, "setPointerCapture", { value: () => undefined, configurable: true, writable: true });
  }
}

function pointerDragTo(source: Element, target: HTMLElement) {
  stubPointerDragSupport();
  const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
  const original = doc.elementFromPoint;
  doc.elementFromPoint = () => target;
  try {
    source.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
    source.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 4, clientY: 4 }) as unknown as Event);
  } finally {
    doc.elementFromPoint = original;
  }
}

function openCalendar(container: HTMLElement) {
  const calendarNav = [...container.querySelectorAll("nav button")].find(
    (button) => (button.getAttribute("aria-label") ?? "").includes("日曆"),
  );
  assert.ok(calendarNav, "calendar nav button exists");
  flushSync(() => {
    clickEvent(calendarNav!, "click");
  });
}

test("end-to-end: drag task to another date persists to Markdown", async () => {
  const root = setupVault();
  const adapter = createVaultAdapter(root);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  try {
    flushSync(() => {
      reactRoot.render(<App adapter={adapter} />);
    });
    await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
    openCalendar(container);
    await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
    const source = container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(source, "task chip exists");
    const target = dayCell(container, "2026-08-16");
    assert.ok(target, "target day cell 2026-08-16 exists");
    flushSync(() => {
      pointerDragTo(source!, target!);
    });
    await waitFor(
      () => {
        const content = readFileSync(join(root, "Inbox.md"), "utf8");
        return content.includes("2026-08-16") && !content.includes("⏳ 2026-08-15");
      },
      6000,
      "markdown date change on disk",
    );
    const finalContent = readFileSync(join(root, "Inbox.md"), "utf8");
    assert.match(finalContent, /⏳ 2026-08-16/);
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: agenda date input is bound to the task's planned date", async () => {
  const root = setupVault();
  const adapter = createVaultAdapter(root);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  try {
    flushSync(() => {
      reactRoot.render(<App adapter={adapter} />);
    });
    await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
    openCalendar(container);
    await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
    const cell = dayCell(container, "2026-08-15");
    assert.ok(cell, "day cell exists");
    flushSync(() => {
      clickEvent(cell!, "click");
    });
    await waitFor(
      () => container.querySelector<HTMLInputElement>("input[placeholder='YYYY-MM-DD']") !== null,
      3000,
      "agenda date input",
    );
    const input = container.querySelector<HTMLInputElement>("input[placeholder='YYYY-MM-DD']")!;
    assert.equal(input.value, "2026-08-15");
    // happy-dom does not deliver native input events to React's synthetic
    // onChange, so the input save round-trip is covered by the drag tests
    // (identical onSave pipeline) plus the brain-core patch tests.
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: a stale-hash write is retried after re-scan so the date edit lands", async () => {
  const root = setupVault();
  const base = createVaultAdapter(root);
  let failNext = true;
  const adapter: NativeAdapter = {
    ...base,
    async applyMarkdownChanges(changes) {
      if (failNext) {
        // Simulate a concurrent writer moving the file between scan and write.
        failNext = false;
        throw new Error("file changed before write");
      }
      return base.applyMarkdownChanges(changes);
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  try {
    flushSync(() => {
      reactRoot.render(<App adapter={adapter} />);
    });
    await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
    openCalendar(container);
    await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
    const source = container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(source, "task chip exists");
    const target = dayCell(container, "2026-08-16");
    assert.ok(target, "target day cell 2026-08-16 exists");
    flushSync(() => {
      pointerDragTo(source!, target!);
    });
    await waitFor(
      () => {
        const content = readFileSync(join(root, "Inbox.md"), "utf8");
        return content.includes("⏳ 2026-08-16");
      },
      6000,
      "retried markdown date change on disk",
    );
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: drag task to idea drawer removes the date in Markdown", async () => {
  const root = setupVault();
  const adapter = createVaultAdapter(root);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  try {
    flushSync(() => {
      reactRoot.render(<App adapter={adapter} />);
    });
    await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
    openCalendar(container);
    await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
    const source = container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(source, "task chip exists");
    const drawer = container.querySelector<HTMLElement>("[data-idea-drawer]");
    assert.ok(drawer, "idea drawer exists");
    flushSync(() => {
      pointerDragTo(source!, drawer!);
    });
    await waitFor(
      () => {
        const content = readFileSync(join(root, "Inbox.md"), "utf8");
        return !content.includes("2026-08-15");
      },
      6000,
      "markdown date removal on disk",
    );
    const finalContent = readFileSync(join(root, "Inbox.md"), "utf8");
    assert.doesNotMatch(finalContent, /⏳/);
    assert.doesNotMatch(finalContent, /📅/);
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});