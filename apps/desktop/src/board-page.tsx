import {
  rankForIndex,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  CheckCircle2,
  Columns3,
  GripVertical,
  List,
  Plus,
  RotateCcw,
  Star,
  Table2,
} from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BOARD_LANE_ORDER, BOARD_PRIORITY_ORDER, CompletedVisibilityButton, TaskDateInput, newTask, taipeiDateKey, taskLabel, taskProjectStyle, useUiPreferences } from "./app-shared";
import { DangerConfirmButton } from "./danger-confirm";
import { getGlobalSelectedIds } from "./global-shift-marquee";
import { PriorityControl } from "./priority-control";
import {
  applyTaskPriority,
  boardLane,
  moveTaskToLane,
  toggleMostImportant,
  type BoardLane,
} from "./task-actions";
import { TaskBadges } from "./task-badges";
import { TaskCompleteButton } from "./task-complete-button";
import {
  type UiLanguage,
} from "./ui-preferences";

export type BoardViewMode = "board" | "table" | "list";

export type BoardSortKey = "rank" | "title" | "status" | "project" | "date" | "priority";

export const BOARD_VIEW_KEY = "second-brain.boardView";

export function readBoardViewMode(): BoardViewMode {
  try {
    const saved = localStorage.getItem(BOARD_VIEW_KEY);
    return saved === "table" || saved === "list" ? saved : "board";
  } catch {
    return "board";
  }
}

export function compareBoardTasks(left: BrainTaskSnapshot, right: BrainTaskSnapshot, key: BoardSortKey, language: UiLanguage): number {
  const byRank = left.rank.localeCompare(right.rank);
  if (key === "title") return taskLabel(left).localeCompare(taskLabel(right), language) || byRank;
  if (key === "status") return (BOARD_LANE_ORDER[boardLane(left)] - BOARD_LANE_ORDER[boardLane(right)]) || byRank;
  if (key === "project") return (left.projectName ?? "").localeCompare(right.projectName ?? "", language) || byRank;
  if (key === "date") return (left.taskDate ?? "9999-12-31").localeCompare(right.taskDate ?? "9999-12-31") || byRank;
  if (key === "priority") return (BOARD_PRIORITY_ORDER[left.priority] - BOARD_PRIORITY_ORDER[right.priority]) || byRank;
  return byRank;
}

