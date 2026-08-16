import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWorkspaceQuery,
  searchWorkspace,
  type WorkspaceSearchCollection,
  type WorkspaceSearchProject,
  type WorkspaceSearchTask,
} from "./search";

const tasks: WorkspaceSearchTask[] = [
  { id: "exact", title: "發布影片", status: "todo", taskDate: "2026-08-14", completedAt: null, projectName: "YouTube", sourcePath: "Tasks.md", sourceHeading: null },
  { id: "project", title: "準備素材", status: "doing", taskDate: "2026-08-13", completedAt: null, projectName: "發布影片系統", sourcePath: "Projects/Video.md", sourceHeading: null },
  { id: "done", title: "發布舊文章", status: "done", taskDate: "2026-08-01", completedAt: "2026-08-02", projectName: null, sourcePath: "Archive.md", sourceHeading: null },
  { id: "future", title: "未來任務", status: "todo", taskDate: "2026-08-20", completedAt: null, projectName: null, sourcePath: "Tasks.md", sourceHeading: null },
  { id: "unscheduled", title: "沒有日期", status: "todo", taskDate: null, completedAt: null, projectName: null, sourcePath: "Inbox.md", sourceHeading: null },
];

const projects: WorkspaceSearchProject[] = [
  { id: "p1", name: "發布影片系統", status: "active", area: "內容", endDate: "2026-08-30", completedAt: null },
  { id: "p2", name: "歷史專案", status: "done", area: "內容", endDate: null, completedAt: "2026-07-01" },
];

const collections: WorkspaceSearchCollection[] = [
  { id: "c1", name: "常用提示詞", category: "AI", importance: 1, sourcePath: "Collections/Prompts.md", body: "影片腳本 股票分析" },
  { id: "c2", name: "剪輯參考", category: "影片", importance: 2, sourcePath: "Collections/Editing.md", body: "轉場與字幕規範" },
];

test("workspace search ranks an exact task title before project-field matches", () => {
  const results = searchWorkspace(tasks, projects, { query: "發布影片", sort: "relevance", today: "2026-08-14" });
  assert.deepEqual(results.map(({ kind, id }) => `${kind}:${id}`).slice(0, 3), ["task:exact", "project:p1", "task:project"]);
});

test("workspace search supports case-insensitive English and Chinese tokens", () => {
  assert.equal(searchWorkspace(tasks, projects, { query: "youtube", sort: "relevance", today: "2026-08-14" })[0]?.id, "exact");
  assert.equal(searchWorkspace(tasks, projects, { query: "內容", sort: "relevance", today: "2026-08-14" }).length, 2);
});

test("date sorting puts overdue, today, future, completed and unscheduled in order", () => {
  const results = searchWorkspace(tasks, [], { query: "", sort: "date", today: "2026-08-14" });
  assert.deepEqual(results.map(({ id }) => id), ["project", "exact", "future", "done", "unscheduled"]);
});

test("status filter finds completed history without losing projects", () => {
  const results = searchWorkspace(tasks, projects, { query: "", sort: "date", status: "completed", today: "2026-08-14" });
  assert.deepEqual(results.map(({ id }) => id), ["done", "p2"]);
});

test("workspace query supports union, intersection, precedence and quoted phrases", () => {
  assert.deepEqual(parseWorkspaceQuery("股票 + 影片 & 腳本"), {
    groups: [["股票"], ["影片", "腳本"]],
    error: null,
  });
  assert.deepEqual(parseWorkspaceQuery('"影片腳本" & 股票'), {
    groups: [["影片腳本", "股票"]],
    error: null,
  });
});

test("workspace query reports malformed operators without throwing", () => {
  assert.equal(parseWorkspaceQuery("股票 ++ 影片").error, "搜尋條件不完整");
  assert.equal(parseWorkspaceQuery("股票 &").error, "搜尋條件不完整");
});

test("boolean search matches terms across fields and includes local collections", () => {
  const intersection = searchWorkspace(tasks, projects, collections, {
    query: "股票 & AI",
    sort: "relevance",
    today: "2026-08-14",
  });
  assert.deepEqual(intersection.map(({ id }) => id), ["c1"]);

  const union = searchWorkspace(tasks, projects, collections, {
    query: "字幕 + 股票",
    sort: "relevance",
    today: "2026-08-14",
  });
  assert.deepEqual(new Set(union.map(({ id }) => id)), new Set(["c1", "c2"]));
});

test("workspace search can filter result kinds", () => {
  const results = searchWorkspace(tasks, projects, collections, {
    query: "剪輯",
    sort: "relevance",
    today: "2026-08-14",
    kinds: ["collection"],
  });
  assert.deepEqual(results.map(({ id }) => id), ["c2"]);
});
