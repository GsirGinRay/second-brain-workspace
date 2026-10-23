import { useCallback, useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { ActionConfirmDialog } from "./danger-confirm";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  buildTodaySnapshot,
  qrDataUrl,
  type InboxRelayApi,
  type InboxRelayEntitlement,
  type InboxRelayItem,
  type InboxRelayPairing,
  type InboxRelayStatus,
} from "./inbox-relay";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const ITEMS_EVENT = "inbox-relay-items";
const STATUS_EVENT = "inbox-relay-status";
const POLL_MS = 60_000;
const STATUS_POLL_MS = 5_000;
/** Pairing or the paid list changed in settings; the snapshot hook re-checks. */
const ENTITLEMENT_EVENT = "second-brain:inbox-entitlement";
const SNAPSHOT_DEBOUNCE_MS = 3_000;
/** Republish even without changes so the phone can tell the computer is on. */
const SNAPSHOT_REFRESH_MS = 30 * 60_000;
const ENTITLEMENT_POLL_MS = 30 * 60_000;

function notifyEntitlementChanged() {
  window.dispatchEvent(new Event(ENTITLEMENT_EVENT));
}

function useNativeEvent(name: string, handler: () => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(name, () => latest.current()))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [name]);
}

/**
 * Writes phone items into the vault, then acknowledges them. An item is only
 * acknowledged after `write` resolves true, so a failed write is retried on
 * the next event or poll and never lost.
 */
export function useInboxRelay({ api, ready, write, onReceived }: {
  api?: InboxRelayApi;
  ready: boolean;
  write: (items: InboxRelayItem[]) => Promise<boolean>;
  onReceived?: (items: InboxRelayItem[]) => void;
}) {
  const latest = useRef({ write, onReceived });
  latest.current = { write, onReceived };
  const running = useRef(false);
  const again = useRef(false);

  const drain = useCallback(async () => {
    if (!api || !ready) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const items = await api.pending();
        if (items.length === 0) break;
        if (!(await latest.current.write(items))) break;
        await api.ack(items.map((item) => item.id));
        latest.current.onReceived?.(items);
      } while (again.current);
    } catch {
      // Items stay pending on the native side; the next event or poll retries.
    } finally {
      running.current = false;
    }
  }, [api, ready]);

  useNativeEvent(ITEMS_EVENT, () => void drain());
  useEffect(() => {
    void drain();
    if (!api || !ready) return;
    const timer = window.setInterval(() => void drain(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [api, ready, drain]);
}

/**
 * Publishes the phone "today" list after tasks change, for paid members only.
 * The relay refuses snapshots from other inboxes, so the hook stops when it
 * hears `not_entitled` and checks again when settings change.
 */
export function useTodaySnapshot({ api, ready, tasks, todayKey }: {
  api?: InboxRelayApi;
  ready: boolean;
  tasks: readonly BrainTaskSnapshot[];
  todayKey: () => string;
}) {
  const [entitled, setEntitled] = useState(false);
  const [today, setToday] = useState(todayKey);
  const [tick, setTick] = useState(0);
  const sent = useRef({ key: "", at: 0 });
  const latestTodayKey = useRef(todayKey);
  latestTodayKey.current = todayKey;

  const refresh = useCallback(() => {
    if (!api) return;
    void api.status()
      .then((status) => (status.paired ? api.entitlement() : null))
      .then((result) => {
        setEntitled(Boolean(result?.entitled));
        sent.current = { key: "", at: 0 };
      })
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    refresh();
    const poll = window.setInterval(refresh, ENTITLEMENT_POLL_MS);
    const clock = window.setInterval(() => {
      setToday(latestTodayKey.current());
      setTick((value) => value + 1);
    }, 60_000);
    window.addEventListener(ENTITLEMENT_EVENT, refresh);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
      window.removeEventListener(ENTITLEMENT_EVENT, refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!api || !ready || !entitled) return;
    const timer = window.setTimeout(() => {
      const snapshot = buildTodaySnapshot(tasks, today);
      const key = JSON.stringify({ ...snapshot, generatedAt: "" });
      if (key === sent.current.key && Date.now() - sent.current.at < SNAPSHOT_REFRESH_MS) return;
      void api.publishSnapshot(snapshot)
        .then((result) => {
          if (result.entitled) sent.current = { key, at: Date.now() };
          else if (result.error === "not_entitled") setEntitled(false);
        })
        .catch(() => undefined);
    }, SNAPSHOT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [api, ready, entitled, tasks, today, tick]);
}

type Confirm = "rotate" | "unpair" | null;

export function InboxRelaySettingsCard({ api, t, onError }: {
  api: InboxRelayApi;
  t: Translate;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<InboxRelayStatus | null>(null);
  const [pairing, setPairing] = useState<InboxRelayPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const refresh = useCallback(() => {
    void api.status().then(setStatus).catch(() => undefined);
  }, [api]);
  useNativeEvent(STATUS_EVENT, refresh);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<InboxRelayPairing | null | void>) => {
    setBusy(true);
    try {
      const result = await action();
      setPairing(result ?? null);
    } catch {
      onError(t("inboxRelay.error"));
    } finally {
      setBusy(false);
      setConfirm(null);
      refresh();
      notifyEntitlementChanged();
    }
  };

  const connectionLabel = status?.connection
    ? t(`inboxRelay.connection.${status.connection}`)
    : "";

  return (
    <section className="settings-card inbox-relay-settings">
      <h2><Smartphone aria-hidden="true" />{t("inboxRelay.title")}</h2>
      <p>{t("inboxRelay.hint")}</p>
      {status?.needsRepair && <p role="alert">{t("inboxRelay.needsRepair")}</p>}
      {status?.paired ? (
        <>
          <div className="diagnostic-list">
            <span>{t("inboxRelay.status")}<strong data-connection={status.connection ?? ""}>{connectionLabel}</strong></span>
            {status.pending > 0 && <span>{t("inboxRelay.pending")}<strong>{status.pending}</strong></span>}
            {status.discarded > 0 && <span>{t("inboxRelay.discarded")}<strong>{status.discarded}</strong></span>}
          </div>
          {pairing ? (
            <PairingCode pairing={pairing} t={t} onHide={() => setPairing(null)} />
          ) : (
            <div className="input-action">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(() => api.pairing())}>
                {t("inboxRelay.showQr")}
              </button>
            </div>
          )}
          <TodayListSection api={api} t={t} />
          <div className="input-action">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirm("rotate")}>
              {t("inboxRelay.rotate")}
            </button>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirm("unpair")}>
              {t("inboxRelay.unpair")}
            </button>
          </div>
        </>
      ) : (
        <>
          <small>{t("inboxRelay.privacy")}</small>
          <div className="input-action">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !status}
              onClick={() => void run(async () => {
                if (status?.needsRepair) await api.unpair();
                return api.pair();
              })}
            >
              {busy ? t("inboxRelay.pairing") : t("inboxRelay.pair")}
            </button>
          </div>
        </>
      )}
      <ActionConfirmDialog
        open={confirm !== null}
        title={confirm === "rotate" ? t("inboxRelay.rotate") : t("inboxRelay.unpair")}
        message={confirm === "rotate" ? t("inboxRelay.rotate.message") : t("inboxRelay.unpair.message")}
        confirmLabel={confirm === "rotate" ? t("inboxRelay.rotate.confirm") : t("inboxRelay.unpair.confirm")}
        cancelLabel={t("app.cancel")}
        tone={confirm === "rotate" ? "primary" : "danger"}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run(() => (confirm === "rotate" ? api.rotate() : api.unpair()))}
      />
    </section>
  );
}

