import {
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  Archive,
  CheckCircle2,
  Columns3,
  FolderKanban,
  LayoutGrid,
  Plus,
  RotateCcw,
  Table2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Empty, useUiPreferences } from "./app-shared";
import { CategoryInput } from "./category-input";
import { DangerConfirmButton } from "./danger-confirm";

export type ProjectViewMode = "table" | "cards" | "status";

export const PROJECT_VIEW_KEY = "second-brain.projectView";

export function readProjectViewMode(): ProjectViewMode {
  try {
    const saved = localStorage.getItem(PROJECT_VIEW_KEY);
    if (saved === "status" || saved === "cards") return saved;
    return "table";
  } catch {
    return "table";
  }
}

export function projectBodyExcerpt(body: string | undefined, max = 160): string {
  const text = (body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

export function Projects({
  projects,
  tasks,
  revealTab = "current",
  revealTabToken = 0,
  onOpenProject,
  onOpenBoard,
  onCompleteProject,
  onReopenProject,
  onSave,
  onArchive,
  onDelete,
  onCreate,
}: {
  projects: BrainProjectSnapshot[];
  tasks: BrainTaskSnapshot[];
  revealTab?: "current" | "completed" | "archived";
  revealTabToken?: number;
  onOpenProject: (projectId: string) => void;
  onOpenBoard: (projectId: string) => void;
  onCompleteProject: (projectId: string) => void;
  onReopenProject: (projectId: string) => void;
  onSave: (project: BrainProjectSnapshot) => void;
  onArchive: (project: BrainProjectSnapshot) => void;
  onDelete: (project: BrainProjectSnapshot) => void;
  onCreate: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [tab, setTab] = useState<"current" | "completed" | "archived">("current");
  const [mode, setMode] = useState<ProjectViewMode>(() => readProjectViewMode());
  const [statusFilter, setStatusFilter] = useState(() => localStorage.getItem("second-brain.projectStatusFilter") ?? "all");
  const [priorityFilter, setPriorityFilter] = useState(() => localStorage.getItem("second-brain.projectPriorityFilter") ?? "all");
  const [areaFilter, setAreaFilter] = useState(() => localStorage.getItem("second-brain.projectAreaFilter") ?? "all");
  const [sort, setSort] = useState<"priority" | "status" | "name" | "endDate">(() => {
    const saved = localStorage.getItem("second-brain.projectSort");
    return saved === "status" || saved === "name" || saved === "endDate" ? saved : "priority";
  });
  const setProjectView = (next: ProjectViewMode) => {
    setMode(next);
    localStorage.setItem(PROJECT_VIEW_KEY, next);
  };
  useEffect(() => {
    if (revealTabToken > 0) {
      setTab(revealTab);
      setStatusFilter("all");
      localStorage.setItem("second-brain.projectStatusFilter", "all");
    }
  }, [revealTabToken, revealTab]);
  const groups = {
    current: projects.filter((project) => project.status !== "done" && project.status !== "archived"),
    completed: projects.filter((project) => project.status === "done"),
    archived: projects.filter((project) => project.status === "archived"),
  };
  const areas = [...new Set(projects.map((project) => project.area).filter((area): area is string => Boolean(area)))].sort();
  const statusRank = new Map([["planning", 0], ["active", 1], ["paused", 2], ["done", 3], ["archived", 4]]);
  const visibleProjects = groups[tab]
    .filter((project) => statusFilter === "all" || project.status === statusFilter)
    .filter((project) => priorityFilter === "all" || String(project.priority ?? "unset") === priorityFilter)
    .filter((project) => areaFilter === "all" || project.area === areaFilter)
    .sort((left, right) => {
      if (sort === "priority") return (left.priority ?? 99) - (right.priority ?? 99) || left.name.localeCompare(right.name);
      if (sort === "status") return (statusRank.get(left.status) ?? 99) - (statusRank.get(right.status) ?? 99) || left.name.localeCompare(right.name);
      if (sort === "endDate") return (left.endDate ?? "9999-12-31").localeCompare(right.endDate ?? "9999-12-31") || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });
  const renderProject = (project: BrainProjectSnapshot) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    const openTasks = projectTasks.filter((task) => task.status !== "done").length;
    const doingTasks = projectTasks.filter((task) => task.status === "doing").length;
    const excerpt = projectBodyExcerpt(project.body);
    const period = project.startDate || project.endDate
      ? `${project.startDate ?? t("project.date.undecided")} → ${project.endDate ?? t("project.date.undecided")}`
      : t("project.period.none");
    return <article key={project.id ?? project.name} className="project-card project-summary-card" data-project-card tabIndex={0} onClick={() => project.id && onOpenProject(project.id)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && project.id) { event.preventDefault(); onOpenProject(project.id); } }}>
      <div className="project-head"><div><span className="eyebrow">{project.area ?? t("app.uncategorized")}</span><h3>{project.name}</h3></div>{project.focusToday && <span className="focus">{t("project.focusToday")}</span>}</div>
      <div className="project-summary-status"><span>{t(`project.status.${project.status}`)}</span><span>{project.priority ? `${project.priority} · ${project.priority === 1 ? t("project.importance.high") : project.priority === 2 ? t("project.importance.medium") : t("project.importance.low")}` : t("project.importance.unset")}</span></div>
      <p className="project-summary-period">{period}</p>
      {excerpt ? <p className="project-summary-excerpt">{excerpt}</p> : null}
      <div className="progress"><i style={{ width: `${project.progress ?? 0}%` }} /></div>
      <div className="project-meta"><span>{project.progress ?? 0}%</span><span>{t("task.count.open", { count: openTasks })}</span><span>{t("task.count.doing", { count: doingTasks })}</span></div>
      <div className="project-summary-actions">
        <button type="button" className="secondary-button action-with-icon project-board-button" onClick={(event) => { event.stopPropagation(); if (project.id) onOpenBoard(project.id); }}><FolderKanban aria-hidden="true" />{t("project.action.open")}</button>
        {project.status !== "done" && project.status !== "archived" && (
          <button type="button" className="secondary-button action-with-icon" data-complete-project onClick={(event) => { event.stopPropagation(); if (project.id) onCompleteProject(project.id); }}><CheckCircle2 aria-hidden="true" />{t("project.action.complete")}</button>
        )}
        {(project.status === "done" || project.status === "archived") && (
          <button type="button" className="secondary-button action-with-icon" data-reopen-project onClick={(event) => { event.stopPropagation(); if (project.id) onReopenProject(project.id); }}><RotateCcw aria-hidden="true" />{t("project.action.reopen")}</button>
        )}
      </div>
    </article>;
  };
  return (
    <section className="projects-workspace" data-project-view={mode}>
      <header className="project-workspace-header">
        <div className="project-tabs" role="tablist" aria-label={t("project.field.status")}>
          {([["current", "project.tab.current"], ["completed", "project.tab.completed"], ["archived", "project.tab.archived"]] as const).map(([id, labelKey]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setStatusFilter("all"); localStorage.setItem("second-brain.projectStatusFilter", "all"); }}>{t(labelKey)}<span>{groups[id].length}</span></button>
          ))}
        </div>
        <button className="primary icon-action" aria-label={t("project.action.add")} title={t("project.action.add")} onClick={onCreate}><Plus aria-hidden="true" /></button>
      </header>
      <div className="project-filters">
        <div className="segmented-control icon-segmented-control" aria-label={t("project.view")}>
          <button type="button" className={mode === "table" ? "active" : ""} data-project-view-option="table" aria-label={t("project.view.table")} title={t("project.view.table")} onClick={() => setProjectView("table")}><Table2 aria-hidden="true" /></button>
          <button type="button" className={mode === "cards" ? "active" : ""} data-project-view-option="cards" aria-label={t("project.view.cards")} title={t("project.view.cards")} onClick={() => setProjectView("cards")}><LayoutGrid aria-hidden="true" /></button>
          <button type="button" className={mode === "status" ? "active" : ""} data-project-view-option="status" aria-label={t("project.view.board")} title={t("project.view.board")} onClick={() => setProjectView("status")}><Columns3 aria-hidden="true" /></button>
        </div>
        <select aria-label={t("project.filter.status")} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); localStorage.setItem("second-brain.projectStatusFilter", event.target.value); }}><option value="all">{t("project.filter.allStatuses")}</option><option value="planning">{t("project.status.planning")}</option><option value="active">{t("project.status.active")}</option><option value="paused">{t("project.status.paused")}</option></select>
        <select aria-label={t("project.filter.importance")} value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value); localStorage.setItem("second-brain.projectPriorityFilter", event.target.value); }}><option value="all">{t("project.filter.allImportance")}</option><option value="1">{t("project.importance.high")}</option><option value="2">{t("project.importance.medium")}</option><option value="3">{t("project.importance.low")}</option><option value="unset">{t("project.importance.unset")}</option></select>
        <select aria-label={t("project.filter.category")} value={areaFilter} onChange={(event) => { setAreaFilter(event.target.value); localStorage.setItem("second-brain.projectAreaFilter", event.target.value); }}><option value="all">{t("project.filter.allCategories")}</option>{areas.map((area) => <option key={area}>{area}</option>)}</select>
        <select aria-label={t("project.sort")} value={sort} onChange={(event) => { const value = event.target.value as typeof sort; setSort(value); localStorage.setItem("second-brain.projectSort", value); }}><option value="priority">{t("project.sort.importance")}</option><option value="status">{t("project.sort.status")}</option><option value="name">{t("project.sort.name")}</option><option value="endDate">{t("project.sort.endDate")}</option></select>
      </div>
      {visibleProjects.length === 0 ? <Empty text={projects.length === 0 ? t("project.emptyFirst") : t("project.empty")} hint={projects.length === 0 ? t("project.emptyFirstHelp") : t("project.emptyHelp")} actionLabel={projects.length === 0 ? t("project.emptyFirstAction") : t("project.action.add")} onAction={onCreate} /> : mode === "status" && tab === "current" ? (
        <div className="project-status-board">
          {(["planning", "active", "paused"] as const).map((status) => <section key={status}><header><strong>{t(`project.status.${status}`)}</strong><span>{visibleProjects.filter((project) => project.status === status).length}</span></header>{visibleProjects.filter((project) => project.status === status).map(renderProject)}</section>)}
        </div>
      ) : mode === "table" ? (
        <div className="project-table-wrap">
          <table className="board-table project-table">
            <thead>
              <tr>
                <th>{t("project.field.title")}</th>
                <th>{t("project.field.period")}</th>
                <th>{t("project.field.importance")}</th>
                <th>{t("project.field.category")}</th>
                <th>{t("project.field.status")}</th>
                <th>{t("project.field.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleProjects.map((project) => {
                const terminal = project.status === "done" || project.status === "archived";
                return (
                  <tr
                    key={project.id ?? project.name}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button,input,select,textarea,label,a") && project.id) onOpenProject(project.id);
                    }}
                  >
                    <td>
                      <button type="button" className="board-table-title" onClick={() => project.id && onOpenProject(project.id)}>{project.name}</button>
                      {project.focusToday && <small className="focus">{t("project.focusToday")}</small>}
                    </td>
                    <td>
                      <div className="project-table-period">
                        <input type="date" aria-label={`${project.name} ${t("project.field.startDate")}`} value={project.startDate ?? ""} onChange={(event) => onSave({ ...project, startDate: event.target.value || null })} />
                        <span aria-hidden="true">—</span>
                        <input type="date" aria-label={`${project.name} ${t("project.field.endDate")}`} value={project.endDate ?? ""} onChange={(event) => onSave({ ...project, endDate: event.target.value || null })} />
                      </div>
                    </td>
                    <td>
                      <select aria-label={`${project.name} ${t("project.field.importance")}`} value={project.priority ?? ""} onChange={(event) => onSave({ ...project, priority: event.target.value === "" ? null : Number(event.target.value) })}>
                        <option value="">{t("project.importance.unset")}</option>
                        <option value="1">{t("project.importance.high")}</option>
                        <option value="2">{t("project.importance.medium")}</option>
                        <option value="3">{t("project.importance.low")}</option>
                      </select>
                    </td>
                    <td>
                      <CategoryInput
                        value={project.area ?? ""}
                        existingCategories={areas}
                        listId={`project-table-area-${project.id ?? project.name}`}
                        ariaLabel={`${project.name} ${t("project.field.category")}`}
                        locale={preferences.language}
                        onChange={(area) => onSave({ ...project, area: area || null })}
                      />
                    </td>
                    <td>
                      <select aria-label={`${project.name} ${t("project.field.status")}`} value={project.status} disabled={terminal} onChange={(event) => onSave({ ...project, status: event.target.value })}>
                        <option value="planning">{t("project.status.planning")}</option>
                        <option value="active">{t("project.status.active")}</option>
                        <option value="paused">{t("project.status.paused")}</option>
                        {project.status === "done" && <option value="done">{t("project.status.done")}</option>}
                        {project.status === "archived" && <option value="archived">{t("project.status.archived")}</option>}
                      </select>
                    </td>
                    <td>
                      <div className="project-table-actions" onClick={(event) => event.stopPropagation()}>
                        <button type="button" className="icon-action" aria-label={t("project.action.open")} title={t("project.action.open")} onClick={() => project.id && onOpenBoard(project.id)}><FolderKanban aria-hidden="true" /></button>
                        {terminal ? (
                          <button type="button" className="icon-action" data-reopen-project aria-label={t("project.action.reopen")} title={t("project.action.reopen")} onClick={() => project.id && onReopenProject(project.id)}><RotateCcw aria-hidden="true" /></button>
                        ) : (
                          <button type="button" className="icon-action" data-complete-project aria-label={t("project.action.complete")} title={t("project.action.complete")} onClick={() => project.id && onCompleteProject(project.id)}><CheckCircle2 aria-hidden="true" /></button>
                        )}
                        {project.status !== "archived" && <button type="button" className="archive-button icon-action" aria-label={t("project.action.archive")} title={t("project.action.archive")} onClick={() => onArchive(project)}><Archive aria-hidden="true" /></button>}
                        <DangerConfirmButton className="danger icon-action" armLabel={t("project.action.delete")} confirmLabel={t("confirm.deleteAgain")} onConfirm={() => onDelete(project)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <div className="project-grid">{visibleProjects.map(renderProject)}</div>}
    </section>
  );
}
