import React, { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Archive,
  CheckCircle2,
  FolderKanban,
  Maximize2,
  Minimize2,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import type {
  BrainProjectSnapshot,
  BrainTaskSnapshot,
  TaskStatus,
} from "@second-brain/brain-core";
import { CategoryInput } from "./category-input";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import { ProjectPicker, type CreatedProject } from "./project-picker";
import { DangerConfirmButton } from "./danger-confirm";
import type { UiDetailSurface, UiLanguage } from "./ui-preferences";

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

const NARROW_DETAIL_BREAKPOINT = 900;
const DETAIL_PANEL_WIDTH_KEY = "second-brain.detailPanelWidth";

export interface DetailTab {
  key: string;
  kind: "task" | "project";
  title: string;
}

function useNarrowDetailViewport(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= NARROW_DETAIL_BREAKPOINT);
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth <= NARROW_DETAIL_BREAKPOINT);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

/**
 * The dialog shell only owns focus trapping and layout. Closing policy lives
 * with each dialog so an outside click can auto-save instead of discarding.
 */
function DetailDialog({
  title,
  eyebrow,
  locale,
  surface = "dialog",
  tabs = [],
  activeTabKey,
  onRequestTabChange,
  onCloseTab,
  onRequestClose,
  children,
}: {
  title: string;
  eyebrow: string;
  locale: UiLanguage;
  surface?: UiDetailSurface;
  tabs?: DetailTab[];
  activeTabKey?: string;
  onRequestTabChange?: (key: string) => Promise<boolean> | boolean;
  onCloseTab?: (key: string) => void;
  onRequestClose: () => Promise<boolean> | boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const forwardingOutsideClickRef = useRef(false);
  const narrowViewport = useNarrowDetailViewport();
  const panelSurface = surface === "panel";
  const dockedPanel = panelSurface && !narrowViewport;
  const [expanded, setExpanded] = useState(false);
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = Number.parseInt(window.localStorage?.getItem(DETAIL_PANEL_WIDTH_KEY) ?? "", 10);
    return Number.isFinite(stored) && stored >= 420 && stored <= 1200 ? stored : 620;
  });
  const resizeStartRef = useRef<{ clientX: number; width: number; pointerId: number } | null>(null);

  useEffect(() => {
    window.localStorage?.setItem(DETAIL_PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  const clampPanelWidth = (width: number) => Math.max(420, Math.min(Math.max(420, window.innerWidth - 240), width));
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || expanded) return;
    event.preventDefault();
    resizeStartRef.current = { clientX: event.clientX, width: panelWidth, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    setPanelWidth(clampPanelWidth(start.width + start.clientX - event.clientX));
  };
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    try { event.currentTarget.releasePointerCapture(start.pointerId); } catch { /* already released */ }
    resizeStartRef.current = null;
  };

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!dockedPanel) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || dialogRef.current?.contains(target)) return;
      if (target.closest(".delete-confirm-backdrop, .delete-confirm-dialog")) return;
      event.preventDefault();
      event.stopPropagation();
      if (forwardingOutsideClickRef.current) return;
      forwardingOutsideClickRef.current = true;

      // The original click must wait for autosave. Replaying it afterwards lets a
      // task/project behind the panel become the next selection without the old
      // dialog's eventual onClose clearing that new selection.
      const clickDetails = {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      };
      const blockOriginalClick = (clickEvent: MouseEvent) => {
        const clickTarget = clickEvent.target as Node | null;
        if (clickTarget && dialogRef.current?.contains(clickTarget)) return;
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
      };
      document.addEventListener("click", blockOriginalClick, true);
      void Promise.resolve(onRequestClose()).then((closed) => {
        window.setTimeout(() => {
          document.removeEventListener("click", blockOriginalClick, true);
          forwardingOutsideClickRef.current = false;
          if (closed && target.isConnected) {
            target.dispatchEvent(new MouseEvent("click", clickDetails));
          }
        }, 0);
      });
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [dockedPanel, onRequestClose]);

  return (
    <div
      className={`modal-backdrop detail-backdrop${panelSurface ? " detail-backdrop-panel" : ""}`}
      onMouseDown={(event) => {
        if (!dockedPanel && event.target === event.currentTarget) void onRequestClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`detail-dialog${panelSurface ? " detail-dialog-panel" : ""}${expanded ? " detail-dialog-expanded" : ""}`}
        style={dockedPanel ? ({ ["--detail-panel-width" as string]: `${panelWidth}px` } as CSSProperties) : undefined}
        role="dialog"
        aria-modal={dockedPanel ? undefined : true}
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            void onRequestClose();
            return;
          }
          if (event.key !== "Tab" || dockedPanel) return;
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
        {dockedPanel && !expanded && (
          <div
            className="detail-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={locale === "zh-TW" ? "調整側面板寬度" : "Resize side panel"}
            aria-valuemin={420}
            aria-valuemax={Math.max(420, window.innerWidth - 240)}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") { event.preventDefault(); setPanelWidth((width) => clampPanelWidth(width + 20)); }
              else if (event.key === "ArrowRight") { event.preventDefault(); setPanelWidth((width) => clampPanelWidth(width - 20)); }
              else if (event.key === "Home") { event.preventDefault(); setPanelWidth(620); }
            }}
          />
        )}
        {tabs.length > 0 && (
          <nav className="detail-dialog-tabs" aria-label={locale === "zh-TW" ? "已開啟的視窗" : "Open views"}>
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.key}
                className={tab.key === activeTabKey ? "active" : ""}
                aria-current={tab.key === activeTabKey ? "page" : undefined}
                onClick={() => tab.key !== activeTabKey && void onRequestTabChange?.(tab.key)}
                title={tab.title}
              >
                <span>{tab.title}</span>
                <X
                  aria-label={locale === "zh-TW" ? `關閉 ${tab.title}` : `Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (tab.key === activeTabKey) void onRequestClose();
                    else onCloseTab?.(tab.key);
                  }}
                />
              </button>
            ))}
          </nav>
        )}
        <header className="detail-dialog-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <div className="detail-dialog-header-actions">
            {dockedPanel && (
              <button
                type="button"
                className="icon-button"
                aria-label={locale === "zh-TW" ? (expanded ? "還原側面板" : "展開全部") : (expanded ? "Restore panel" : "Expand fully")}
                title={locale === "zh-TW" ? (expanded ? "還原側面板" : "展開全部") : (expanded ? "Restore panel" : "Expand fully")}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={locale === "zh-TW" ? "關閉" : "Close"}
              title={locale === "zh-TW" ? "關閉" : "Close"}
              onClick={onRequestClose}
            >
              <X aria-hidden="true" />
            </button>
          </div>
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
  surface,
  tabs,
  activeTabKey,
  onSelectTab,
  onCloseTab,
  t,
  onClose,
  onSave,
  onDelete,
  onCreateProject,
}: {
  task: BrainTaskSnapshot;
  projects: BrainProjectSnapshot[];
  locale: UiLanguage;
  surface?: UiDetailSurface;
  tabs?: DetailTab[];
  activeTabKey?: string;
  onSelectTab?: (key: string) => void;
  onCloseTab?: (key: string) => void;
  t: DetailTranslate;
  onClose: () => void;
  onSave: (task: BrainTaskSnapshot) => Promise<boolean> | boolean;
  onDelete: (task: BrainTaskSnapshot) => void;
  onCreateProject?: (name: string) => Promise<CreatedProject | null>;
}) {
  const [draft, setDraft] = useState(task);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(task), [task]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(task);
  const chooseProject = (project: BrainProjectSnapshot | null) => {
    setDraft((current) => ({
      ...current,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    }));
  };
  const save = async (): Promise<boolean> => {
    if (!draft.title.trim() || saving) return false;
    setSaving(true);
    try {
      return await onSave({ ...draft, title: draft.title.trim() });
    } finally {
      setSaving(false);
    }
  };
  // Clicking outside / Escape / the × saves work in progress automatically;
  // only an untitled draft still asks before being thrown away.
  const commitBefore = async (action: () => void): Promise<boolean> => {
    if (!dirty) {
      action();
      return true;
    }
    if (!draft.title.trim()) {
      if (!confirmDiscard(locale)) return false;
      action();
      return true;
    }
    if (!await save()) return false;
    action();
    return true;
  };
  const requestClose = () => commitBefore(onClose);
  const requestTabChange = (key: string) => commitBefore(() => onSelectTab?.(key));
  const cancel = () => {
    if (dirty && !confirmDiscard(locale)) return;
    onClose();
  };
  useSaveShortcut(() => void save());

  return (
    <DetailDialog title={task.title} eyebrow="TASK" locale={locale} surface={surface} tabs={tabs} activeTabKey={activeTabKey} onRequestTabChange={requestTabChange} onCloseTab={onCloseTab} onRequestClose={requestClose}>
      <div className="detail-edit-form notion-editor">
        <textarea
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
          <div className="detail-project-field">
            <span className="detail-field-label">{t("task.field.project")}</span>
            <ProjectPicker
              projects={projects}
              valueId={draft.projectId}
              onSelect={chooseProject}
              onCreateProject={onCreateProject}
              locale={locale}
              ariaLabel={t("task.field.project")}
            />
          </div>
        </div>
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={(body) => setDraft((current) => ({ ...current, body }))} locale={locale} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <button type="button" className="secondary-button action-with-icon" onClick={() => setDraft((current) => ({ ...current, status: current.status === "done" ? "todo" : "done", completedAt: current.status === "done" ? null : current.completedAt }))}><CheckCircle2 aria-hidden="true" />{t(draft.status === "done" ? "task.action.reopen" : "task.action.complete")}</button>
            <DangerConfirmButton
              className="action-with-icon danger"
              armLabel={t("task.action.delete")}
              confirmLabel={t("confirm.deleteAgain")}
              onConfirm={() => onDelete(task)}
            >{t("task.action.delete")}</DangerConfirmButton>
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

/** Inline composer + task list shown inside the project detail dialog. */
function ProjectTaskSection({
  projectKey,
  tasks,
  locale,
  t,
  onAddTask,
  onToggleTask,
  onOpenTask,
  onDeleteTask,
}: {
  projectKey: string;
  tasks: BrainTaskSnapshot[];
  locale: UiLanguage;
  t: DetailTranslate;
  onAddTask: (title: string) => void;
  onToggleTask: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onDeleteTask: (task: BrainTaskSnapshot) => void;
}) {
  // Uncontrolled like the timeline composer: read the DOM value on commit.
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (): boolean => {
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (!trimmed) return false;
    onAddTask(trimmed);
    if (inputRef.current) inputRef.current.value = "";
    return true;
  };
  return (
    <section className="detail-task-section">
      <header>
        <h3>{t("project.tasks.title")}</h3>
        <small>{tasks.length}</small>
      </header>
      <form
        className="detail-task-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder={t("project.tasks.add")}
          aria-label={t("project.tasks.add")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape" && inputRef.current) {
              inputRef.current.value = "";
            }
          }}
          onBlur={() => submit()}
        />
      </form>
      {tasks.length === 0 ? (
        <p className="detail-task-empty">{locale === "zh-TW" ? "這個專案還沒有未完成任務。" : "No open tasks in this project yet."}</p>
      ) : (
        <ul className="detail-task-list">
          {tasks.map((task) => (
            <li key={task.id ?? `${projectKey}:${task.rank}`}>
              <button
                type="button"
                className={`detail-task-check ${task.status === "done" ? "done" : ""}`}
                aria-label={`${task.title} ${task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}`}
                title={task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                onClick={() => onToggleTask(task)}
              >{task.status === "done" ? "✓" : ""}</button>
              <button
                type="button"
                className="detail-task-title"
                onClick={() => task.id && onOpenTask(task.id)}
                title={t("task.hint.editTitle")}
              >{task.title}</button>
              <DangerConfirmButton
                className="icon-button"
                armLabel={t("task.action.delete")}
                confirmLabel={t("confirm.deleteAgain")}
                onConfirm={() => onDeleteTask(task)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProjectDetailDialog({
  project,
  openTasks,
  doingTasks,
  existingAreas,
  projectTasks,
  locale,
  surface,
  tabs,
  activeTabKey,
  onSelectTab,
  onCloseTab,
  t,
  onClose,
  onSave,
  onOpenBoard,
  onComplete,
  onReopen,
  onArchive,
  onDelete,
  onAddProjectTask,
  onToggleProjectTask,
  onOpenProjectTask,
  onDeleteProjectTask,
}: {
  project: BrainProjectSnapshot;
  openTasks: number;
  doingTasks: number;
  existingAreas: string[];
  /** Open tasks belonging to this project, rank-ordered by the caller. */
  projectTasks: BrainTaskSnapshot[];
  locale: UiLanguage;
  surface?: UiDetailSurface;
  tabs?: DetailTab[];
  activeTabKey?: string;
  onSelectTab?: (key: string) => void;
  onCloseTab?: (key: string) => void;
  t: DetailTranslate;
  onClose: () => void;
  onSave: (project: BrainProjectSnapshot) => Promise<boolean> | boolean;
  onOpenBoard: () => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onAddProjectTask: (title: string) => void;
  onToggleProjectTask: (task: BrainTaskSnapshot) => void;
  onOpenProjectTask: (taskId: string) => void;
  onDeleteProjectTask: (task: BrainTaskSnapshot) => void;
}) {
  const [draft, setDraft] = useState(project);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(project), [project]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(project);
  const save = async (): Promise<boolean> => {
    if (!draft.name.trim() || saving) return false;
    setSaving(true);
    try {
      return await onSave({ ...draft, name: draft.name.trim() });
    } finally {
      setSaving(false);
    }
  };
  const commitBefore = async (action: () => void): Promise<boolean> => {
    if (!dirty) {
      action();
      return true;
    }
    if (!draft.name.trim()) {
      if (!confirmDiscard(locale)) return false;
      action();
      return true;
    }
    if (!await save()) return false;
    action();
    return true;
  };
  const requestClose = () => commitBefore(onClose);
  const requestTabChange = (key: string) => commitBefore(() => onSelectTab?.(key));
  const cancel = () => {
    if (dirty && !confirmDiscard(locale)) return;
    onClose();
  };
  useSaveShortcut(() => void save());

  return (
    <DetailDialog title={project.name} eyebrow="PROJECT" locale={locale} surface={surface} tabs={tabs} activeTabKey={activeTabKey} onRequestTabChange={requestTabChange} onCloseTab={onCloseTab} onRequestClose={requestClose}>
      <div className="detail-edit-form notion-editor">
        <textarea className="detail-title-input" aria-label={t("entity.field.name")} value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
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
        <ProjectTaskSection
          projectKey={project.id ?? draft.name}
          tasks={projectTasks}
          locale={locale}
          t={t}
          onAddTask={onAddProjectTask}
          onToggleTask={onToggleProjectTask}
          onOpenTask={onOpenProjectTask}
          onDeleteTask={onDeleteProjectTask}
        />
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={(body) => setDraft((current) => ({ ...current, body }))} locale={locale} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onOpenBoard}><FolderKanban aria-hidden="true" />{t("project.action.open")}</button>
            {project.status === "done" || project.status === "archived" ? <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onReopen}><RotateCcw aria-hidden="true" />{t("project.action.reopen")}</button> : <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onComplete}><CheckCircle2 aria-hidden="true" />{t("project.action.complete")}</button>}
            {project.status !== "archived" && <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onArchive}><Archive aria-hidden="true" />{t("project.action.archive")}</button>}
            <DangerConfirmButton
              className="action-with-icon danger"
              armLabel={t("project.action.delete")}
              confirmLabel={t("confirm.deleteAgain")}
              onConfirm={onDelete}
            >{t("project.action.delete")}</DangerConfirmButton>
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

// Re-exported so callers can build project pickers next to this module.
export type { CreatedProject };
