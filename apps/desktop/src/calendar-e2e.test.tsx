import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import React, { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { NativeAdapter } from "./ipc";

register("./asset-loader.mjs", import.meta.url);

process.on("unhandledRejection", () => undefined);

const FIXED_NOW = Date.parse("2026-08-15T00:00:00+08:00");
const OriginalDate = Date;
class MockDate extends OriginalDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW);
    else super(...(args as ConstructorParameters<typeof Date>));
  }
}
globalThis.Date = MockDate as unknown as DateConstructor;

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
const SECOND_TASK_LINE =
  '- [ ] #task 買麵包 ⏳ 2026-08-15 <!-- publisher-task:{"id":"22222222-2222-2222-2222-222222222222","status":"todo","rank":"bbbb"} -->';
const THIRD_TASK_LINE =
  '- [ ] #task 買雞蛋 ⏳ 2026-08-15 <!-- publisher-task:{"id":"33333333-3333-3333-3333-333333333333","status":"todo","rank":"cccc"} -->';

function setupVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sb-vault-"));
  writeFileSync(join(root, "Inbox.md"), "# 待辦收件匣\r\n\r\n" + TASK_LINE + "\r\n", "utf8");
  return root;
}

function setupMultiTaskVault(): string {
  const root = mkdtempSync(join(tmpdir(), "sb-vault-"));
  writeFileSync(join(root, "Inbox.md"), "# 待辦收件匣\r\n\r\n" + TASK_LINE + "\r\n" + SECOND_TASK_LINE + "\r\n" + THIRD_TASK_LINE + "\r\n", "utf8");
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
      () => container.querySelector<HTMLInputElement>("input[type='date']") !== null,
      3000,
      "agenda date input",
    );
    const input = container.querySelector<HTMLInputElement>("input[type='date']")!;
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
  let writes = 0;
  const adapter: NativeAdapter = {
    ...base,
    async applyMarkdownChanges(changes) {
      writes += 1;
      // First write is vault bootstrap (marker migration). Fail the next user edit.
      if (writes === 2) {
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

// Mounts the app on a vault whose user writes (after the first, bootstrap
// write) go through `write`, then drags the task from 08-15 to 08-16.
async function dragWithWrites(write: (apply: () => Promise<unknown>) => Promise<unknown>) {
  const root = setupVault();
  const base = createVaultAdapter(root);
  let writes = 0;
  const adapter: NativeAdapter = {
    ...base,
    async applyMarkdownChanges(changes) {
      writes += 1;
      if (writes === 1) return base.applyMarkdownChanges(changes);
      return write(() => base.applyMarkdownChanges(changes)) as ReturnType<NativeAdapter["applyMarkdownChanges"]>;
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  flushSync(() => {
    reactRoot.render(<App adapter={adapter} />);
  });
  await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
  openCalendar(container);
  await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
  const source = container.querySelector<HTMLElement>(".calendar-task-title");
  assert.ok(source, "task chip exists");
  flushSync(() => {
    pointerDragTo(source!, dayCell(container, "2026-08-16")!);
  });
  const chipOn = (date: string) => Boolean(dayCell(container, date)?.querySelector(".calendar-task-title"));
  const cleanup = () => {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, container, chipOn, cleanup };
}

test("end-to-end: a moved task shows on its new date before the write finishes", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const view = await dragWithWrites(async (apply) => { await gate; return apply(); });
  try {
    await waitFor(() => view.chipOn("2026-08-16"), 3000, "task on the new date while the write waits");
    assert.match(readFileSync(join(view.root, "Inbox.md"), "utf8"), /⏳ 2026-08-15/);
    release();
    await waitFor(() => readFileSync(join(view.root, "Inbox.md"), "utf8").includes("⏳ 2026-08-16"), 6000, "write lands");
    assert.ok(view.chipOn("2026-08-16"));
  } finally {
    release();
    view.cleanup();
  }
});

test("end-to-end: a second move stays on screen while the first one's write and re-read land", async () => {
  const root = setupMultiTaskVault();
  const base = createVaultAdapter(root);
  let writes = 0;
  const gates: (() => void)[] = [];
  const adapter: NativeAdapter = {
    ...base,
    async applyMarkdownChanges(changes) {
      writes += 1;
      // Only the moves are held; the AI index and other writes pass through.
      if (writes > 1 && changes.some((change) => change.relativePath === "Inbox.md")) {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      return base.applyMarkdownChanges(changes);
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  const titlesOn = (date: string) =>
    [...(dayCell(container, date)?.querySelectorAll(".calendar-task-title") ?? [])].map((chip) => chip.textContent ?? "");
  const chipNamed = (name: string) =>
    [...container.querySelectorAll<HTMLElement>(".calendar-task-title")].find((chip) => chip.textContent?.includes(name));
  try {
    flushSync(() => {
      reactRoot.render(<App adapter={adapter} />);
    });
    await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
    openCalendar(container);
    await waitFor(() => titlesOn("2026-08-15").length === 3, 3000, "three tasks on 08-15");
    flushSync(() => pointerDragTo(chipNamed("買牛奶")!, dayCell(container, "2026-08-16")!));
    await waitFor(() => gates.length === 1, 3000, "first write waiting");
    flushSync(() => pointerDragTo(chipNamed("買麵包")!, dayCell(container, "2026-08-17")!));
    await waitFor(() => titlesOn("2026-08-17").some((title) => title.includes("買麵包")), 3000, "second move on screen");
    gates.shift()!();
    // The first write lands and is re-read; the second is queued behind it.
    await waitFor(() => gates.length === 1, 6000, "second write waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(titlesOn("2026-08-17").some((title) => title.includes("買麵包")), "second move blinked back");
    assert.ok(titlesOn("2026-08-16").some((title) => title.includes("買牛奶")));
    gates.shift()!();
    await waitFor(() => readFileSync(join(root, "Inbox.md"), "utf8").includes("⏳ 2026-08-17"), 6000, "second write lands");
    assert.ok(titlesOn("2026-08-17").some((title) => title.includes("買麵包")));
    assert.ok(titlesOn("2026-08-16").some((title) => title.includes("買牛奶")));
  } finally {
    for (const release of gates) release();
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: a failed background write puts the task back where the disk has it", async () => {
  const view = await dragWithWrites(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error("disk full");
  });
  try {
    await waitFor(() => view.container.textContent?.includes("本機寫入失敗") ?? false, 6000, "write error shown");
    await waitFor(() => view.chipOn("2026-08-15") && !view.chipOn("2026-08-16"), 6000, "task back on its saved date");
    assert.match(readFileSync(join(view.root, "Inbox.md"), "utf8"), /⏳ 2026-08-15/);
  } finally {
    view.cleanup();
  }
});

async function mountOnCalendar(adapter: NativeAdapter) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const reactRoot = createRoot(container);
  flushSync(() => {
    reactRoot.render(<App adapter={adapter} />);
  });
  await waitFor(() => document.body.textContent?.includes("已載入") ?? false, 6000, "initial load");
  openCalendar(container);
  await waitFor(() => dayCell(container, "2026-08-15") !== null, 3000, "calendar grid");
  const chipOn = (date: string) => Boolean(dayCell(container, date)?.querySelector(".calendar-task-title"));
  return { container, chipOn, unmount: () => { reactRoot.unmount(); container.remove(); } };
}

for (const failingScans of [1, 3]) {
  test(`end-to-end: when the scan before a save fails ${failingScans === 1 ? "once" : "and the recovery read fails too"}, the screen goes back and says so`, async () => {
    const root = setupVault();
    const base = createVaultAdapter(root);
    let scansToFail = 0;
    const adapter: NativeAdapter = {
      ...base,
      async scanVault() {
        if (scansToFail > 0) {
          scansToFail -= 1;
          throw new Error("file vanished while reading");
        }
        return base.scanVault();
      },
    };
    const view = await mountOnCalendar(adapter);
    try {
      scansToFail = failingScans;
      flushSync(() => pointerDragTo(view.container.querySelector(".calendar-task-title")!, dayCell(view.container, "2026-08-16")!));
      await waitFor(() => view.container.textContent?.includes("本機寫入失敗") ?? false, 6000, "error shown");
      await waitFor(() => view.chipOn("2026-08-15") && !view.chipOn("2026-08-16"), 6000, "task back on its saved date");
      assert.match(readFileSync(join(root, "Inbox.md"), "utf8"), /⏳ 2026-08-15/);
    } finally {
      view.unmount();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("end-to-end: undo while a save is still writing waits instead of reverting it", async () => {
  const root = setupVault();
  const base = createVaultAdapter(root);
  let writes = 0;
  let release: (() => void) | null = null;
  const adapter: NativeAdapter = {
    ...base,
    async applyMarkdownChanges(changes) {
      writes += 1;
      if (writes > 1 && changes.some((change) => change.relativePath === "Inbox.md")) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return base.applyMarkdownChanges(changes);
    },
  };
  const view = await mountOnCalendar(adapter);
  try {
    flushSync(() => pointerDragTo(view.container.querySelector(".calendar-task-title")!, dayCell(view.container, "2026-08-16")!));
    await waitFor(() => view.chipOn("2026-08-16"), 3000, "move on screen");
    flushSync(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => view.container.textContent?.includes("正在儲存") ?? false, 3000, "undo deferred");
    await waitFor(() => release !== null, 3000, "write waiting");
    release!();
    await waitFor(() => readFileSync(join(root, "Inbox.md"), "utf8").includes("⏳ 2026-08-16"), 6000, "write lands");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(readFileSync(join(root, "Inbox.md"), "utf8"), /⏳ 2026-08-16/);
    assert.ok(view.chipOn("2026-08-16"));
  } finally {
    (release as (() => void) | null)?.();
    view.unmount();
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

test("end-to-end: shift marquee + grip drag moves every selected task to the target date", async () => {
  const root = setupMultiTaskVault();
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

    const calendarStage = container.querySelector<HTMLElement>(".calendar-stage");
    assert.ok(calendarStage, "calendar stage exists");
    stubPointerDragSupport();
    const sourceCell = dayCell(container, "2026-08-15")!;
    const targetCell = dayCell(container, "2026-08-17")!;
    // happy-dom does not lay out, so seed bounding rects for every marquee
    // candidate so the shift-drag selection has a non-empty hit area.
    const sourceRect = { left: 20, top: 80, right: 220, bottom: 220, width: 200, height: 140, x: 20, y: 80, toJSON: () => ({}) };
    const chipRects = [
      { left: 30, top: 90, right: 210, bottom: 110, width: 180, height: 20, x: 30, y: 90, toJSON: () => ({}) },
      { left: 30, top: 115, right: 210, bottom: 135, width: 180, height: 20, x: 30, y: 115, toJSON: () => ({}) },
      { left: 30, top: 140, right: 210, bottom: 160, width: 180, height: 20, x: 30, y: 140, toJSON: () => ({}) },
    ];
    sourceCell.getBoundingClientRect = () => sourceRect;
    const chips = container.querySelectorAll<HTMLElement>(".calendar-task-title");
    assert.ok(chips.length >= 2, `expected multiple chips, got ${chips.length}`);
    chips.forEach((chip, index) => {
      chip.getBoundingClientRect = () => chipRects[Math.min(index, chipRects.length - 1)]!;
    });
    // Marquee-select every chip on 2026-08-15 with a single shift drag.
    await act(async () => {
      document.dispatchEvent(new window.PointerEvent("pointerdown", {
        bubbles: true, button: 0, shiftKey: true, pointerId: 21,
        clientX: sourceRect.left + 4, clientY: sourceRect.top + 4,
      }) as unknown as Event);
      document.dispatchEvent(new window.PointerEvent("pointermove", {
        bubbles: true, button: 0, shiftKey: true, pointerId: 21,
        clientX: sourceRect.right - 4, clientY: sourceRect.bottom - 4,
      }) as unknown as Event);
    });
    await act(async () => {
      document.dispatchEvent(new window.PointerEvent("pointerup", {
        bubbles: true, button: 0, pointerId: 21,
        clientX: sourceRect.right - 4, clientY: sourceRect.bottom - 4,
      }) as unknown as Event);
    });
    const selectedCount = container.querySelectorAll<HTMLElement>(".global-shift-selected").length;
    assert.ok(selectedCount >= 2, `expected at least two shift-selected chips, got ${selectedCount}`);
    const marqueeBox = container.querySelector("[data-global-selection-marquee]");
    assert.equal(marqueeBox, null, "the blue marquee rectangle disappears after release");

    // Now drag from the grip of the first chip into the 17 Aug cell.
    const firstChip = container.querySelector<HTMLElement>(".calendar-task-title");
    assert.ok(firstChip, "first task chip exists");
    const grip = firstChip!.querySelector<HTMLElement>(".calendar-task-drag-handle");
    assert.ok(grip, "drag grip exists on the first chip");
    const doc = document as unknown as { elementFromPoint?: (x: number, y: number) => Element | null };
    const original = doc.elementFromPoint;
    doc.elementFromPoint = () => targetCell;
    try {
      // Use the article (parent of grip) so the calendar onPointerDown runs
      // even if happy-dom's SVG element listener chain drops the event before
      // it bubbles. The article's handler reaches into beginDrag the same way
      // the chip itself does.
      const firstArticle = firstChip!;
      firstArticle.getBoundingClientRect = () => ({ left: 30, top: 90, right: 210, bottom: 110, width: 180, height: 20, x: 30, y: 90, toJSON: () => ({}) });
      // act() so the drag's React state (dragging classes, floating stack)
      // actually reaches the DOM before the assertions below.
      await act(async () => {
        firstArticle.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 31, clientX: 8, clientY: 8 }) as unknown as Event);
        firstArticle.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 31, clientX: 8, clientY: 40 }) as unknown as Event);
      });
      const dragStack = container.querySelector<HTMLElement>("[data-calendar-drag-stack]");
      assert.ok(dragStack, "a floating stack of the selected tasks chases the cursor");
      assert.equal(container.querySelectorAll("[data-calendar-drag-chip]").length, 3, "every selected task flies with the pointer");
      assert.match(dragStack!.textContent ?? "", /3 項一起移動/, "the stack states how many tasks travel together");
      await act(async () => {
        firstArticle.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 31, clientX: 8, clientY: 40 }) as unknown as Event);
      });
    } finally {
      doc.elementFromPoint = original;
    }

    await waitFor(
      () => {
        const content = readFileSync(join(root, "Inbox.md"), "utf8");
        return !content.includes("⏳ 2026-08-15");
      },
      6000,
      "every selected task moved off 2026-08-15",
    );
    const finalContent = readFileSync(join(root, "Inbox.md"), "utf8");
    const movedCount = (finalContent.match(/⏳ 2026-08-17/g) ?? []).length;
    assert.ok(movedCount >= 2, `expected at least two tasks on 2026-08-17, got ${movedCount}`);
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: plain box-drag selects month chips and Delete removes them all in one shot", async () => {
  const root = setupMultiTaskVault();
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

    const calendarStage = container.querySelector<HTMLElement>(".calendar-stage");
    assert.ok(calendarStage, "calendar stage exists");
    assert.equal(calendarStage!.hasAttribute("data-plain-marquee-scope"), true, "the calendar stage opts into plain-drag box selection");
    stubPointerDragSupport();
    const sourceCell = dayCell(container, "2026-08-15")!;
    const sourceRect = { left: 20, top: 80, right: 220, bottom: 220, width: 200, height: 140, x: 20, y: 80, toJSON: () => ({}) };
    const chipRects = [
      { left: 30, top: 90, right: 210, bottom: 110, width: 180, height: 20, x: 30, y: 90, toJSON: () => ({}) },
      { left: 30, top: 115, right: 210, bottom: 135, width: 180, height: 20, x: 30, y: 115, toJSON: () => ({}) },
      { left: 30, top: 140, right: 210, bottom: 160, width: 180, height: 20, x: 30, y: 140, toJSON: () => ({}) },
    ];
    sourceCell.getBoundingClientRect = () => sourceRect as DOMRect;
    const chips = container.querySelectorAll<HTMLElement>(".calendar-task-title");
    assert.ok(chips.length >= 2, `expected multiple chips, got ${chips.length}`);
    chips.forEach((chip, index) => {
      chip.getBoundingClientRect = () => chipRects[Math.min(index, chipRects.length - 1)]! as DOMRect;
    });
    // Notion-style: a box drag on the month grid — no Shift — selects every
    // chip it crosses.
    await act(async () => {
      sourceCell.dispatchEvent(new window.PointerEvent("pointerdown", {
        bubbles: true, button: 0, pointerId: 51,
        clientX: sourceRect.left + 4, clientY: sourceRect.top + 4,
      }) as unknown as Event);
      document.dispatchEvent(new window.PointerEvent("pointermove", {
        bubbles: true, button: 0, pointerId: 51,
        clientX: sourceRect.right - 4, clientY: sourceRect.bottom - 4,
      }) as unknown as Event);
      document.dispatchEvent(new window.PointerEvent("pointerup", {
        bubbles: true, button: 0, pointerId: 51,
        clientX: sourceRect.right - 4, clientY: sourceRect.bottom - 4,
      }) as unknown as Event);
    });
    const selectedCount = container.querySelectorAll<HTMLElement>(".global-shift-selected").length;
    assert.ok(selectedCount >= 2, `expected at least two box-selected chips, got ${selectedCount}`);

    // Press Delete with the keyboard focus on <body>, outside the React
    // tree — the window-level handler is the only thing that sees it.
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", {
        bubbles: true, key: "Delete",
      }) as unknown as Event);
    });

    await waitFor(
      () => {
        const content = readFileSync(join(root, "Inbox.md"), "utf8");
        const remainingMarkers = (content.match(/(?:publisher-task|second-brain-task):/g) ?? []).length;
        return remainingMarkers === 0;
      },
      6000,
      "every selected task is removed from the Markdown file",
    );
    const finalContent = readFileSync(join(root, "Inbox.md"), "utf8");
    assert.doesNotMatch(finalContent, /⏳ 2026-08-15/);
  } finally {
    reactRoot.unmount();
    container.remove();
    rmSync(root, { recursive: true, force: true });
  }
});