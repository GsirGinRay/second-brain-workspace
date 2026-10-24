import {
  applyRoutineTemplate,
  rankForIndex,
  splitTodayTasks,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type RoutineTemplate,
  type RoutineTemplateItem,
} from "@second-brain/brain-core";
import {
  BarChart3,
  GripVertical,
  Moon,
  Plus,
  Settings2,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CompletedVisibilityButton, Empty, InlineTaskCard, newTask, taipeiDateKey, useUiPreferences } from "./app-shared";
import { DaySchedule } from "./day-schedule-view";
import { GLOBAL_SELECTION_DELETE_EVENT, getGlobalSelectedIds } from "./global-shift-marquee";
import {
  applyTaskPriority,
  completedForDate,
  markMostImportant,
  priorityDisplay,
  scheduleTask,
  scheduleTaskBatch,
  toggleMostImportant,
} from "./task-actions";
import {
  reorderTodayTrayBatch,
  todayTraySegmentKey,
  withReassignedRanks,
} from "./task-reorder";
import { AVAILABLE_HOURS_KEY, focusQueue, loadAvailableHours, moveTasksToDate } from "./today-planning";
import { FocusMode, LoadMeter, WaitingPanel, WrapUpDialog } from "./today-tools";
import { WeeklyReviewDialog } from "./weekly-review-ui";

