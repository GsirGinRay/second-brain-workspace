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

export interface WorkspaceSearchCollection {
  id: string;
  name: string;
  category: string | null;
  importance: number | null;
  sourcePath: string | null;
  body: string;
}

export type WorkspaceSearchKind = "task" | "project" | "collection";
export type WorkspaceSearchResult =
  | { kind: "task"; id: string; score: number; date: string | null; value: WorkspaceSearchTask }
  | { kind: "project"; id: string; score: number; date: string | null; value: WorkspaceSearchProject }
  | { kind: "collection"; id: string; score: number; date: null; value: WorkspaceSearchCollection };

export interface WorkspaceSearchOptions {
  query: string;
  sort: "relevance" | "date";
  today: string;
  status?: "all" | "open" | "completed";
  kinds?: WorkspaceSearchKind[];
}

export interface ParsedWorkspaceQuery {
  /** OR groups containing AND terms. */
  groups: string[][];
  error: string | null;
}

const normalize = (value: string | null | undefined) =>
  (value ?? "").normalize("NFKC").trim().toLocaleLowerCase();

export function parseWorkspaceQuery(query: string): ParsedWorkspaceQuery {
  const normalized = query.normalize("NFKC").trim();
  if (!normalized) return { groups: [], error: null };
  if ((normalized.match(/"/g)?.length ?? 0) % 2 !== 0) {
    return { groups: [], error: "引號尚未關閉" };
  }
  const tokens = [...normalized.matchAll(/"([^"]*)"|([+&])|([^\s+&]+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
  const groups: string[][] = [[]];
  let expectsTerm = true;
  for (const token of tokens) {
    if (token === "+" || token === "&") {
      if (expectsTerm) return { groups: [], error: "搜尋條件不完整" };
      if (token === "+") groups.push([]);
      expectsTerm = true;
      continue;
    }
    const term = normalize(token);
    if (!term) return { groups: [], error: "搜尋條件不完整" };
    groups[groups.length - 1]!.push(term);
    expectsTerm = false;
  }
  if (expectsTerm || groups.some((group) => group.length === 0)) {
    return { groups: [], error: "搜尋條件不完整" };
  }
  return { groups, error: null };
}

function fieldScore(field: string | null | undefined, term: string, weight: number): number {
  const value = normalize(field);
  if (!value) return 0;
  if (value === term) return weight * 4;
  if (value.startsWith(term)) return weight * 3;
  if (value.includes(term)) return weight * 2;
  return 0;
}

function expressionScore(
  fields: Array<{ value: string | null | undefined; weight: number }>,
  groups: string[][],
): number {
  if (groups.length === 0) return 1;
  let best = 0;
  for (const group of groups) {
    let score = 0;
    let matches = true;
    for (const term of group) {
      const termScore = Math.max(...fields.map((field) => fieldScore(field.value, term, field.weight)));
      if (termScore === 0) {
        matches = false;
        break;
      }
      score += termScore;
    }
    if (matches) best = Math.max(best, score);
  }
  return best;
}

function dateBucket(result: WorkspaceSearchResult, today: string): [number, string] {
  if (result.kind === "collection") return [4, "9999-12-31"];
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
): WorkspaceSearchResult[];
export function searchWorkspace(
  tasks: readonly WorkspaceSearchTask[],
  projects: readonly WorkspaceSearchProject[],
  collections: readonly WorkspaceSearchCollection[],
  options: WorkspaceSearchOptions,
): WorkspaceSearchResult[];
export function searchWorkspace(
  tasks: readonly WorkspaceSearchTask[],
  projects: readonly WorkspaceSearchProject[],
  collectionsOrOptions: readonly WorkspaceSearchCollection[] | WorkspaceSearchOptions,
  maybeOptions?: WorkspaceSearchOptions,
): WorkspaceSearchResult[] {
  const collections = Array.isArray(collectionsOrOptions) ? collectionsOrOptions : [];
  const options = (Array.isArray(collectionsOrOptions) ? maybeOptions : collectionsOrOptions) as WorkspaceSearchOptions;
  const parsed = parseWorkspaceQuery(options.query);
  if (parsed.error) return [];
  const status = options.status ?? "all";
  const kinds = new Set(options.kinds ?? ["task", "project", "collection"]);
  const matchesStatus = (value: { status: string }) =>
    status === "all" || (status === "completed"
      ? value.status === "done" || value.status === "archived"
      : value.status !== "done" && value.status !== "archived");

  const results: WorkspaceSearchResult[] = [];
  if (kinds.has("task")) for (const task of tasks) {
    if (!matchesStatus(task)) continue;
    const score = expressionScore([
      { value: task.title, weight: 100 },
      { value: task.projectName, weight: 50 },
      { value: task.sourceHeading, weight: 30 },
      { value: task.sourcePath, weight: 20 },
    ], parsed.groups);
    if (score) results.push({ kind: "task", id: task.id, score, date: task.status === "done" ? task.completedAt : task.taskDate, value: task });
  }
  if (kinds.has("project")) for (const project of projects) {
    if (!matchesStatus(project)) continue;
    const score = expressionScore([
      { value: project.name, weight: 80 },
      { value: project.area, weight: 40 },
      { value: project.status, weight: 10 },
    ], parsed.groups);
    if (score) results.push({ kind: "project", id: project.id, score, date: project.status === "done" ? project.completedAt : project.endDate, value: project });
  }
  if (kinds.has("collection") && status === "all") for (const collection of collections) {
    const score = expressionScore([
      { value: collection.name, weight: 70 },
      { value: collection.category, weight: 40 },
      { value: collection.sourcePath, weight: 20 },
      { value: collection.body, weight: 10 },
    ], parsed.groups);
    if (score) results.push({ kind: "collection", id: collection.id, score, date: null, value: collection });
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
