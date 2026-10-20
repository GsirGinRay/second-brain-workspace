import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Hourglass, Moon, SkipForward, Target, X } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { TaskBadges } from "./task-badges";
import {
  AVAILABLE_HOUR_OPTIONS,
  addDaysToKey,
  dayLoad,
  formatHours,
  waitingItems,
  wrapUpSummary,
} from "./today-planning";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Language = "zh-TW" | "en";

function shortDate(dateKey: string): string {
  return `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`;
}

export function LoadMeter({ tasks, availableHours, language, t, onAvailableHoursChange }: {
  tasks: readonly BrainTaskSnapshot[];
  availableHours: number;
  language: Language;
  t: Translate;
  onAvailableHoursChange: (hours: number) => void;
}) {
  const load = dayLoad(tasks, availableHours);
  const ratio = load.availableMinutes ? Math.min(1, load.plannedMinutes / load.availableMinutes) : 1;
  const tone = load.overBy > 0 ? "over" : ratio >= 0.85 ? "full" : "ok";
  return (
    <article className={`load-meter is-${tone}`}>
      <span>{t("today.load.title")}</span>
      <strong>{formatHours(load.plannedMinutes, language)}<small> / </small>
        <select
          aria-label={t("today.load.available")}
          value={availableHours}
          onChange={(event) => onAvailableHoursChange(Number(event.target.value))}
        >
          {AVAILABLE_HOUR_OPTIONS.map((hours) => <option key={hours} value={hours}>{formatHours(hours * 60, language)}</option>)}
        </select>
      </strong>
      <div className="load-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={load.availableMinutes} aria-valuenow={load.plannedMinutes} aria-label={t("today.load.title")}>
        <i style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <small>
        {load.overBy > 0
          ? t("today.load.over", { hours: formatHours(load.overBy, language) })
          : load.unestimated > 0
            ? t("today.load.unestimated", { count: load.unestimated })
            : t("today.load.ok")}
      </small>
    </article>
  );
}

