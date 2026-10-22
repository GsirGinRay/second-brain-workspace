import { PartyPopper, X } from "lucide-react";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export const LAST_SEEN_VERSION_KEY = "second-brain.lastSeenVersion";
const ONBOARDING_COMPLETED_KEY = "second-brain.onboardingCompleted";

// Highlights shown once after updating to a version. Keep each list short.
export const RELEASE_HIGHLIGHT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "0.6.2": ["whatsNew.0.6.2.naturalDate", "whatsNew.0.6.2.quickCapture", "whatsNew.0.6.2.safeSave"],
  "0.7.0": ["whatsNew.0.7.0.repeat", "whatsNew.0.7.0.reminders", "whatsNew.0.7.0.today"],
  "0.7.1": ["whatsNew.0.7.1.estimate", "whatsNew.0.7.0.repeat"],
  "0.7.2": ["whatsNew.0.7.2.repeatField", "whatsNew.0.7.2.close", "whatsNew.0.7.1.estimate"],
  "0.7.3": ["whatsNew.0.7.3.customRepeat", "whatsNew.0.7.2.repeatField", "whatsNew.0.7.2.close"],
  "0.7.4": ["whatsNew.0.7.4.review", "whatsNew.0.7.3.customRepeat"],
  "0.7.5": ["whatsNew.0.7.5.speed", "whatsNew.0.7.5.rename"],
  "0.7.6": ["whatsNew.0.7.6.speed", "whatsNew.0.7.6.delete"],
  "0.7.7": ["whatsNew.0.7.7.bom", "whatsNew.0.7.6.speed"],
  "0.7.8": ["whatsNew.0.7.8.instant", "whatsNew.0.7.8.parse"],
};

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Records the running version and reports whether this launch is the first one
 * after an update. Installs from before this key existed are recognised by a
 * finished onboarding, so the update that introduces the notice shows it too.
 */
export function consumeUpdateNotice(
  storage: Pick<Storage, "getItem" | "setItem">,
  currentVersion: string,
): boolean {
  if (currentVersion === "dev") return false;
  try {
    const lastSeen = storage.getItem(LAST_SEEN_VERSION_KEY);
    storage.setItem(LAST_SEEN_VERSION_KEY, currentVersion);
    if (lastSeen === null) return storage.getItem(ONBOARDING_COMPLETED_KEY) === "true";
    return compareVersions(currentVersion, lastSeen) > 0;
  } catch {
    return false;
  }
}

export function UpdateNotice({ version, t, onClose }: { version: string; t: Translate; onClose: () => void }) {
  const highlights = RELEASE_HIGHLIGHT_KEYS[version] ?? [];
  return (
    <aside className="update-notice" role="status" aria-live="polite">
      <header>
        <PartyPopper aria-hidden="true" />
        <strong>{t("whatsNew.title", { version })}</strong>
        <button type="button" onClick={onClose} aria-label={t("whatsNew.close")} title={t("whatsNew.close")}><X aria-hidden="true" /></button>
      </header>
      {highlights.length > 0 && <ul>{highlights.map((key) => <li key={key}>{t(key)}</li>)}</ul>}
    </aside>
  );
}
