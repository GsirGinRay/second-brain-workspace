import { useCallback, useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { ActionConfirmDialog } from "./danger-confirm";
import { qrDataUrl, type InboxRelayApi, type InboxRelayItem, type InboxRelayPairing, type InboxRelayStatus } from "./inbox-relay";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const ITEMS_EVENT = "inbox-relay-items";
const STATUS_EVENT = "inbox-relay-status";
const POLL_MS = 60_000;
const STATUS_POLL_MS = 5_000;

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
  onReceived?: (count: number) => void;
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
        latest.current.onReceived?.(items.length);
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

function PairingCode({ pairing, t, onHide }: { pairing: InboxRelayPairing; t: Translate; onHide: () => void }) {
  return (
    <div className="pair-code inbox-relay-qr">
      <img src={qrDataUrl(pairing.qrSvg)} alt={t("inboxRelay.qrAlt")} width={240} height={240} />
      <small>{t("inboxRelay.scan")}</small>
      <button type="button" className="secondary-button" onClick={onHide}>{t("inboxRelay.hideQr")}</button>
    </div>
  );
}
