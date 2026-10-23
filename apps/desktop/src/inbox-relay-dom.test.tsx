import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { translate } from "./ui-preferences";
import type { BrainTaskSnapshot, InboxSnapshot } from "@second-brain/brain-core";
import type { InboxRelayApi, InboxRelayEntitlement, InboxRelayItem, InboxRelayStatus } from "./inbox-relay";

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

const { InboxRelaySettingsCard, useInboxRelay, useTodaySnapshot } = await import("./inbox-relay-ui");

const t = (key: string, values?: Record<string, string | number>) => translate("zh-TW", key, values);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const ITEM: InboxRelayItem = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "明天下午三點 繳電話費",
  createdAt: "2026-10-23T09:30:00.000Z",
  source: "pwa",
};
const PAIRING = {
  url: "https://inbox.aizbrain.com/#v=1&i=AAECAwQFBgcICQoLDA0ODw&t=token&k=BMK9",
  qrSvg: "<?xml version=\"1.0\"?><svg/>",
};

function fakeApi(initial: Partial<InboxRelayStatus> = {}) {
  const calls: string[] = [];
  let status: InboxRelayStatus = {
    paired: false,
    needsRepair: false,
    connection: null,
    origin: "https://inbox.aizbrain.com",
    pending: 0,
    discarded: 0,
    ...initial,
  };
  let pending: InboxRelayItem[] = [];
  let entitlement: InboxRelayEntitlement = { entitled: false, email: null, error: null };
  const snapshots: InboxSnapshot[] = [];
  const api: InboxRelayApi = {
    async status() { return status; },
    async pair() {
      calls.push("pair");
      status = { ...status, paired: true, needsRepair: false, connection: "connecting" };
      return PAIRING;
    },
    async pairing() { calls.push("pairing"); return PAIRING; },
    async rotate() { calls.push("rotate"); return PAIRING; },
    async unpair() { calls.push("unpair"); status = { ...status, paired: false, connection: null }; },
    async pending() { return pending; },
    async ack(ids) {
      calls.push(`ack:${ids.join(",")}`);
      pending = pending.filter((item) => !ids.includes(item.id));
    },
    async entitlement() { return entitlement; },
    async requestCode(email) {
      calls.push(`code:${email}`);
      return email === "member@example.com"
        ? { entitled: false, email: null, error: null }
        : { entitled: false, email: null, error: "not_member" };
    },
    async verifyCode(code) {
      calls.push(`verify:${code}`);
      if (code !== "123456") return { entitled: false, email: null, error: "wrong_code" };
      entitlement = { entitled: true, email: "member@example.com", error: null };
      return entitlement;
    },
    async cancelEntitlement() {
      calls.push("cancel");
      entitlement = { entitled: false, email: null, error: null };
      return entitlement;
    },
    async publishSnapshot(snapshot) {
      snapshots.push(snapshot);
      return entitlement.entitled
        ? { entitled: true, email: null, error: null }
        : { entitled: false, email: null, error: "not_entitled" };
    },
  };
  return {
    api,
    calls,
    snapshots,
    setPending: (items: InboxRelayItem[]) => { pending = items; },
    setEntitled: (value: boolean) => { entitlement = { entitled: value, email: value ? "member@example.com" : null, error: null }; },
  };
}

function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(element));
  return {
    container,
    render: (next: React.ReactElement) => flushSync(() => root.render(next)),
    cleanup: () => { root.unmount(); container.remove(); },
  };
}

function Harness(props: Parameters<typeof useInboxRelay>[0]) {
  useInboxRelay(props);
  return null;
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === text) as HTMLButtonElement | undefined;
}

test("phone items are acknowledged only after the write succeeds", async () => {
  const { api, calls, setPending } = fakeApi({ paired: true });
  setPending([ITEM]);
  const written: InboxRelayItem[][] = [];
  let succeed = false;
  let received = 0;
  const props = {
    api,
    ready: true,
    write: async (items: InboxRelayItem[]) => { written.push(items); return succeed; },
    onReceived: (items: InboxRelayItem[]) => { received += items.length; },
  };
  const view = mount(<Harness {...props} />);
  await settle();
  assert.equal(written.length, 1);
  assert.deepEqual(calls, [], "a failed write is not acknowledged");

  succeed = true;
  view.render(<Harness {...props} ready={false} />);
  view.render(<Harness {...props} ready />);
  await settle();
  assert.deepEqual(calls, [`ack:${ITEM.id}`]);
  assert.equal(received, 1);
  view.cleanup();
});

test("nothing is written before a vault is open", async () => {
  const { api, setPending } = fakeApi({ paired: true });
  setPending([ITEM]);
  let writes = 0;
  const view = mount(<Harness api={api} ready={false} write={async () => { writes += 1; return true; }} />);
  await settle();
  assert.equal(writes, 0);
  view.cleanup();
});

