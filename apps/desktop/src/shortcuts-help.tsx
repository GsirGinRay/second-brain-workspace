import { X } from "lucide-react";

type Translate = (key: string, values?: Record<string, string | number>) => string;

interface ShortcutGroup {
  titleKey: string;
  items: { keys: string[][]; labelKey: string }[];
}

// Every entry mirrors a handler that exists in the app; keep them in sync.
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    titleKey: "shortcuts.group.global",
    items: [
      { keys: [["N"]], labelKey: "shortcuts.quickAdd" },
      { keys: [["Ctrl", "Alt", "N"]], labelKey: "shortcuts.quickCapture" },
      { keys: [["Ctrl", "K"], ["/"]], labelKey: "shortcuts.search" },
      { keys: [["Ctrl", "Z"]], labelKey: "shortcuts.undo" },
      { keys: [["Ctrl", "Shift", "Z"]], labelKey: "shortcuts.redo" },
      { keys: [["Alt", "←"], ["Alt", "→"]], labelKey: "shortcuts.back" },
      { keys: [["?"]], labelKey: "shortcuts.help" },
    ],
  },
  {
    titleKey: "shortcuts.group.editing",
    items: [
      { keys: [["Ctrl", "S"]], labelKey: "shortcuts.save" },
      { keys: [["Ctrl", "Enter"]], labelKey: "shortcuts.submit" },
      { keys: [["Esc"]], labelKey: "shortcuts.close" },
    ],
  },
  {
    titleKey: "shortcuts.group.board",
    items: [
      { keys: [["Enter"], ["Space"]], labelKey: "shortcuts.openCard" },
      { keys: [["Alt", "←"], ["Alt", "→"]], labelKey: "shortcuts.moveLane" },
    ],
  },
];

/** `?` opens the list unless the user is typing or another dialog is open. */
export function isShortcutHelpKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, editable: boolean, modalOpen: boolean): boolean {
  return event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !editable && !modalOpen;
}

export function ShortcutsDialog({ t, onClose }: { t: Translate; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        className="modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <div className="modal-header">
          <div><span className="eyebrow">KEYBOARD</span><h2>{t("shortcuts.title")}</h2></div>
          <button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose} autoFocus><X aria-hidden="true" /></button>
        </div>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.titleKey} className="shortcuts-group">
            <h3>{t(group.titleKey)}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.labelKey} className="shortcuts-row">
                  <dt>
                    {item.keys.map((combo, index) => (
                      <span key={combo.join("+")} className="shortcuts-combo">
                        {index > 0 && <span className="shortcuts-or">/</span>}
                        {combo.map((key) => <kbd key={key}>{key}</kbd>)}
                      </span>
                    ))}
                  </dt>
                  <dd>{t(item.labelKey)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </section>
    </div>
  );
}
