import { type ReactNode } from "react";
import { useUiPreferences } from "./app-shared";
import { APP_VERSION } from "./app-version";
import {
  type AppUpdateCheck,
  type DiagnosticsSnapshot,
} from "./ipc";

export function SyncSettings({
  diagnostics,
  vaultInput,
  setVaultInput,
  working,
  onBrowseVault,
  onSelectVault,
  onOpenArchitecture,
  onPreviewLayout,
  appUpdate,
  updateBusy,
  onCheckUpdate,
  onInstallUpdate,
  reminderCard,
  inboxRelayCard,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  vaultInput: string;
  setVaultInput: (v: string) => void;
  working: boolean;
  onBrowseVault: () => void;
  onSelectVault: () => void;
  onOpenArchitecture: () => void;
  onPreviewLayout: () => void;
  appUpdate: AppUpdateCheck | null;
  updateBusy: boolean;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  reminderCard?: ReactNode;
  inboxRelayCard?: ReactNode;
}) {
  const { preferences, setPreferences, t } = useUiPreferences();
  const languages = [
    { id: "zh-TW" as const, label: t("settings.language.zh") },
    { id: "en" as const, label: t("settings.language.en") },
  ];
  const themes = [
    { id: "light" as const, label: t("settings.theme.light") },
    { id: "dark" as const, label: t("settings.theme.dark") },
  ];
  const detailSurfaces = [
    { id: "dialog" as const, label: t("settings.detailSurface.dialog"), hint: t("settings.detailSurface.dialogHint") },
    { id: "panel" as const, label: t("settings.detailSurface.panel"), hint: t("settings.detailSurface.panelHint") },
  ];
  return (
    <div className="settings-grid">
      {reminderCard}
      {inboxRelayCard}
      <section className="settings-card">
        <h2>{t("update.title")}</h2>
        <p>{t("update.hint")}</p>
        <p>{t("update.current", { version: appUpdate?.currentVersion ?? APP_VERSION })}</p>
        {appUpdate?.available && <p><strong>{t("update.latest", { version: appUpdate.latestVersion })}</strong></p>}
        {appUpdate?.checked && !appUpdate.available && <p>{t("update.none")}</p>}
        {appUpdate && !appUpdate.checked && <p>{t("update.offline")}</p>}
        <div className="input-action">
          <button className="secondary-button" disabled={working || updateBusy} onClick={onCheckUpdate}>
            {updateBusy ? t("update.checking") : t("update.check")}
          </button>
          {appUpdate?.available && (
            <button className="primary" disabled={working || updateBusy} onClick={onInstallUpdate}>
              {updateBusy ? t("update.installing") : t("update.install")}
            </button>
          )}
        </div>
      </section>
      <section className="settings-card">
        <h2>{t("settings.language")}</h2>
        <p>{t("settings.language.hint")}</p>
        <div className="surface-choice" role="radiogroup" aria-label={t("settings.language")}>
          {languages.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={preferences.language === option.id}
              className={preferences.language === option.id ? "active" : ""}
              onClick={() => setPreferences((value) => ({ ...value, language: option.id }))}
            >
              <strong>{option.label}</strong>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h2>{t("settings.theme")}</h2>
        <p>{t("settings.theme.hint")}</p>
        <div className="surface-choice" role="radiogroup" aria-label={t("settings.theme")}>
          {themes.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={preferences.theme === option.id}
              className={preferences.theme === option.id ? "active" : ""}
              onClick={() => setPreferences((value) => ({ ...value, theme: option.id }))}
            >
              <strong>{option.label}</strong>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card detail-surface-settings">
        <h2>{t("settings.detailSurface")}</h2>
        <p>{t("settings.detailSurface.hint")}</p>
        <div className="surface-choice" role="radiogroup" aria-label={t("settings.detailSurface")}>
          {detailSurfaces.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={preferences.detailSurface === option.id}
              className={preferences.detailSurface === option.id ? "active" : ""}
              onClick={() => setPreferences((value) => ({ ...value, detailSurface: option.id }))}
            >
              <strong>{option.label}</strong>
              <small>{option.hint}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <span className="step">★</span>
        <h2>{preferences.language === "zh-TW" ? "建立知識架構" : "Build knowledge architecture"}</h2>
        <p>{preferences.language === "zh-TW"
          ? "預設只建立專案與知識庫。提示詞庫、模板與 AI 委任之後需要再加。已存在的檔案不會被覆寫。"
          : "Projects and knowledge are selected by default. Add the prompt library, templates, or AI handoff later if you need them. Existing files are not overwritten."}</p>
        <button className="primary wide" onClick={onOpenArchitecture}>
          {preferences.language === "zh-TW" ? "新建架構模板" : "New architecture templates"}
        </button>
      </section>
      <section className="settings-card">
        <h2>{t("layout.title")}</h2>
        <p>{t("layout.help")}</p>
        <button className="primary wide" disabled={working} onClick={onPreviewLayout}>
          {t("layout.preview")}
        </button>
      </section>
      <section className="settings-card">
        <span className="step">1</span>
        <h2>{t("sync.folder")}</h2>
        <p>{t("settings.localHelp")}</p>
        <p>{t("sync.folderHelp")}</p>
        <code>{diagnostics?.selectedVault ?? t("sync.notSelected")}</code>
        <button
          className="browse-button wide"
          disabled={working}
          onClick={onBrowseVault}
        >
          {t("sync.browse")}
        </button>
        <details>
          <summary>{t("sync.manualPath")}</summary>
          <div className="input-action">
            <input
              placeholder="C:\Users\name\Documents\SecondBrain"
              value={vaultInput}
              onChange={(event) => setVaultInput(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={working || !vaultInput.trim()}
              onClick={onSelectVault}
            >
              {t("sync.useFolder")}
            </button>
          </div>
        </details>
      </section>
      <section className="settings-card">
        <span className="step">2</span>
        <h2>{t("sync.recovery")}</h2>
        <p>{t("settings.recoveryLocalHelp")}</p>
        <div className="diagnostic-list">
          <span>
            Watcher <b>{diagnostics?.watcherStatus ?? "stopped"}</b>
          </span>
          <span>
            Recovery <b>{diagnostics?.recoveryStatus ?? "none"}</b>
          </span>
        </div>
      </section>
    </div>
  );
}