export function Today({ tasks, projects, showCompleted, onShowCompletedChange, onSave, onDelete, onOpenTask, onQuickAdd, onCreateProject, routineTemplate, onRoutineTemplateChange }: {
  tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void | Promise<boolean>; onDelete: (task: BrainTaskSnapshot) => void; onOpenTask: (taskId: string) => void; onQuickAdd: () => void;
  onCreateProject?: (name: string) => Promise<{ id: string; name: string } | null>;
  routineTemplate: RoutineTemplate; onRoutineTemplateChange: (template: RoutineTemplate) => void;
}) {
  const { t, preferences } = useUiPreferences();
  const today = taipeiDateKey();
  const groups = splitTodayTasks(tasks, projects, today);
  const completed = completedForDate(tasks, today);
  const scheduled = [
    ...groups.today.filter((task) => task.startTime),
    ...(showCompleted ? completed.filter((task) => task.startTime && task.taskDate === today) : []),
  ].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const trayTasks = [
    ...groups.overdue,
    ...groups.today.filter((task) => !task.startTime),
  ];
  const [templateOpen, setTemplateOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [wrapUpOpen, setWrapUpOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [availableHours, setAvailableHours] = useState(() => loadAvailableHours(localStorage));
  const changeAvailableHours = (hours: number) => {
    setAvailableHours(hours);
    try { localStorage.setItem(AVAILABLE_HOURS_KEY, String(hours)); } catch { /* applies for this session */ }
  };
  const loadTasks = groups.today.filter((task) => task.taskDate === today && task.status !== "waiting");
  const [notice, setNotice] = useState("");
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const draggedItems = useRef<string[]>([]);
  const [dragHandleId, setDragHandleId] = useState<string | null>(null);
  const clock = useMemo(() => new Date(), [today]);
  const patchTask = (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => {
    const changed = tasks.map((item) => item.id === task.id ? { ...item, ...patch } : item);
    return onSave(patch.priority === "highest" && task.id ? markMostImportant(changed, task.id, today) : changed);
  };
  const complete = (task: BrainTaskSnapshot) => patchTask(task, { status: task.status === "done" ? "todo" : "done", completedAt: task.status === "done" ? null : today });
  const startToday = () => {
    const result = applyRoutineTemplate(routineTemplate, tasks, today);
    if (result.created.length) onSave(result.tasks);
    setNotice(result.created.length ? `已建立 ${result.created.length} 項今日例行任務` : "今天的例行任務都已建立");
  };
  // Setting a row to P1 demotes whichever row already held it, mirroring markMostImportant: a day owns one P1.
  const updateItem = (id: string, patch: Partial<RoutineTemplateItem>) => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.map((item) => item.id === id ? { ...item, ...patch } : patch.priority === "highest" && item.priority === "highest" ? { ...item, priority: "high" as const } : item) });
  const dropItem = (targetId: string) => {
    if (!draggedItem || draggedItem === targetId) return;
    const selectedIds = new Set(draggedItems.current.length ? draggedItems.current : [draggedItem]);
    if (selectedIds.has(targetId)) return;
    const moved = routineTemplate.items.filter((item) => selectedIds.has(item.id));
    const remaining = routineTemplate.items.filter((item) => !selectedIds.has(item.id));
    const to = remaining.findIndex((item) => item.id === targetId);
    const items = [...remaining.slice(0, to), ...moved, ...remaining.slice(to)];
    onRoutineTemplateChange({ ...routineTemplate, items: items.map((item, index) => ({ ...item, rank: rankForIndex(index) })) });
    setDraggedItem(null);
    draggedItems.current = [];
  };
  const important = groups.today.find((task) => task.priority === "highest") ?? null;
  const pickProject = (taskId: string, project: { id: string | null; name: string } | null) => {
    onSave(tasks.map((item) => item.id === taskId
      ? { ...item, projectId: project?.id ?? null, projectName: project?.name ?? null }
      : item));
  };
  // Batch delete shared by the Delete key and the global marquee event. After
  // a box-selection the keyboard focus usually sits on <body>, outside the
  // React tree, so the Today view listens for the marquee's delete event.
  const removeSelectedTasks = (ids: readonly string[]) => {
    const targets = new Set(ids);
    if (targets.size === 0) return;
    setNotice(preferences.language === "zh-TW" ? `已刪除 ${targets.size} 項任務` : `Removed ${targets.size} tasks`);
    onSave(tasks.filter((task) => task.id ? !targets.has(task.id) : true));
  };
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ ids: string[]; kind: string }>).detail;
      if (!detail || detail.kind !== "task") return;
      removeSelectedTasks(detail.ids);
    };
    window.addEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
    return () => window.removeEventListener(GLOBAL_SELECTION_DELETE_EVENT, handler as EventListener);
  });
  return <section className="command-center">
    <header className="command-hero"><div><span className="eyebrow">{t("today.eyebrow", { date: today })}</span><h2>{t("today.heading")}</h2><p>{t("today.description")}</p></div><div className="hero-actions"><CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} /><button className="secondary-button" onClick={() => setTemplateOpen((open) => !open)} aria-expanded={templateOpen}><Settings2 />{t(templateOpen ? "today.template.collapse" : "today.template.manage")}</button><button className="secondary-button" onClick={() => setReviewOpen(true)}><BarChart3 />{t("review.open")}</button><button className="secondary-button" onClick={() => setWrapUpOpen(true)}><Moon />{t("today.wrap.open")}</button><button className="secondary-button" disabled={focusQueue(groups.today, groups.overdue).length === 0} onClick={() => setFocusOpen(true)}><Target />{t("today.focus.open")}</button><button className="primary start-day-button" onClick={startToday}><Plus />{t("today.start")}</button></div></header>
    {notice && <div className="routine-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="關閉提示"><X /></button></div>}
    <div className="command-summary"><article className="focus-summary"><span>今日最重要</span><strong>{important?.title ?? "尚未選定"}</strong><small>{important?.projectName ?? "在今日任務按下星號選定"}</small></article><article><span>逾期</span><strong>{groups.overdue.length}</strong><small>需要重新決定日期</small></article><article><span>今天</span><strong>{groups.today.length}</strong><small>{scheduled.length} 項已排時間</small></article><LoadMeter tasks={loadTasks} availableHours={availableHours} language={preferences.language} t={t} onAvailableHoursChange={changeAvailableHours} /></div>
    {groups.today.length === 0 && groups.overdue.length === 0 && (
      <Empty text={t("today.empty")} actionLabel={t("today.emptyAction")} onAction={onQuickAdd} />
    )}
    {templateOpen && <section className="routine-editor"><header><div><span className="eyebrow">DAILY ROUTINE</span><input aria-label="模板名稱" value={routineTemplate.name} onChange={(event) => onRoutineTemplateChange({ ...routineTemplate, name: event.target.value })} /></div><button onClick={() => setTemplateOpen(false)} aria-label="關閉模板"><X /></button></header><div className="routine-items">{routineTemplate.items.map((item) => <article key={item.id} data-global-select-id={item.id} data-global-select-kind="routine" draggable={dragHandleId === item.id} onDragStart={() => { setDraggedItem(item.id); draggedItems.current = getGlobalSelectedIds(item.id, "routine"); }} onDragEnd={() => { setDragHandleId(null); draggedItems.current = []; }} onMouseUp={() => setDragHandleId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropItem(item.id)}><GripVertical onMouseDown={() => setDragHandleId(item.id)} /><input type="checkbox" aria-label={`${item.title}啟用`} checked={item.enabled} onChange={(event) => updateItem(item.id, { enabled: event.target.checked })} /><input aria-label="例行任務名稱" value={item.title} onChange={(event) => updateItem(item.id, { title: event.target.value })} /><select aria-label="例行任務專案" value={item.projectId ?? ""} onChange={(event) => { const project = projects.find((value) => value.id === event.target.value); updateItem(item.id, { projectId: project?.id ?? null, projectName: project?.name ?? null }); }}><option value="">無專案</option>{projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}</select><select aria-label="例行任務優先度" value={item.priority} onChange={(event) => updateItem(item.id, { priority: event.target.value as RoutineTemplateItem["priority"] })}>{(["highest","high","medium","normal","low"] as const).map((value) => <option key={value} value={value}>{priorityDisplay(value).code}</option>)}</select><input aria-label="開始時間" type="time" value={item.startTime ?? ""} onChange={(event) => updateItem(item.id, { startTime: event.target.value || null, durationMinutes: event.target.value ? item.durationMinutes ?? 30 : null })} /><select aria-label="持續時間" disabled={!item.startTime} value={item.durationMinutes ?? 30} onChange={(event) => updateItem(item.id, { durationMinutes: Number(event.target.value) })}>{[15,30,45,60,90,120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分</option>)}</select><button className="danger-icon" aria-label={`刪除${item.title}`} onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.filter((value) => value.id !== item.id) })}><Trash2 /></button></article>)}</div><button className="secondary" onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: [...routineTemplate.items, { id: crypto.randomUUID(), title: "新的例行任務", enabled: true, projectId: null, projectName: null, priority: "normal", startTime: null, durationMinutes: null, rank: rankForIndex(routineTemplate.items.length) }] })}><Plus />新增模板項目</button></section>}
    <section className="timeline-section">
      <header>
        <div>
          <span className="eyebrow">TODAY TIMELINE</span>
          <h3>{t("today.timeline")}</h3>
        </div>
        <button className="secondary icon-action" aria-label={t("app.quickAdd")} title={t("app.quickAdd")} onClick={onQuickAdd}><Plus /></button>
      </header>
      <DaySchedule
        date={today}
        timedTasks={scheduled}
        trayTasks={trayTasks}
        showTray
        now={clock}
        labels={{
          unscheduled: t("today.unscheduled"),
          dropToSchedule: t("today.dropToSchedule"),
          addAtTime: (time) => t("today.addAtTime", { time }),
          empty: t("today.empty"),
          editTitle: t("task.hint.editTitle"),
          editPriority: t("task.hint.editPriority"),
          complete: t("task.action.complete"),
          reopen: t("task.action.reopen"),
          delete: t("task.action.delete"),
          resize: t("today.resizeDuration"),
          important: t("task.action.important"),
          deleteAgain: t("confirm.deleteAgain"),
        }}
        locale={preferences.language}
        projects={projects}
        onSchedule={(taskId, startTime) => onSave(tasks.map((item) => item.id === taskId ? scheduleTask(item, today, startTime) : item))}
        onScheduleBatch={(taskIds, startTime) => onSave(scheduleTaskBatch(tasks, taskIds, today, startTime))}
        onClearTime={(taskId) => onSave(tasks.map((item) => item.id === taskId ? scheduleTask(item, item.taskDate ?? today, null) : item))}
        onClearTimeBatch={(taskIds) => onSave(tasks.map((item) => item.id && taskIds.includes(item.id) ? scheduleTask(item, item.taskDate ?? today, null) : item))}
        onCreateAt={(title, startTime) => onSave([...tasks, newTask(title, { taskDate: today, startTime, durationMinutes: 30 })])}
        onOpenTask={onOpenTask}
        onPriority={(taskId, priority) => onSave(applyTaskPriority(tasks, taskId, priority, today))}
        onStar={(taskId) => onSave(toggleMostImportant(tasks, taskId, today))}
        onPickProject={pickProject}
        onCreateProject={onCreateProject}
        onDelete={onDelete}
        onDeleteBatch={(selectedTasks) => removeSelectedTasks(selectedTasks.flatMap((task) => task.id ? [task.id] : []))}
        onComplete={(task) => complete(task)}
        onResize={(taskId, durationMinutes) => onSave(tasks.map((item) => item.id === taskId ? { ...item, durationMinutes } : item))}
        onReorderTray={({ draggedId, targetId, place, draggedIds }) => {
          // A vertical drop reorders inside the dragged task's priority/date
          // group; ranks of just that group are rewritten so the order
          // persists to Markdown. With a marquee selection the whole group
          // travels as one batch (inside the dragged task's own group).
          const ids = draggedIds?.length ? draggedIds : [draggedId];
          const ordered = reorderTodayTrayBatch(trayTasks, today, ids, targetId, place);
          if (!ordered) return;
          const dragged = tasks.find((item) => item.id === draggedId);
          if (!dragged) return;
          const key = todayTraySegmentKey(dragged, today);
          const segmentIds = ordered
            .filter((item) => todayTraySegmentKey(item, today) === key)
            .map((item) => item.id);
          onSave(withReassignedRanks(tasks, segmentIds));
        }}
      />
    </section>
    <WaitingPanel tasks={tasks} today={today} t={t} onOpenTask={onOpenTask} onReceived={(task) => patchTask(task, { status: "done", completedAt: today })} />
    {focusOpen && <FocusMode queue={focusQueue(groups.today, groups.overdue)} language={preferences.language} t={t} onComplete={complete} onOpenTask={(taskId) => { setFocusOpen(false); onOpenTask(taskId); }} onClose={() => setFocusOpen(false)} />}
    {reviewOpen && <WeeklyReviewDialog tasks={tasks} today={today} language={preferences.language} t={t} onClose={() => setReviewOpen(false)} />}
    {wrapUpOpen && <WrapUpDialog tasks={tasks} today={today} t={t} onMove={(ids, date) => { onSave(moveTasksToDate(tasks, ids, date)); setNotice(t("today.wrap.moved", { count: ids.size })); }} onClose={() => setWrapUpOpen(false)} />}
    <button className="today-quick-add-fab" type="button" onClick={onQuickAdd} aria-label={t("app.quickAdd")} title={t("app.quickAdd")}><Plus aria-hidden="true" /></button>
    {showCompleted && completed.length > 0 && <details className="completed-section"><summary>今日已完成 · {completed.length} 項</summary><div className="focus-task-list">{completed.map((task) => <InlineTaskCard key={task.id ?? task.title} task={task} today={today} projects={projects} onOpen={onOpenTask} onPatch={patchTask} onComplete={complete} onDelete={onDelete} onPickProject={pickProject} onCreateProject={onCreateProject} />)}</div></details>}
  </section>;
}
