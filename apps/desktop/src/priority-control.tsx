import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { priorityDisplay } from "./task-actions";
import { translate, type UiLanguage } from "./ui-preferences";

const TASK_PRIORITIES: BrainTaskSnapshot["priority"][] = [
  "highest",
  "high",
  "medium",
  "normal",
  "low",
];

const ENTITY_LEVELS: Array<1 | 2 | 3> = [1, 2, 3];

function Popover({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="priority-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}

export function PriorityBadge({
  priority,
  locale = "zh-TW",
  compact = false,
}: {
  priority: BrainTaskSnapshot["priority"];
  locale?: UiLanguage;
  compact?: boolean;
}) {
  const item = priorityDisplay(priority);
  const label = translate(locale, `task.priority.${priority}`);
  return (
    <span
      className={`priority-badge priority-${priority} ${compact ? "priority-compact" : ""}`}
      title={translate(locale, "task.priority.label", { code: item.code, label })}
    >
      {item.code}
      {!compact && <small>{label}</small>}
    </span>
  );
}

export function PriorityControl({
  priority,
  onChange,
  locale = "zh-TW",
  compact = false,
}: {
  priority: BrainTaskSnapshot["priority"];
  onChange: (priority: BrainTaskSnapshot["priority"]) => void;
  locale?: UiLanguage;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const hint = translate(locale, "task.hint.editPriority");
  return (
    <div className="priority-control">
      <button
        type="button"
        className="priority-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={hint}
        aria-label={hint}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <PriorityBadge priority={priority} locale={locale} compact={compact} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div id={menuId}>
          {TASK_PRIORITIES.map((value) => {
            const item = priorityDisplay(value);
            const label = translate(locale, `task.priority.${value}`);
            return (
              <button
                key={value}
                type="button"
                role="menuitem"
                className={value === priority ? "active" : ""}
                onClick={() => {
                  onChange(value);
                  setOpen(false);
                }}
              >
                {item.code} · {label}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

export function ImportanceControl({
  value,
  onChange,
  locale = "zh-TW",
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  locale?: UiLanguage;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const hint = translate(locale, "project.hint.editImportance");
  const label = value == null
    ? translate(locale, "project.importance.unset")
    : value === 1
      ? translate(locale, "project.importance.high")
      : value === 2
        ? translate(locale, "project.importance.medium")
        : translate(locale, "project.importance.low");
  return (
    <div className="priority-control">
      <button
        type="button"
        className={`priority-trigger importance-badge importance-${value ?? "unset"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={hint}
        aria-label={hint}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {value == null ? label : `${value} · ${label}`}
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div id={menuId}>
          {ENTITY_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              role="menuitem"
              className={value === level ? "active" : ""}
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
            >
              {level} · {translate(locale, level === 1 ? "project.importance.high" : level === 2 ? "project.importance.medium" : "project.importance.low")}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className={value == null ? "active" : ""}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            {translate(locale, "project.importance.unset")}
          </button>
        </div>
      </Popover>
    </div>
  );
}