export function Board({
  tasks,
  projects,
  showCompleted,
  onShowCompletedChange,
  onSave,
  onDelete,
  onOpenTask,
  selectedProjectId,
  onProjectFilterChange,
  onBackToProjects,
  onQuickAdd,
  onCompleteProject,
  onReopenProject,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  selectedProjectId: string | null;
  onProjectFilterChange: (projectId: string | null) => void;
  onBackToProjects: () => void;
  onQuickAdd: () => void;
  onCompleteProject?: () => void;
  onReopenProject?: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [drag, setDrag] = useState<string | null>(null);
  const boardDrag = useRef<{ id: string; ids: string[]; x: number; y: number; moved: boolean } | null>(null);
  const [composingLane, setComposingLane] = useState<BoardLane | null>(null);
  const [viewMode, setViewMode] = useState<BoardViewMode>(() => readBoardViewMode());
  const [sortKey, setSortKey] = useState<BoardSortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const today = taipeiDateKey();
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const setBoardView = (mode: BoardViewMode) => {
    setViewMode(mode);
    setComposingLane(null);
    localStorage.setItem(BOARD_VIEW_KEY, mode);
  };
  const lanes: Array<{ id: BoardLane; label: string; hint: string }> = [
    { id: "idea", label: t("task.status.idea"), hint: t("task.status.ideaHelp") },
    { id: "todo", label: t("task.status.todo"), hint: t("task.status.todoHelp") },
    { id: "doing", label: t("task.status.doing"), hint: t("task.status.doingHelp") },
    { id: "waiting", label: t("task.status.waiting"), hint: t("task.status.waitingHelp") },
    { id: "done", label: t("task.status.done"), hint: t("task.status.doneHelp") },
  ];
  const filtered = tasks.filter(
    (task) => !selectedProjectId || task.projectId === selectedProjectId,
  );
  const moveToLane = (id: string | null, lane: BoardLane) => {
    if (id)
      void onSave(
        tasks.map((task) =>
          task.id === id ? moveTaskToLane(task, lane, today) : task,
        ),
      );
  };
  const moveSelectionToLane = (ids: readonly string[], lane: BoardLane) => {
    const selected = new Set(ids);
    void onSave(tasks.map((task) => task.id && selected.has(task.id) ? moveTaskToLane(task, lane, today) : task));
  };
  // The per-lane “＋” creates a task directly in that lane, honouring the lane's
  // semantics (idea inbox keeps no date) and the active project filter.
  const createInLane = (lane: BoardLane, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const base = newTask(trimmed, { taskDate: undefined });
    const placed = moveTaskToLane(base, lane, today);
    const bound = selectedProjectId && !placed.projectId
      ? (() => {
          const project = projects.find((item) => item.id === selectedProjectId);
          return { ...placed, projectId: project?.id ?? null, projectName: project?.name ?? null };
        })()
      : placed;
    void onSave([...tasks, bound]);
  };
  const finishBoardPointer = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const origin = boardDrag.current;
    boardDrag.current = null;
    setDrag(null);
    if (!origin?.moved) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const lane = target?.closest<HTMLElement>("[data-board-lane]")?.dataset.boardLane as BoardLane | undefined;
    if (lane) moveSelectionToLane(origin.ids, lane);
  };
  const moveWithinColumn = (id: string | null, delta: -1 | 1) => {
    if (!id) return;
    const active = tasks.find((task) => task.id === id);
    if (!active) return;
    const ordered = tasks
      .filter((task) => boardLane(task) === boardLane(active))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    const from = ordered.findIndex((task) => task.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    const ranks = new Map(
      ordered.map((task, index) => [task.id, rankForIndex(index)]),
    );
    void onSave(
      tasks.map((task) =>
        ranks.has(task.id) ? { ...task, rank: ranks.get(task.id)! } : task,
      ),
    );
  };
  const visibleLanes = lanes.filter((lane) => lane.id !== "done" || showCompleted);
  const tableTasks = [...filtered]
    .filter((task) => showCompleted || boardLane(task) !== "done")
    .sort((left, right) => {
      const compared = compareBoardTasks(left, right, sortKey, preferences.language);
      return sortDir === "asc" ? compared : -compared;
    });
  const toggleSort = (key: BoardSortKey) => {
    if (sortKey === key) setSortDir((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };
  const sortMark = (key: BoardSortKey) => sortKey === key ? (sortDir === "asc" ? " \u2191" : " \u2193") : "";
  const viewDescription = selectedProject
    ? t("board.filteredDescription")
    : viewMode === "table"
      ? t("board.table.description")
      : viewMode === "list"
        ? t("board.list.description")
        : t("board.description");
  const laneComposer = (lane: BoardLane) => (
    <form
      className="lane-composer"
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.querySelector("input");
        createInLane(lane, input?.value ?? "");
        if (input) input.value = "";
        setComposingLane(null);
      }}
    >
      <input
        autoFocus
        aria-label={t("board.lane.placeholder")}
        placeholder={t("board.lane.placeholder")}
        onBlur={(event) => {
          createInLane(lane, event.target.value);
          setComposingLane(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setComposingLane(null);
        }}
      />
    </form>
  );
  return (
    <section data-global-marquee-scope="board" data-board-view={viewMode}>
      <div className="board-toolbar">
        <div>
          <h2>{selectedProject ? t("board.filteredTitle", { name: selectedProject.name }) : t("board.title")}</h2>
          <p>{viewDescription}</p>
        </div>
        <div>
          <div className="segmented-control icon-segmented-control" aria-label={t("board.view")}>
            <button type="button" className={viewMode === "board" ? "active" : ""} data-board-view-option="board" aria-label={t("board.view.board")} title={t("board.view.board")} onClick={() => setBoardView("board")}><Columns3 aria-hidden="true" /></button>
            <button type="button" className={viewMode === "table" ? "active" : ""} data-board-view-option="table" aria-label={t("board.view.table")} title={t("board.view.table")} onClick={() => setBoardView("table")}><Table2 aria-hidden="true" /></button>
            <button type="button" className={viewMode === "list" ? "active" : ""} data-board-view-option="list" aria-label={t("board.view.list")} title={t("board.view.list")} onClick={() => setBoardView("list")}><List aria-hidden="true" /></button>
          </div>
          {selectedProject && <button className="secondary-button" onClick={onBackToProjects}>{t("board.back")}</button>}
          {selectedProject && selectedProject.status !== "done" && selectedProject.status !== "archived" && onCompleteProject && (
            <button type="button" className="secondary-button action-with-icon" data-complete-project onClick={onCompleteProject} aria-label={t("project.action.complete")} title={t("project.action.complete")}>
              <CheckCircle2 aria-hidden="true" />{t("project.action.complete")}
            </button>
          )}
          {selectedProject && (selectedProject.status === "done" || selectedProject.status === "archived") && onReopenProject && (
            <button type="button" className="secondary-button action-with-icon" data-reopen-project onClick={onReopenProject} aria-label={t("project.action.reopen")} title={t("project.action.reopen")}>
              <RotateCcw aria-hidden="true" />{t("project.action.reopen")}
            </button>
          )}
          {selectedProject && (
            <button type="button" className="primary action-with-icon" onClick={onQuickAdd} aria-label={t("project.tasks.create")} title={t("project.tasks.create")}>
              <Plus aria-hidden="true" />{t("project.tasks.create")}
            </button>
          )}
          <select
            aria-label={t("board.projectFilter")}
            value={selectedProjectId ?? "all"}
            onChange={(event) => onProjectFilterChange(event.target.value === "all" ? null : event.target.value)}
          >
            <option value="all">{t("board.allProjects")}</option>
            {projects.filter((project) => project.id).sort((a, b) => a.name.localeCompare(b.name)).map((project) => (
              <option key={project.id!} value={project.id!}>
                {project.name}
              </option>
            ))}
          </select>
          <CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} />
        </div>
      </div>
      {viewMode === "table" ? (
        <div className="board-table-wrap">
          <table className="board-table">
            <thead>
              <tr>
                <th aria-hidden="true" />
                <th aria-sort={sortKey === "title" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("title")}>{t("task.field.title")}{sortMark("title")}</button>
                </th>
                <th aria-sort={sortKey === "status" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("status")}>{t("task.field.status")}{sortMark("status")}</button>
                </th>
                <th aria-sort={sortKey === "project" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("project")}>{t("task.field.project")}{sortMark("project")}</button>
                </th>
                <th aria-sort={sortKey === "date" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("date")}>{t("task.field.date")}{sortMark("date")}</button>
                </th>
                <th aria-sort={sortKey === "priority" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" onClick={() => toggleSort("priority")}>{t("task.field.priority")}{sortMark("priority")}</button>
                </th>
              </tr>
            </thead>
            <tbody>
              {tableTasks.map((task) => (
                <tr
                  key={task.id ?? task.title}
                  data-global-select-id={task.id ?? undefined}
                  className={`${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                  style={taskProjectStyle(task)}
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("button,input,select,textarea,a") && task.id) onOpenTask(task.id);
                  }}
                >
                  <td>
                    <TaskCompleteButton
                      done={task.status === "done"}
                      label={task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                      onClick={() => moveToLane(task.id, task.status === "done" ? "todo" : "done")}
                    />
                  </td>
                  <td>
                    <button type="button" className="board-table-title" onClick={() => task.id && onOpenTask(task.id)}>{taskLabel(task)}</button>
                  </td>
                  <td>
                    <select
                      aria-label={`${task.title} ${t("task.field.status")}`}
                      value={boardLane(task)}
                      onChange={(event) => moveToLane(task.id, event.target.value as BoardLane)}
                    >
                      {lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${task.title} ${t("task.field.project")}`}
                      value={task.projectId ?? ""}
                      onChange={(event) => {
                        const project = projects.find((item) => item.id === event.target.value);
                        void onSave(tasks.map((item) => item.id === task.id ? { ...item, projectId: project?.id ?? null, projectName: project?.name ?? null } : item));
                      }}
                    >
                      <option value="">{t("app.unassigned")}</option>
                      {projects.filter((project) => project.id).sort((a, b) => a.name.localeCompare(b.name)).map((project) => (
                        <option key={project.id!} value={project.id!}>{project.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <TaskDateInput
                      className="board-date-input"
                      ariaLabel={`${t("task.field.date")} ${task.title}`}
                      value={task.taskDate ?? null}
                      onCommit={(next) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, taskDate: next } : item))}
                    />
                  </td>
                  <td>
                    <PriorityControl
                      priority={task.priority}
                      compact
                      locale={preferences.language}
                      onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, task.taskDate ?? today))}
                    />
                  </td>
                </tr>
              ))}
              <tr className="board-table-composer-row">
                <td colSpan={6}>
                  {composingLane === "todo" ? laneComposer("todo") : (
                    <button type="button" className="board-table-add" onClick={() => setComposingLane("todo")}>{t("board.lane.placeholder")}</button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : viewMode === "list" ? (
        <div className="board-list">
          {visibleLanes.map((lane) => {
            const laneTasks = filtered
              .filter((task) => boardLane(task) === lane.id)
              .sort((a, b) => a.rank.localeCompare(b.rank));
            return (
              <section
                className={`board-list-group lane-${lane.id} ${drag ? "drag-active" : ""}`}
                key={lane.id}
                data-board-lane={lane.id}
              >
                <header>
                  <span className={`dot ${lane.id}`} />
                  <div>
                    <strong>{lane.label}</strong>
                    <em>{lane.hint}</em>
                  </div>
                  {lane.id !== "done" && (
                    <button
                      type="button"
                      className="lane-add-button"
                      aria-label={`${t("board.lane.add")} \u00b7 ${lane.label}`}
                      title={t("board.lane.add")}
                      onClick={() => setComposingLane((current) => current === lane.id ? null : lane.id)}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  )}
                  <small>{laneTasks.length}</small>
                </header>
                {composingLane === lane.id && laneComposer(lane.id)}
                {laneTasks.length === 0 && (
                  <div className="lane-empty">{t("board.dropHere")}</div>
                )}
                {laneTasks.map((task) => (
                  <article
                    key={task.id ?? task.title}
                    className={`board-list-row ${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                    style={taskProjectStyle(task)}
                    data-global-select-id={task.id ?? undefined}
                    tabIndex={0}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !task.id || !(event.target as HTMLElement).closest("[data-drag-handle]")) return;
                      boardDrag.current = { id: task.id, ids: getGlobalSelectedIds(task.id), x: event.clientX, y: event.clientY, moved: false };
                      setDrag(task.id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!boardDrag.current) return;
                      if (Math.abs(event.clientX - boardDrag.current.x) > 4 || Math.abs(event.clientY - boardDrag.current.y) > 4) {
                        boardDrag.current = { ...boardDrag.current, moved: true };
                      }
                    }}
                    onPointerUp={(event) => finishBoardPointer(event, task.id)}
                    onPointerCancel={() => { boardDrag.current = null; setDrag(null); }}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button,input,select,textarea,a") && task.id) onOpenTask(task.id);
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && !event.altKey && task.id) {
                        event.preventDefault();
                        onOpenTask(task.id);
                      }
                    }}
                  >
                    <button type="button" className="board-drag-handle" data-drag-handle aria-label={`${t("board.view.list")} ${task.title}`} onClick={(event) => event.stopPropagation()}>
                      <GripVertical aria-hidden="true" />
                    </button>
                    <TaskCompleteButton
                      done={task.status === "done"}
                      label={task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                      onClick={() => moveToLane(task.id, task.status === "done" ? "todo" : "done")}
                    />
                    <PriorityControl
                      priority={task.priority}
                      compact
                      locale={preferences.language}
                      onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, task.taskDate ?? today))}
                    />
                    <strong className="board-inline-title">{taskLabel(task)}</strong>
                    <small>{task.projectName ?? t("app.unassigned")}</small>
                    <div className="board-date-field" onPointerDown={(event) => event.stopPropagation()}>
                      <TaskDateInput
                        className="board-date-input"
                        ariaLabel={`${t("task.field.date")} ${task.title}`}
                        value={task.taskDate ?? null}
                        onCommit={(next) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, taskDate: next } : item))}
                      />
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      ) : (
      <div className="board five-lanes">
        {visibleLanes
          .map((lane) => {
            const laneTasks = filtered
              .filter((task) => boardLane(task) === lane.id)
              .sort((a, b) => a.rank.localeCompare(b.rank));
            return (
              <section
                className={`board-column lane-${lane.id} ${drag ? "drag-active" : ""}`}
                key={lane.id}
                data-board-lane={lane.id}
              >
                <header>
                  <span className={`dot ${lane.id}`} />
                  <div>
                    <strong>{lane.label}</strong>
                    <em>{lane.hint}</em>
                  </div>
                  {lane.id !== "done" && (
                    <button
                      type="button"
                      className="lane-add-button"
                      aria-label={`${t("board.lane.add")} · ${lane.label}`}
                      title={t("board.lane.add")}
                      onClick={() => setComposingLane((current) => current === lane.id ? null : lane.id)}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  )}
                  <small>{laneTasks.length}</small>
                </header>
                {composingLane === lane.id && (
                  <form
                    className="lane-composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const input = event.currentTarget.querySelector("input");
                      createInLane(lane.id, input?.value ?? "");
                      if (input) input.value = "";
                      setComposingLane(null);
                    }}
                  >
                    <input
                      autoFocus
                      aria-label={t("board.lane.placeholder")}
                      placeholder={t("board.lane.placeholder")}
                      onBlur={(event) => {
                        // Blur with text still commits — stray clicks never eat a task.
                        createInLane(lane.id, event.target.value);
                        setComposingLane(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setComposingLane(null);
                      }}
                    />
                  </form>
                )}
                {laneTasks.length === 0 && (
                  <div className="lane-empty">{t("board.dropHere")}</div>
                )}
                {laneTasks.map((task) => (
                  <article
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !task.id || !(event.target as HTMLElement).closest("[data-drag-handle]")) return;
                      boardDrag.current = { id: task.id, ids: getGlobalSelectedIds(task.id), x: event.clientX, y: event.clientY, moved: false };
                      setDrag(task.id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!boardDrag.current) return;
                      if (Math.abs(event.clientX - boardDrag.current.x) > 4 || Math.abs(event.clientY - boardDrag.current.y) > 4) {
                        boardDrag.current = { ...boardDrag.current, moved: true };
                      }
                    }}
                    onPointerUp={(event) => finishBoardPointer(event, task.id)}
                    onPointerCancel={() => { boardDrag.current = null; setDrag(null); }}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button,input,select,textarea,a") && task.id) onOpenTask(task.id);
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && !event.altKey && task.id) {
                        event.preventDefault();
                        onOpenTask(task.id);
                        return;
                      }
                      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                      event.preventDefault();
                      const index = lanes.findIndex((item) => item.id === boardLane(task));
                      const next = lanes[index + (event.key === "ArrowRight" ? 1 : -1)];
                      if (next) moveToLane(task.id, next.id);
                    }}
                    style={taskProjectStyle(task)}
                    data-global-select-id={task.id ?? undefined}
                    className={`board-card ${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                    key={task.id ?? task.title}
                    tabIndex={0}
                  >
                    <div className="task-title-row">
                      <button type="button" className="board-drag-handle" data-drag-handle aria-label={`拖曳 ${task.title}`} onClick={(event) => event.stopPropagation()}>
                        <GripVertical aria-hidden="true" />
                      </button>
                      <TaskCompleteButton
                        done={task.status === "done"}
                        label={task.status === "done" ? t("task.action.reopen") : t("task.action.complete")}
                        onClick={() => moveToLane(task.id, task.status === "done" ? "todo" : "done")}
                      />
                      <PriorityControl
                        priority={task.priority}
                        compact
                        locale={preferences.language}
                        onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, task.taskDate ?? today))}
                      />
                      <strong className="board-inline-title">{taskLabel(task)}</strong>
                    </div>
                    {task.projectName && <small>{task.projectName}</small>}
                    <TaskBadges task={task} locale={preferences.language} />
                    <div className="board-date-field" onPointerDown={(event) => event.stopPropagation()}>
                      <TaskDateInput
                        className="board-date-input"
                        ariaLabel={`修改 ${task.title} 日期`}
                        value={task.taskDate ?? null}
                        onCommit={(next) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, taskDate: next } : item))}
                      />
                    </div>
                    {task.id && (
                      <div
                        className="board-card-inline-actions"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className={`board-card-icon ${task.priority === "highest" ? "active" : ""}`}
                          aria-label={t("task.action.important")}
                          title={t("task.action.important")}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (task.id) void onSave(toggleMostImportant(tasks, task.id, today));
                          }}
                        >
                          <Star aria-hidden="true" fill={task.priority === "highest" ? "currentColor" : "none"} />
                        </button>
                        <button
                          type="button"
                          className="board-card-icon"
                          aria-label={t("board.moveUp")}
                          title={t("board.moveUp")}
                          onClick={() => moveWithinColumn(task.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="board-card-icon"
                          aria-label={t("board.moveDown")}
                          title={t("board.moveDown")}
                          onClick={() => moveWithinColumn(task.id, 1)}
                        >
                          ↓
                        </button>
                        <DangerConfirmButton
                          armLabel={t("task.action.delete")}
                          confirmLabel={t("confirm.deleteAgain")}
                          onConfirm={() => onDelete(task)}
                        />
                      </div>
                    )}
                  </article>
                ))}
              </section>
            );
          })}
      </div>
      )}
    </section>
  );
}
