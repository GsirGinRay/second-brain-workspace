import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { translate, type UiLanguage } from "./ui-preferences";

function currentLanguage(): UiLanguage {
  return document.documentElement.lang === "en" ? "en" : "zh-TW";
}

/**
 * Shared confirmation sheet. Delete uses the danger tone; completing a
 * project uses primary so the dialog matches the rest of the app instead
 * of a native window.confirm.
 */
export function ActionConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = "danger",
  busy = false,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const danger = tone === "danger";

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return createPortal(
    <div
      className={`modal-backdrop ${danger ? "delete-confirm-backdrop" : "action-confirm-backdrop"}`}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <section
        className={`modal ${danger ? "delete-confirm-dialog" : "action-confirm-dialog"}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{message}</p>
        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? "danger delete-confirm-accept" : "primary action-confirm-accept"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
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
  const language = currentLanguage();
  const message = translate(language, "confirm.deleteMessage");
  const cancelLabel = translate(language, "app.cancel");

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
      <ActionConfirmDialog
        open={open}
        title={armLabel}
        message={message}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone="danger"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
      />
    </>
  );
}