export function WaitingPanel({ tasks, today, t, onOpenTask, onReceived }: {
  tasks: readonly BrainTaskSnapshot[];
  today: string;
  t: Translate;
  onOpenTask: (taskId: string) => void;
  onReceived: (task: BrainTaskSnapshot) => void;
}) {
  const items = waitingItems(tasks, today);
  if (!items.length) return null;
  const due = items.filter((item) => item.followUpDue).length;
  return (
    <section className="today-panel waiting-panel">
      <header>
        <div><span className="eyebrow">WAITING FOR</span><h3>{t("today.waiting.title")}</h3></div>
        <strong>{items.length}</strong>
      </header>
      <p className="waiting-hint">{due ? t("today.waiting.due", { count: due }) : t("today.waiting.hint")}</p>
      <ul className="waiting-list">
        {items.map(({ task, followUpDue }) => (
          <li key={task.id ?? task.title} className={followUpDue ? "is-due" : ""}>
            <button type="button" className="waiting-title" onClick={() => task.id && onOpenTask(task.id)}>
              <Hourglass aria-hidden="true" />
              <span>{task.title}</span>
              {task.projectName && <small>{task.projectName}</small>}
            </button>
            <small className="waiting-date">
              {task.taskDate ? t(followUpDue ? "today.waiting.followUpNow" : "today.waiting.followUpOn", { date: shortDate(task.taskDate) }) : t("today.waiting.noDate")}
            </small>
            <button type="button" className="secondary-button" onClick={() => onReceived(task)}>{t("today.waiting.received")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function FocusMode({ queue, language, t, onComplete, onOpenTask, onClose }: {
  queue: readonly BrainTaskSnapshot[];
  language: Language;
  t: Translate;
  onComplete: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onClose: () => void;
}) {
  // Ids are snapshotted when focus starts; finished or skipped ones drop out.
  const [order] = useState(() => queue.flatMap((task) => task.id ? [task.id] : []));
  const [passed, setPassed] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const byId = useMemo(() => new Map(queue.flatMap((task) => task.id ? [[task.id, task] as const] : [])), [queue]);
  const remaining = order.filter((id) => !passed.includes(id) && byId.get(id) && byId.get(id)!.status !== "done");
  const current = remaining[0] ? byId.get(remaining[0])! : null;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const advance = (id: string) => {
    setPassed((items) => [...items, id]);
    setStartedAt(Date.now());
  };
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const target = (current?.durationMinutes ?? 0) * 60;
  return (
    <div className="focus-mode" role="dialog" aria-modal="true" aria-label={t("today.focus.title")}>
      <button type="button" className="focus-close" onClick={onClose} aria-label={t("today.focus.exit")} title={t("today.focus.exit")}><X aria-hidden="true" /></button>
      {current ? (
        <div className="focus-card">
          <span className="eyebrow">{t("today.focus.progress", { done: order.length - remaining.length + 1, total: order.length })}</span>
          <h2>{current.title}</h2>
          <p className="focus-meta">
            {current.projectName && <span>{current.projectName}</span>}
            {current.startTime && <span>{current.startTime}</span>}
            <TaskBadges task={current} locale={language} />
          </p>
          <div className={`focus-timer ${target && elapsed > target ? "is-over" : ""}`} aria-live="off">
            {formatClock(elapsed)}
            {target > 0 && <small> / {formatClock(target)}</small>}
          </div>
          <div className="focus-actions">
            <button type="button" className="primary" onClick={() => { onComplete(current); advance(current.id!); }}>
              <CheckCircle2 aria-hidden="true" />{t("today.focus.done")}
            </button>
            <button type="button" className="secondary-button" onClick={() => advance(current.id!)}>
              <SkipForward aria-hidden="true" />{t("today.focus.skip")}
            </button>
            <button type="button" className="secondary-button" onClick={() => onOpenTask(current.id!)}>{t("today.focus.open")}</button>
          </div>
          {remaining[1] && <p className="focus-next">{t("today.focus.next", { title: byId.get(remaining[1])!.title })}</p>}
        </div>
      ) : (
        <div className="focus-card">
          <Target aria-hidden="true" className="focus-finished-icon" />
          <h2>{t("today.focus.finished")}</h2>
          <button type="button" className="primary" onClick={onClose}>{t("today.focus.exit")}</button>
        </div>
      )}
    </div>
  );
}

export function WrapUpDialog({ tasks, today, t, onMove, onClose }: {
  tasks: readonly BrainTaskSnapshot[];
  today: string;
  t: Translate;
  onMove: (ids: ReadonlySet<string>, date: string) => void;
  onClose: () => void;
}) {
  const summary = useMemo(() => wrapUpSummary(tasks, today), [tasks, today]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(summary.unfinished.flatMap((task) => task.id ? [task.id] : [])));
  const tomorrow = addDaysToKey(today, 1);
  // Tasks finished while the dialog is open drop out of the selection.
  const chosen = new Set(summary.unfinished.flatMap((task) => task.id && selected.has(task.id) ? [task.id] : []));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal wrap-up-modal" role="dialog" aria-modal="true" aria-label={t("today.wrap.title")} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="modal-header">
          <div><span className="eyebrow">END OF DAY</span><h2>{t("today.wrap.title")}</h2></div>
          <button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose} autoFocus><X aria-hidden="true" /></button>
        </div>
        <div className="wrap-up-stats">
          <article><strong>{summary.doneToday.length}</strong><span>{t("today.wrap.doneToday")}</span></article>
          <article><strong>{summary.doneThisWeek}</strong><span>{t("today.wrap.doneWeek")}</span></article>
        </div>
        {summary.topProjects.length > 0 && (
          <p className="wrap-up-projects">{t("today.wrap.topProjects", { projects: summary.topProjects.map((item) => `${item.name}（${item.count}）`).join("、") })}</p>
        )}
        {summary.doneToday.length > 0 && (
          <details className="wrap-up-done">
            <summary>{t("today.wrap.doneList")}</summary>
            <ul>{summary.doneToday.map((task) => <li key={task.id ?? task.title}>{task.title}</li>)}</ul>
          </details>
        )}
        <h3>{t("today.wrap.unfinished", { count: summary.unfinished.length })}</h3>
        {summary.unfinished.length === 0 ? (
          <p className="wrap-up-clear">{t("today.wrap.allClear")}</p>
        ) : (
          <ul className="wrap-up-list">
            {summary.unfinished.map((task) => (
              <li key={task.id!}>
                <label>
                  <input type="checkbox" checked={selected.has(task.id!)} onChange={() => toggle(task.id!)} />
                  <span>{task.title}</span>
                  {task.taskDate && task.taskDate < today && <small className="overdue-label">{shortDate(task.taskDate)}</small>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>{t("app.close")}</button>
          {summary.unfinished.length > 0 && (
            <button className="primary" disabled={chosen.size === 0} onClick={() => { onMove(chosen, tomorrow); onClose(); }}>
              <Moon aria-hidden="true" />{t("today.wrap.move", { count: chosen.size })}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
