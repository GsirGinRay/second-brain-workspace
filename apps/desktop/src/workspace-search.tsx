import {
  type BrainCollectionSnapshot,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  parseWorkspaceQuery,
  searchWorkspace,
  type WorkspaceSearchKind,
  type WorkspaceSearchResult,
} from "@second-brain/brain-ui";
import {
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, taipeiDateKey, useUiPreferences } from "./app-shared";

export function WorkspaceSearch({
  tasks,
  projects,
  collections,
  onClose,
  onSelect,
  actions,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
  onClose: () => void;
  onSelect: (result: WorkspaceSearchResult) => void;
  actions?: Array<{ label: string; run: () => void }>;
}) {
  const { t } = useUiPreferences();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "completed">("all");
  const [kindFilter, setKindFilter] = useState<"all" | WorkspaceSearchKind>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const results = useMemo(() => searchWorkspace(
    tasks.filter((task): task is BrainTaskSnapshot & { id: string } => Boolean(task.id)).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      taskDate: task.taskDate ?? null,
      completedAt: task.completedAt,
      projectName: task.projectName,
      sourcePath: task.sourcePath,
      sourceHeading: task.sourceHeading,
    })),
    projects.filter((project): project is BrainProjectSnapshot & { id: string } => Boolean(project.id)).map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      area: project.area,
      endDate: project.endDate ?? null,
      completedAt: project.completedAt ?? null,
    })),
    collections.filter((collection): collection is BrainCollectionSnapshot & { id: string } => Boolean(collection.id)).map((collection) => ({
      id: collection.id,
      name: collection.name,
      category: collection.category,
      importance: collection.importance,
      sourcePath: collection.sourcePath,
      body: collection.body,
    })),
    { query, sort, status: statusFilter, kinds: kindFilter === "all" ? undefined : [kindFilter], today: taipeiDateKey() },
  ), [collections, kindFilter, projects, query, sort, statusFilter, tasks]);
  const queryError = parseWorkspaceQuery(query).error;
  useEffect(() => setActiveIndex(0), [query, sort, statusFilter, kindFilter]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="modal workspace-search"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.dialog")}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => Math.min(value + 1, results.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)); }
          if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); onSelect(results[activeIndex]); }
        }}
      >
        <div className="search-input-row">
          <Search aria-hidden="true" />
          <input ref={inputRef} aria-label={t("search.keyword")} aria-invalid={Boolean(queryError)} placeholder={t("search.placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <div className="search-toolbar">
          <div className="segmented-control" aria-label={t("search.sort")}>
            <button className={sort === "relevance" ? "active" : ""} onClick={() => setSort("relevance")}>{t("search.relevance")}</button>
            <button className={sort === "date" ? "active" : ""} onClick={() => setSort("date")}>{t("search.date")}</button>
          </div>
          <select aria-label={t("search.filter.status")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">{t("search.allStatuses")}</option>
            <option value="open">{t("search.open")}</option>
            <option value="completed">{t("search.completed")}</option>
          </select>
          <select aria-label={t("search.filter.kind")} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}><option value="all">{t("search.allKinds")}</option><option value="task">{t("search.kind.task")}</option><option value="project">{t("search.kind.project")}</option><option value="collection">{t("search.kind.collection")}</option></select>
          <span>{t("search.results", { count: results.length })}</span>
        </div>
        {queryError && <div className="search-error" role="status">{queryError}</div>}
        {actions && actions.length > 0 && !query && (
          <div className="search-commands" aria-label="快速動作">
            {actions.map((command) => (
              <button
                key={command.label}
                onClick={() => { onClose(); command.run(); }}
              >
                <span className="result-kind">CMD</span>
                <span><strong>{command.label}</strong></span>
              </button>
            ))}
          </div>
        )}
        <div className="search-results" role="listbox">
          {results.length === 0 ? <Empty text={t("search.empty")} /> : results.map((result, index) => {
            const isTask = result.kind === "task";
            const title = isTask ? result.value.title : result.value.name;
            const meta = result.kind === "task"
              ? [result.value.projectName, result.value.taskDate, result.value.sourcePath].filter(Boolean).join(" · ")
              : result.kind === "project"
                ? [result.value.area, result.value.status, result.value.endDate].filter(Boolean).join(" · ")
                : [result.value.category, result.value.sourcePath].filter(Boolean).join(" · ");
            return (
              <button
                key={`${result.kind}:${result.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(result)}
              >
                <span className="result-kind">{t(`search.kind.${result.kind}`)}</span>
                <span><strong>{title}</strong><small>{meta || t("app.uncategorized")}</small></span>
                {result.date && <time>{result.date}</time>}
              </button>
            );
          })}
        </div>
        <footer>{t("search.help")}</footer>
      </section>
    </div>
  );
}
