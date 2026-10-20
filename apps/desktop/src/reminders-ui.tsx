import { useEffect, useRef } from "react";
import { BellRing } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  LEAD_MINUTE_OPTIONS,
  dueReminders,
  loadFiredReminders,
  saveFiredReminders,
  type ReminderSettings,
} from "./reminders";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Language = "zh-TW" | "en";

export const KEEP_IN_TRAY_KEY = "second-brain.keepRunningInTray";
const CHECK_INTERVAL_MS = 30_000;

export function loadKeepInTray(storage: Pick<Storage, "getItem">): boolean {
  try {
    // On by default: reminders only work while the app keeps running.
    return storage.getItem(KEEP_IN_TRAY_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Checks every half minute for reminders that are due and hands them to the
 * native notifier. Shown keys are remembered so a restart does not repeat them.
 */
export function useReminders({ tasks, settings, language, notify }: {
  tasks: readonly BrainTaskSnapshot[];
  settings: ReminderSettings;
  language: Language;
  notify?: (title: string, body: string) => Promise<void>;
}) {
  const latest = useRef({ tasks, settings, language });
  latest.current = { tasks, settings, language };
  useEffect(() => {
    if (!notify) return;
    // Keys being shown right now, so a slow notifier is not asked twice.
    const pending = new Set<string>();
    const check = () => {
      const fired = new Set(loadFiredReminders(localStorage));
      const due = dueReminders(latest.current.tasks, new Date(), latest.current.settings, fired, latest.current.language)
        .filter((reminder) => !pending.has(reminder.key));
      for (const reminder of due) {
        pending.add(reminder.key);
        // Only a shown notification counts; a failed one is retried next check.
        void notify(reminder.title, reminder.body)
          .then(() => saveFiredReminders(localStorage, [...loadFiredReminders(localStorage), reminder.key]))
          .catch(() => undefined)
          .finally(() => pending.delete(reminder.key));
      }
    };
    check();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [notify]);
}

export function ReminderSettingsCard({ settings, keepInTray, t, onChange, onKeepInTrayChange, onTest }: {
  settings: ReminderSettings;
  keepInTray: boolean;
  t: Translate;
  onChange: (settings: ReminderSettings) => void;
  onKeepInTrayChange: (value: boolean) => void;
  onTest?: () => void;
}) {
  return (
    <section className="settings-card reminder-settings">
      <h2><BellRing aria-hidden="true" />{t("reminders.title")}</h2>
      <p>{t("reminders.hint")}</p>
      <label className="detail-checkbox-property">
        <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
        {t("reminders.enabled")}
      </label>
      <div className="reminder-settings-grid">
        <label>
          {t("reminders.lead")}
          <select
            disabled={!settings.enabled}
            value={settings.leadMinutes}
            onChange={(event) => onChange({ ...settings, leadMinutes: Number(event.target.value) })}
          >
            {LEAD_MINUTE_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes === 0 ? t("reminders.lead.atStart") : t("reminders.lead.minutes", { minutes })}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("reminders.digest")}
          <span className="reminder-digest-row">
            <input
              type="checkbox"
              aria-label={t("reminders.digest.enabled")}
              disabled={!settings.enabled}
              checked={settings.digestTime !== null}
              onChange={(event) => onChange({ ...settings, digestTime: event.target.checked ? "09:00" : null })}
            />
            <input
              type="time"
              aria-label={t("reminders.digest.time")}
              disabled={!settings.enabled || settings.digestTime === null}
              value={settings.digestTime ?? "09:00"}
              onChange={(event) => event.target.value && onChange({ ...settings, digestTime: event.target.value })}
            />
          </span>
        </label>
      </div>
      <label className="detail-checkbox-property">
        <input type="checkbox" checked={keepInTray} onChange={(event) => onKeepInTrayChange(event.target.checked)} />
        {t("reminders.keepInTray")}
      </label>
      <small className="reminder-settings-note">{t("reminders.keepInTray.hint")}</small>
      {onTest && (
        <div className="input-action">
          <button type="button" className="secondary-button" disabled={!settings.enabled} onClick={onTest}>{t("reminders.test")}</button>
        </div>
      )}
    </section>
  );
}