test("the settings card pairs, shows the QR code and turns off with confirmation", async () => {
  const { api, calls } = fakeApi();
  const errors: string[] = [];
  const view = mount(<InboxRelaySettingsCard api={api} t={t} onError={(message) => errors.push(message)} />);
  await settle();
  view.render(<InboxRelaySettingsCard api={api} t={t} onError={(message) => errors.push(message)} />);
  assert.ok(view.container.textContent?.includes(t("inboxRelay.privacy")));

  buttonByText(view.container, t("inboxRelay.pair"))?.click();
  await settle();
  const qr = view.container.querySelector("img");
  assert.ok(qr?.getAttribute("src")?.startsWith("data:image/svg+xml"));
  assert.deepEqual(calls, ["pair"]);
  assert.ok(view.container.textContent?.includes(t("inboxRelay.connection.connecting")));

  buttonByText(view.container, t("inboxRelay.unpair"))?.click();
  await settle();
  const dialogConfirm = [...document.querySelectorAll("[role='dialog'] button, [role='alertdialog'] button")]
    .find((button) => button.textContent === t("inboxRelay.unpair.confirm")) as HTMLButtonElement | undefined;
  assert.ok(dialogConfirm, "confirmation dialog");
  dialogConfirm.click();
  await settle();
  assert.deepEqual(calls, ["pair", "unpair"]);
  assert.ok(buttonByText(view.container, t("inboxRelay.pair")));
  assert.deepEqual(errors, []);
  view.cleanup();
});

test("a failed request shows an error instead of a QR code", async () => {
  const { api } = fakeApi();
  api.pair = async () => { throw new Error("offline"); };
  const errors: string[] = [];
  const view = mount(<InboxRelaySettingsCard api={api} t={t} onError={(message) => errors.push(message)} />);
  await settle();
  buttonByText(view.container, t("inboxRelay.pair"))?.click();
  await settle();
  assert.deepEqual(errors, [t("inboxRelay.error")]);
  assert.equal(view.container.querySelector("img"), null);
  view.cleanup();
});

function SnapshotHarness(props: Parameters<typeof useTodaySnapshot>[0]) {
  useTodaySnapshot(props);
  return null;
}

const waitFor = async (check: () => boolean, ms = 6_000) => {
  const started = Date.now();
  while (!check() && Date.now() - started < ms) await new Promise((resolve) => setTimeout(resolve, 50));
  return check();
};

const TASK: BrainTaskSnapshot = {
  schemaVersion: 5,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "繳電話費",
  status: "todo",
  taskDate: "2026-10-23",
  priority: "highest",
  projectId: null,
  projectName: null,
  rank: "a",
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  startTime: "15:00",
  durationMinutes: 30,
};

test("the today snapshot is published only for entitled inboxes", async () => {
  const unpaid = fakeApi({ paired: true });
  const quiet = mount(<SnapshotHarness api={unpaid.api} ready tasks={[TASK]} todayKey={() => "2026-10-23"} />);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  assert.equal(unpaid.snapshots.length, 0);
  quiet.cleanup();

  const paid = fakeApi({ paired: true });
  paid.setEntitled(true);
  const view = mount(<SnapshotHarness api={paid.api} ready tasks={[TASK]} todayKey={() => "2026-10-23"} />);
  assert.ok(await waitFor(() => paid.snapshots.length === 1), "published after the debounce");
  assert.equal(paid.snapshots[0]?.today, "2026-10-23");
  assert.deepEqual(paid.snapshots[0]?.tasks.map((task) => task.title), ["繳電話費"]);
  view.cleanup();
});

test("members unlock the today list with an emailed code", async () => {
  const { api, calls } = fakeApi({ paired: true, connection: "connected" });
  const view = mount(<InboxRelaySettingsCard api={api} t={t} onError={() => undefined} />);
  await settle();
  view.render(<InboxRelaySettingsCard api={api} t={t} onError={() => undefined} />);
  await settle();
  const container = view.container;
  const emailInput = container.querySelector<HTMLInputElement>("input[type='email']");
  assert.ok(emailInput, "email field");

  const submit = (input: HTMLInputElement, value: string) => {
    input.value = value;
    flushSync(() => input.form!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  };

  submit(emailInput, "someone@example.com");
  await settle();
  assert.ok(container.textContent?.includes(t("inboxRelay.today.error.not_member")));

  submit(emailInput, "member@example.com");
  await settle();
  const codeInput = container.querySelector<HTMLInputElement>("input[name='code']");
  assert.ok(codeInput, "code field after sending");
  submit(codeInput, "123456");
  await settle();
  assert.ok(container.textContent?.includes(t("inboxRelay.today.active", { email: "member@example.com" })));
  assert.deepEqual(calls, ["code:someone@example.com", "code:member@example.com", "verify:123456"]);
  view.cleanup();
});
