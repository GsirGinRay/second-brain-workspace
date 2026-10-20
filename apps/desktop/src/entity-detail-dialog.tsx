import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Archive,
  BookPlus,
  Check,
  CheckCircle2,
  FolderKanban,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  attachmentFolderForProject,
  attachmentFolderForTask,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type TaskStatus,
  visibleTaskTitle,
} from "@second-brain/brain-core";
import { CategoryInput } from "./category-input";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import { ProjectPicker, type CreatedProject } from "./project-picker";
import { DangerConfirmButton } from "./danger-confirm";
import { TaskCompleteButton } from "./task-complete-button";
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
      // Mouse back/forward buttons navigate views; they must not replay a click.
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target || dialogRef.current?.contains(target)) return;
      if (target.closest(".delete-confirm-backdrop, .delete-confirm-dialog, .action-confirm-backdrop, .action-confirm-dialog")) return;
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

const DEFAULT_AUTOSAVE_DELAY_MS = 1200;
type AutosaveState = "saved" | "pending" | "saving" | "failed";

/**
 * Field-level rebase for a draft whose source changed underneath it (vault
 * watcher, sync, a board action): fields the user edited since `base` win,
 * every other field adopts `next`. Autosave then never writes a stale value
 * over an outside edit the user did not touch.
 */
export function rebaseDraft<T extends object>(base: T, draft: T, next: T): T {
  const result = { ...next };
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (!Object.is(draft[key], base[key])) result[key] = draft[key];
  }
  return result;
}

/**
 * Owns every write of a detail draft: a debounced autosave after the user
 * pauses, explicit saves that wait for an in-flight write instead of being
 * dropped, no retry loop after a failed write (the next edit retries), and a
 * final flush when the dialog unmounts without going through close.
 */
function useDraftPersistence<T>({
  draft,
  dirty,
  canSave,
  write,
  delayMs,
}: {
  draft: T;
  dirty: boolean;
  canSave: boolean;
  write: (draft: T) => Promise<boolean> | boolean;
  delayMs: number;
}): { save: () => Promise<boolean>; saving: boolean; state: AutosaveState } {
  const [saving, setSaving] = useState(false);
  const latestRef = useRef({ draft, dirty, canSave, write });
  latestRef.current = { draft, dirty, canSave, write };
  const inflightRef = useRef<Promise<boolean> | null>(null);
  const lastSavedRef = useRef<T | null>(null);
  const failedRef = useRef<T | null>(null);
  // Mirrors failedRef so a failed write re-renders the status even when the
  // saving flag flips on and off within one batch.
  const [failedDraft, setFailedDraft] = useState<T | null>(null);
  const mountedRef = useRef(true);

  const save = useCallback(async (): Promise<boolean> => {
    if (inflightRef.current) await inflightRef.current;
    const { draft: snapshot, canSave: allowed, write: persist } = latestRef.current;
    if (!allowed) return false;
    if (snapshot === lastSavedRef.current) return true;
    const run = (async () => {
      if (mountedRef.current) setSaving(true);
      try {
        const ok = await persist(snapshot);
        if (ok) {
          lastSavedRef.current = snapshot;
          failedRef.current = null;
        } else {
          failedRef.current = snapshot;
        }
        if (mountedRef.current) setFailedDraft(failedRef.current);
        return ok;
      } catch {
        failedRef.current = snapshot;
        if (mountedRef.current) setFailedDraft(snapshot);
        return false;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    })();
    inflightRef.current = run;
    try {
      return await run;
    } finally {
      if (inflightRef.current === run) inflightRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!dirty || !canSave || draft === lastSavedRef.current || draft === failedDraft) return;
    const timer = window.setTimeout(() => void save(), delayMs);
    return () => window.clearTimeout(timer);
  }, [draft, dirty, canSave, delayMs, save, failedDraft]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const { draft: pending, dirty: unsaved, canSave: allowed } = latestRef.current;
      if (unsaved && allowed && pending !== lastSavedRef.current && pending !== failedRef.current) void save();
    };
  }, [save]);

  const state: AutosaveState = saving
    ? "saving"
    : !dirty || draft === lastSavedRef.current
      ? "saved"
      : draft === failedDraft ? "failed" : "pending";
  return { save, saving, state };
}

