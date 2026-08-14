export interface WorkspaceSearchTask {
  id: string;
  title: string;
  status: string;
  taskDate: string | null;
  completedAt: string | null;
  projectName: string | null;
  sourcePath: string | null;
  sourceHeading: string | null;
}

export interface WorkspaceSearchProject {
  id: string;
  name: string;
  status: string;
  area: string | null;
  endDate: string | null;
  completedAt: string | null;
}

export type WorkspaceSearchResult =
  | { kind: "task"; id: string; score: number; date: string | null; value: WorkspaceSearchTask }
  | { kind: "project"; id: string; score: number; date: string | null; value: WorkspaceSearchProject };

export interface WorkspaceSearchOptions {
  query: string;
  sort: "relevance" | "date";
  today: string;
  status?: "all" | "open" | "completed";
}

const normalize = (value: string | null | undefined) =>
  (value ?? "").normalize("NFKC").trim().toLocaleLowerCase();

function fieldScore(field: string | null | undefined, query: string, weight: number): number {
  const value = normalize(field);
  if (!query || !value) return query ? 0 : 1;
  if (value === query) return weight * 4;
  if (value.startsWith(query)) return weight * 3;
  const tokens = query.split(/\s+/u).filter(Boolean);
  if (tokens.every((token) => value.includes(token))) return weight * 2;
  if (value.includes(query)) return weight;
  return 0;
}

function dateBucket(result: WorkspaceSearchResult, today: string): [number, string] {
  const completed = result.value.status === "done" || result.value.status === "archived";
  if (!completed && result.date && result.date < today) return [0, result.date];
  if (!completed && result.date === today) return [1, result.date];
  if (!completed && result.date) return [2, result.date];
  if (completed) return [3, result.date ?? "9999-12-31"];
  return [4, "9999-12-31"];
}

export function searchWorkspace(
  tasks: readonly WorkspaceSearchTask[],
  projects: readonly WorkspaceSearchProject[],
  options: WorkspaceSearchOptions,
): WorkspaceSearchResult[] {
  const query = normalize(options.query);
  const status = options.status ?? "all";
  const matchesStatus = (value: { status: string }) =>
    status === "all" || (status === "completed"
      ? value.status === "done" || value.status === "archived"
      : value.status !== "done" && value.status !== "archived");

  const results: WorkspaceSearchResult[] = [];
  for (const task of tasks) {
    if (!matchesStatus(task)) continue;
    const score = Math.max(
      fieldScore(task.title, query, 100),
      fieldScore(task.projectName, query, 50),
      fieldScore(task.sourceHeading, query, 30),
      fieldScore(task.sourcePath, query, 20),
    );
    if (!query || score) results.push({ kind: "task", id: task.id, score, date: task.status === "done" ? task.completedAt : task.taskDate, value: task });
  }
  for (const project of projects) {
    if (!matchesStatus(project)) continue;
    const score = Math.max(
      fieldScore(project.name, query, 80),
      fieldScore(project.area, query, 40),
      fieldScore(project.status, query, 10),
    );
    if (!query || score) results.push({ kind: "project", id: project.id, score, date: project.status === "done" ? project.completedAt : project.endDate, value: project });
  }

  return results.sort((left, right) => {
    if (options.sort === "relevance") {
      return right.score - left.score || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    }
    const [leftBucket, leftDate] = dateBucket(left, options.today);
    const [rightBucket, rightDate] = dateBucket(right, options.today);
    return leftBucket - rightBucket || (leftBucket === 3 ? rightDate.localeCompare(leftDate) : leftDate.localeCompare(rightDate)) || left.id.localeCompare(right.id);
  });
}
