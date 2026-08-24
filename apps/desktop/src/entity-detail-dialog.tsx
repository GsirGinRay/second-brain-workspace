import React, { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  CheckCircle2,
  FolderKanban,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type {
  BrainProjectSnapshot,
  BrainTaskSnapshot,
  TaskStatus,
} from "@second-brain/brain-core";
import { CategoryInput } from "./category-input";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import type { UiLanguage } from "./ui-preferences";

export type DetailTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function confirmDiscard(locale: UiLanguage): boolean {
  return window.confirm(
    locale === "zh-TW"
      ? "放棄尚未儲存的變更？"
      : "Discard unsaved changes?",
  );
}

function DetailDialog({
  title,
  eyebrow,
  dirty,
  locale,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  dirty: boolean;
  locale: UiLanguage;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const requestClose = () => {
    if (dirty && !confirmDiscard(locale)) return;
    onClose();
  };

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  return (
    <div
      className="modal-backdrop detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            requestClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="detail-dialog-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={locale === "zh-TW" ? "關閉" : "Close"}
            title={locale === "zh-TW" ? "關閉" : "Close"}
            onClick={requestClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function useSaveShortcut(save: () => void) {
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function TaskDetailDialog({
  task,
  projects,
  locale,
  t,
  onClose,
  onSave,
  onDelete,
}: {
  task: BrainTaskSnapshot;
  projects: BrainProjectSnapshot[];
  locale: UiLanguage;
  t: DetailTranslate;
  onClose: () => void;
  onSave: (task: BrainTaskSnapshot) => Promise<boolean> | boolean;
  onDelete: (task: BrainTaskSnapshot) => void;
}) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(task), [task]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(task);
  const chooseProject = (id: string) => {
    const project = projects.find((item) => item.id === id);
    setDraft((current) => ({
      ...current,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    }));
  };
  const save = async () => {
    if (!draft.title.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ ...draft, title: draft.title.trim() });
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    if (dirty && !confirmDiscard(locale)) return;
    onClose();
  };
  useSaveShortcut(() => void save());

  return (
    <DetailDialog title={task.title} eyebrow="TASK" dirty={dirty} locale={locale} onClose={onClose}>
      <div className="detail-edit-form notion-editor">
        <input
          className="detail-title-input"
          aria-label={t("task.field.title")}
          value={draft.title}
          maxLength={500}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
        <div className="detail-form-grid">
          <label>{t("task.field.status")}<select value={draft.status} onChange={(event) => { const status = event.target.value as TaskStatus; setDraft({ ...draft, status, completedAt: status === "done" ? draft.completedAt : null }); }}><option value="todo">{t("task.status.todo")}</option><option value="doing">{t("task.status.doing")}</option><option value="waiting">{t("task.status.waiting")}</option><option value="done">{t("task.status.done")}</option></select></label>
          <label>{t("task.field.priority")}<select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as BrainTaskSnapshot["priority"] })}><option value="highest">P1 · {t("task.priority.highest")}</option><option value="high">P2 · {t("task.priority.high")}</option><option value="medium">P3 · {t("task.priority.medium")}</option><option value="normal">P4 · {t("task.priority.normal")}</option><option value="low">P5 · {t("task.priority.low")}</option></select></label>
          <label>{t("task.field.date")}<input type="date" value={draft.taskDate ?? ""} onChange={(event) => setDraft({ ...draft, taskDate: event.target.value || null })} /></label>
          <label>{t("task.field.startTime")}<input type="time" value={draft.startTime ?? ""} onChange={(event) => setDraft({ ...draft, startTime: event.target.value || null, durationMinutes: event.target.value ? (draft.durationMinutes ?? 30) : null, timeZone: "Asia/Taipei" })} /></label>
          <label>{t("task.field.duration")}<select disabled={!draft.startTime} value={draft.durationMinutes ?? 30} onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) })}>{[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} {locale === "zh-TW" ? "分" : "min"}</option>)}</select></label>
          <label>{t("task.field.project")}<select value={draft.projectId ?? ""} onChange={(event) => chooseProject(event.target.value)}><option value="">{t("app.unassigned")}</option>{projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}</select></label>
        </div>
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={(body) => setDraft((current) => ({ ...current, body }))} locale={locale} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <button type="button" className="secondary-button action-with-icon" onClick={() => setDraft((current) => ({ ...current, status: current.status === "done" ? "todo" : "done", completedAt: current.status === "done" ? null : current.completedAt }))}><CheckCircle2 aria-hidden="true" />{t(draft.status === "done" ? "task.action.reopen" : "task.action.complete")}</button>
            <button type="button" className="danger action-with-icon" onClick={() => onDelete(task)}><Trash2 aria-hidden="true" />{t("task.action.delete")}</button>
          </div>
          <div>
            <button type="button" className="secondary-button" onClick={cancel}>{t("app.cancel")}</button>
            <button type="button" className="primary action-with-icon" disabled={!dirty || !draft.title.trim() || saving} onClick={() => void save()}><Save aria-hidden="true" />{t("app.save")}</button>
          </div>
        </div>
      </div>
    </DetailDialog>
  );
}