function AutosaveStatus({ state, t }: { state: AutosaveState; t: DetailTranslate }) {
  return (
    <span className={`detail-autosave-status is-${state}`} role="status" aria-live="polite">
      {state === "saved" && <Check aria-hidden="true" />}
      {t(`detail.autosave.${state}`)}
    </span>
  );
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
  onSaveAsKnowledge,
  autosaveDelayMs = DEFAULT_AUTOSAVE_DELAY_MS,
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
  onSaveAsKnowledge?: (task: BrainTaskSnapshot) => void;
  autosaveDelayMs?: number;
}) {
  const normalized = useMemo(() => ({ ...task, title: visibleTaskTitle(task.title) }), [task]);
  const [draft, setDraft] = useState(normalized);
  const baseRef = useRef(normalized);
  useLayoutEffect(() => {
    const base = baseRef.current;
    baseRef.current = normalized;
    if (base === normalized) return;
    setDraft((current) => current.id === normalized.id ? rebaseDraft(base, current, normalized) : normalized);
  }, [normalized]);
  const dirty = visibleTaskTitle(draft.title) !== visibleTaskTitle(task.title)
    || (draft.body ?? "") !== (task.body ?? "")
    || draft.status !== task.status
    || draft.priority !== task.priority
    || draft.taskDate !== task.taskDate
    || draft.startTime !== task.startTime
    || draft.durationMinutes !== task.durationMinutes
    || draft.projectId !== task.projectId
    || draft.completedAt !== task.completedAt;
  const onBodyChange = useCallback((body: string) => {
    setDraft((current) => ({ ...current, body }));
  }, []);
  const chooseProject = (project: BrainProjectSnapshot | null) => {
    setDraft((current) => ({
      ...current,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    }));
  };
  const { save, saving, state: autosaveState } = useDraftPersistence({
    draft,
    dirty,
    canSave: Boolean(draft.title.trim()),
    write: (next) => onSave({ ...next, title: visibleTaskTitle(next.title) }),
    delayMs: autosaveDelayMs,
  });
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
  useSaveShortcut(() => void save());

  return (
    <DetailDialog title={visibleTaskTitle(task.title)} eyebrow="TASK" locale={locale} surface={surface} tabs={tabs} activeTabKey={activeTabKey} onRequestTabChange={requestTabChange} onCloseTab={onCloseTab} onRequestClose={requestClose}>
      <div className="detail-edit-form notion-editor">
        <div className="detail-title-row">
          <TaskCompleteButton
            size="lg"
            done={draft.status === "done"}
            label={t(draft.status === "done" ? "task.action.reopen" : "task.action.complete")}
            onClick={() => setDraft((current) => ({
              ...current,
              status: current.status === "done" ? "todo" : "done",
              completedAt: current.status === "done" ? null : current.completedAt,
            }))}
          />
          <textarea
            className="detail-title-input"
            aria-label={t("task.field.title")}
            value={draft.title}
            maxLength={500}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
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
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={onBodyChange} locale={locale} attachmentFolder={attachmentFolderForTask(draft.projectName)} maxAttachments={1} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <DangerConfirmButton
              className="icon-action"
              armLabel={t("task.action.delete")}
              confirmLabel={t("confirm.deleteAgain")}
              onConfirm={() => onDelete(task)}
            />
            {onSaveAsKnowledge && (
              <button
                type="button"
                className="secondary-button action-with-icon"
                onClick={() => onSaveAsKnowledge(draft)}
              >
                <BookPlus aria-hidden="true" />{t("knowledge.action.save")}
              </button>
            )}
          </div>
          <div>
            <AutosaveStatus state={autosaveState} t={t} />
            <button type="button" className="primary action-with-icon" disabled={!draft.title.trim() || saving} onClick={() => void requestClose()}><Check aria-hidden="true" />{t("detail.done")}</button>
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
        <button type="submit" className="detail-task-add" aria-label={t("project.tasks.create")} title={t("project.tasks.create")}>
          <Plus aria-hidden="true" />
        </button>
      </form>
      {tasks.length === 0 ? (
        <p className="detail-task-empty">{locale === "zh-TW" ? "這個專案還沒有未完成任務。" : "No open tasks in this project yet."}</p>
      ) : (
        <ul className="detail-task-list">
          {tasks.map((task) => (
            <li key={task.id ?? `${projectKey}:${task.rank}`}>
              <TaskCompleteButton
                done={task.status === "done"}
                label={`${task.title} ${task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}`}
                onClick={() => onToggleTask(task)}
              />
              <button
                type="button"
                className="detail-task-title"
                onClick={() => task.id && onOpenTask(task.id)}
                title={t("task.hint.editTitle")}
              >{visibleTaskTitle(task.title)}</button>
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
  relatedKnowledge = [],
  onOpenKnowledge,
  autosaveDelayMs = DEFAULT_AUTOSAVE_DELAY_MS,
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
  relatedKnowledge?: { id: string; name: string; category: string | null }[];
  onOpenKnowledge?: (id: string) => void;
  autosaveDelayMs?: number;
}) {
  const [draft, setDraft] = useState(project);
  const baseRef = useRef(project);
  useLayoutEffect(() => {
    const base = baseRef.current;
    baseRef.current = project;
    if (base === project) return;
    setDraft((current) => {
      if (current.id !== project.id) return project;
      // Completing/archiving from the board (or another tab) must replace a
      // stale draft; otherwise Save would overwrite the finished project.
      // Reactivating must also replace a stale done/archived draft, otherwise
      // Save or close would write the project back to archived.
      const terminal = (status: string) => status === "done" || status === "archived";
      if (current.status !== project.status && (terminal(project.status) || terminal(current.status))) {
        return project;
      }
      return rebaseDraft(base, current, project);
    });
  }, [project]);
  // Names are written trimmed, so compare trimmed to avoid a permanently dirty draft.
  const dirty = JSON.stringify({ ...draft, name: draft.name.trim() }) !== JSON.stringify(project);
  const { save, saving, state: autosaveState } = useDraftPersistence({
    draft,
    dirty,
    canSave: Boolean(draft.name.trim()),
    write: (next) => onSave({ ...next, name: next.name.trim() }),
    delayMs: autosaveDelayMs,
  });
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
        {onOpenKnowledge && (
          <section className="detail-task-section detail-knowledge-section">
            <header>
              <h3>{t("project.relatedKnowledge")}</h3>
              <small>{relatedKnowledge.length}</small>
            </header>
            {relatedKnowledge.length === 0 ? (
              <p className="detail-task-empty">{t("project.relatedKnowledge.empty")}</p>
            ) : (
              <ul className="detail-knowledge-list">
                {relatedKnowledge.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="detail-knowledge-title"
                      onClick={() => onOpenKnowledge(item.id)}
                    >{item.name}</button>
                    {item.category ? <small>{item.category}</small> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <MarkdownBlockEditor value={draft.body ?? ""} onChange={(body) => setDraft((current) => ({ ...current, body }))} locale={locale} attachmentFolder={attachmentFolderForProject(draft.name)} />
        <div className="detail-dialog-actions split-actions">
          <div>
            <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onOpenBoard}><FolderKanban aria-hidden="true" />{t("project.action.open")}</button>
            {project.status === "done" || project.status === "archived" ? <button type="button" className="secondary-button action-with-icon" data-reopen-project disabled={dirty} onClick={onReopen}><RotateCcw aria-hidden="true" />{t("project.action.reopen")}</button> : <button type="button" className="secondary-button action-with-icon" data-complete-project disabled={dirty} onClick={onComplete}><CheckCircle2 aria-hidden="true" />{t("project.action.complete")}</button>}
            {project.status !== "archived" && <button type="button" className="secondary-button action-with-icon" disabled={dirty} onClick={onArchive}><Archive aria-hidden="true" />{t("project.action.archive")}</button>}
            <DangerConfirmButton
              className="action-with-icon danger"
              armLabel={t("project.action.delete")}
              confirmLabel={t("confirm.deleteAgain")}
              onConfirm={onDelete}
            >{t("project.action.delete")}</DangerConfirmButton>
          </div>
          <div>
            <AutosaveStatus state={autosaveState} t={t} />
            <button type="button" className="primary action-with-icon" disabled={!draft.name.trim() || saving} onClick={() => void requestClose()}><Check aria-hidden="true" />{t("detail.done")}</button>
          </div>
        </div>
      </div>
    </DetailDialog>
  );
}

// Re-exported so callers can build project pickers next to this module.
export type { CreatedProject };
