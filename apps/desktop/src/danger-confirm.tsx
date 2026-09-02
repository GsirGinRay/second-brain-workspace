import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { translate, type UiLanguage } from "./ui-preferences";

function currentLanguage(): UiLanguage {
  return document.documentElement.lang === "en" ? "en" : "zh-TW";
}

/**
 * Permanent delete asks in a dialog so a first click never looks like it
 * already worked. The compact trash control stays in the list; confirmation
 * happens in a modal that names the action and mentions Ctrl+Z undo.
 */
export function DangerConfirmButton({
  onConfirm,
  armLabel,
  confirmLabel,
  className = "",
  disabled = false,
  children,
}: {
  onConfirm: () => void;
  /** Idle control label (e.g.「永久刪除」), also used as the dialog title. */
  armLabel: string;
  /** Dialog confirm button (e.g.「確定永久刪除」). */
  confirmLabel: string;
  className?: string;
  disabled?: boolean;
  /** Optional text rendered beside the status icon (footer-style buttons). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const language = currentLanguage();
  const message = translate(language, "confirm.deleteMessage");
  const cancelLabel = translate(language, "app.cancel");

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const hasLabel = Boolean(children);
  return (
    <>
      <button
        type="button"
        className={["danger-confirm", hasLabel ? "has-label" : "", className].filter(Boolean).join(" ")}
        aria-label={armLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={armLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          setOpen(true);
        }}
        disabled={disabled}
      >
        <Trash2 aria-hidden="true" />
        {children}
      </button>
      {open && createPortal(
        <div
          className="modal-backdrop delete-confirm-backdrop"
          onMouseDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) setOpen(false);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <section
            className="modal delete-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id={titleId}>{armLabel}</h2>
            <p id={descriptionId}>{message}</p>
            <div className="modal-actions">
              <button
                ref={cancelRef}
                type="button"
                className="secondary-button"
                onClick={() => setOpen(false)}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                className="danger delete-confirm-accept"
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
