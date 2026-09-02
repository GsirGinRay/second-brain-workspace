import React, { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Square checkbox used for completing a task on every surface (today, board,
 * calendar, detail). A filled circle, a Check icon, or a labelled 完成 button
 * all read as different actions; this is the one control.
 */
export function TaskCompleteButton({
  done,
  label,
  title,
  onClick,
  className = "",
  size = "md",
}: {
  done: boolean;
  label: string;
  title?: string;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button
      type="button"
      className={["task-complete", `task-complete-${size}`, done ? "done" : "", className].filter(Boolean).join(" ")}
      aria-label={label}
      aria-pressed={done}
      title={title ?? label}
      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick(event);
      }}
    >
      {done ? "✓" : ""}
    </button>
  );
}