const ENTITLEMENT_ERRORS = new Set([
  "not_member",
  "wrong_code",
  "code_expired",
  "no_code",
  "too_many_attempts",
  "rate_limited",
  "directory_unavailable",
  "mail_unavailable",
  "not_entitled",
]);

function entitlementError(t: Translate, code: string | null): string {
  return t(`inboxRelay.today.error.${code && ENTITLEMENT_ERRORS.has(code) ? code : "unavailable"}`);
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name) as { value?: unknown } | null;
  return typeof field?.value === "string" ? field.value : "";
}

/** Unlocks the phone "today" list for paid members with an emailed code. */
function TodayListSection({ api, t }: { api: InboxRelayApi; t: Translate }) {
  const [entitlement, setEntitlement] = useState<InboxRelayEntitlement | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.entitlement().then(setEntitlement).catch(() => setEntitlement(null));
  }, [api]);

  const act = async (request: () => Promise<InboxRelayEntitlement>, onOk: (result: InboxRelayEntitlement) => void) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await request();
      if (result.error) setMessage(entitlementError(t, result.error));
      else onOk(result);
    } catch {
      setMessage(entitlementError(t, null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inbox-relay-today">
      <h3>{t("inboxRelay.today.title")}</h3>
      {entitlement?.entitled ? (
        <>
          <p>{t("inboxRelay.today.active", { email: entitlement.email ?? "" })}</p>
          <small>{t("inboxRelay.today.rescan")}</small>
          <div className="input-action">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(() => api.cancelEntitlement(), () => {
                setEntitlement({ entitled: false, email: null, error: null });
                notifyEntitlementChanged();
              })}
            >
              {t("inboxRelay.today.cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t("inboxRelay.today.hint")}</p>
          <form
            className="input-action"
            onSubmit={(event) => {
              event.preventDefault();
              const email = fieldValue(event.currentTarget, "email").trim();
              if (!email.includes("@")) return;
              void act(() => api.requestCode(email), () => setCodeSent(true));
            }}
          >
            <input
              name="email"
              type="email"
              required
              aria-label={t("inboxRelay.today.email")}
              placeholder={t("inboxRelay.today.email")}
              autoComplete="email"
            />
            <button type="submit" className="secondary-button" disabled={busy}>
              {codeSent ? t("inboxRelay.today.resend") : t("inboxRelay.today.sendCode")}
            </button>
          </form>
          {codeSent && (
            <form
              className="input-action"
              onSubmit={(event) => {
                event.preventDefault();
                const code = fieldValue(event.currentTarget, "code").replace(/\D/g, "");
                if (code.length !== 6) {
                  setMessage(entitlementError(t, "wrong_code"));
                  return;
                }
                void act(() => api.verifyCode(code), (result) => {
                  setEntitlement(result);
                  setCodeSent(false);
                  notifyEntitlementChanged();
                });
              }}
            >
              <input
                name="code"
                inputMode="numeric"
                maxLength={6}
                aria-label={t("inboxRelay.today.code")}
                placeholder={t("inboxRelay.today.code")}
                autoComplete="one-time-code"
              />
              <button type="submit" className="secondary-button" disabled={busy}>
                {t("inboxRelay.today.verify")}
              </button>
            </form>
          )}
          {codeSent && !message && <small>{t("inboxRelay.today.codeSent")}</small>}
        </>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

function PairingCode({ pairing, t, onHide }: { pairing: InboxRelayPairing; t: Translate; onHide: () => void }) {
  return (
    <div className="pair-code inbox-relay-qr">
      <img src={qrDataUrl(pairing.qrSvg)} alt={t("inboxRelay.qrAlt")} width={240} height={240} />
      <small>{t("inboxRelay.scan")}</small>
      <button type="button" className="secondary-button" onClick={onHide}>{t("inboxRelay.hideQr")}</button>
    </div>
  );
}