export function ProjectDetailDialog({
  project,
  openTasks,
  doingTasks,
  existingAreas,
  locale,
  t,
  onClose,
  onSave,
  onOpenBoard,
  onComplete,
  onReopen,
  onArchive,
  onDelete,
}: {
  project: BrainProjectSnapshot;
  openTasks: number;
  doingTasks: number;
  existingAreas: string[];
  locale: UiLanguage;
  t: DetailTranslate;
  onClose: () => void;
  onSave: (project: BrainProjectSnapshot) => Promise<boolean> | boolean;
  onOpenBoard: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(project);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(project), [project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project);
  const save = async () => {
    if (!draft.name.trim() || saving) return;
    setSaving(true);
    try {
      await onSave({ ...draft, name: draft.name.trim() });
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    if (dirty && !confirmDiscard(locale)) return;
    onClose();
  };
  useSaveShortcut(() => void save());

  return (
    <DetailDialog title={project.name} eyebrow="PROJECT" dirty={dirty} locale={locale} onClose={onClose}>
      <div className="detail-edit-form notion-editor">
        <input className="detail-title-input" aria-label={t("entity.field.name")} value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <div className="detail-form-grid">
          <label>{t("project.field.status")}<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}><option value="planning">{t("project.status.planning")}</option><option value="active">{t("project.status.active")}</option><option value="paused">{t("project.status.paused")}</option><option value="done">{t("project.status.done")}</option><option value="archived">{t("project.status.archived")}</option></select></label>
          <label>{t("project.field.category")}<CategoryInput value={draft.area ?? ""} existingCategories={existingAreas} listId={`project-detail-area-${project.id ?? "draft"}`} ariaLabel={t("project.field.category")} onChange={(area) => setDraft({ ...draft, area: area || null })} /></label>
          <label>{t("project.field.importance")}<select value={draft.priority ?? ""} onChange={(event) => setDraft({ ...draft, priority: event.target.value ? Number(event.target.value) : null })}><option value="">{t("project.importance.unset")}</option><option value="1">1 · {t("project.importance.high")}</option><option value="2">2 · {t("project.importance.medium")}</option><option value="3">3 · {t("project.importance.low")}</option></select></label>
          <label>{t("project.field.startDate")}<input type="date" value={draft.startDate ?? ""} onChange={(event) => setDraft({ ...draft, startDate: event.target.value || null })} /></label>
          <label>{t("project.field.endDate")}<input type="date" value={draft.endDate ?? ""} onChange={(event) => setDraft({ ...draft, endDate: event.target.value || null })} /></label>
          <label>{t("project.field.progress", { value: draft.progress ?? 0 })}<input type="range" min="0" max="100" value={draft.progress ?? 0} onChange={(event) => setDraft({ ...draft, progress: Number(event.target.value) })} /></label>
          <label className="detail-checkbox-property"><input type="checkbox" checked={draft.focusToday} onChange={(event) => setDraft({ ...draft, focusToday: event.target.checked })} />{t("project.focusToday")}</label>
          <span className="detail-task-count">{t("task.count.open", { count: openTasks })} · {t("task.count.doing", { count: doingTasks })}</span>
        </div>
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={(body) => setDraft((current) => ({ ...current, body }))} locale={locale} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onOpenBoard}><FolderKanban aria-hidden="true" />{t("project.action.open")}</button>
            {project.status === "done" || project.status === "archived" ? <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onReopen}><RotateCcw aria-hidden="true" />{t("project.action.reopen")}</button> : <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onComplete}><CheckCircle2 aria-hidden="true" />{t("project.action.complete")}</button>}
            {project.status !== "archived" && <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onArchive}><Archive aria-hidden="true" />{t("project.action.archive")}</button>}
            <button type="button" className="danger action-with-icon" onClick={onDelete}><Trash2 aria-hidden="true" />{t("project.action.delete")}</button>
          </div>
          <div>
            <button type="button" className="secondary-button" onClick={cancel}>{t("app.cancel")}</button>
            <button type="button" className="primary action-with-icon" disabled={!dirty || !draft.name.trim() || saving} onClick={() => void save()}><Save aria-hidden="true" />{t("app.save")}</button>
          </div>
        </div>
      </div>
    </DetailDialog>
  );
}
