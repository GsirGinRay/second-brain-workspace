import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";

/**
 * A destructive action that confirms itself in place. The first click arms the
 * fixed-size button, then the second click deletes. Arming expires after a few
 * seconds, on Escape, or on any pointer-down outside the button itself.
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
  /** Label while idle (e.g.「永久刪除」）. */
  armLabel: string;
  /** Label while armed（e.g.「再點一次以永久刪除」）. */
  confirmLabel: string;
  className?: string;
  disabled?: boolean;
  /** Optional text rendered beside the status icon (footer-style buttons). */
  children?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  const disarm = useCallback(() => {
    setArmed(false);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => disarm(), [disarm]);

  useEffect(() => {
    if (!armed) return;
    const cancel = () => disarm();
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      }
    }
    function onOutside(event: MouseEvent) {
      // The same button is the only valid target: anything else disarms.
      if (!(event.target instanceof Element) || !event.target.closest("button.danger-confirm.armed")) cancel();
    }
    window.addEventListener("keydown", onEscape);
    document.addEventListener("mousedown", onOutside);
    return () => {
      window.removeEventListener("keydown", onEscape);
      document.removeEventListener("mousedown", onOutside);
    };
  }, [armed, disarm]);

  const click = () => {
    if (disabled) return;
    if (!armed) {
      setArmed(true);
      timerRef.current = window.setTimeout(disarm, 5000);
      return;
    }
    disarm();
    onConfirm();
  };

  const hasLabel = Boolean(children);
  return (
    <button
      type="button"
      className={[
        "danger-confirm",
        armed ? "armed" : "",
        hasLabel ? "has-label" : "",
        className,
      ].filter(Boolean).join(" ")}
      aria-label={armed ? confirmLabel : armLabel}
      aria-pressed={armed}
      title={armed ? confirmLabel : armLabel}
      onClick={(event) => {
        event.stopPropagation();
        click();
      }}
      disabled={disabled}
    >
      <Trash2 aria-hidden="true" />
      {children}
    </button>
  );
}
