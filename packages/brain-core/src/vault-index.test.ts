import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskLine,
  renderVaultIndex,
  VAULT_INDEX_UNSCHEDULED_LIMIT,
  type BrainCollectionSnapshot,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "./index";

const baseTask: BrainTaskSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "寫第一份報告",
  status: "todo",
  taskDate: "2026-08-15",
  priority: "high",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "開源發布",
  rank: "00000001",
  sourcePath: "10-收件匣/待辦收件匣.md",
  sourceHeading: null,
  completedAt: null,
  startTime: "09:30",
  durationMinutes: 30,
  timeZone: "Asia/Taipei",
  body: "",
  schemaVersion: 6,
};

const project: BrainProjectSnapshot = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "開源發布",
  sourcePath: "Projects/開源發布.md",
  status: "active",
  area: "工程",
  priority: 1,
  progress: 40,
  focusToday: true,
  startDate: "2026-08-01",
  endDate: null,
  completedAt: null,
  body: "",
  schemaVersion: 6,
};

const collection: BrainCollectionSnapshot = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "股票選股分析",
  sourcePath: "Collections/股票選股分析.md",
  category: "提示詞/投資分析",
  importance: 1,
  body: "你是一位專業的股票選股分析專家…",
  schemaVersion: 6,
};

function input() {
  return {
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [baseTask],
    projects: [project],
    collections: [collection],
  };
}

test("renderVaultIndex is deterministic for the same snapshot", () => {
  assert.equal(renderVaultIndex(input()), renderVaultIndex(input()));
});

test("renderVaultIndex renders an empty vault without throwing", () => {
  const out = renderVaultIndex({
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [],
    projects: [],
    collections: [],
  });
  assert.match(out, /No projects yet\./);
  assert.match(out, /No collections yet\./);
  assert.match(out, /完成 done: 0/);
  assert.match(out, /No reusable prompts yet\./);
});

test("renderVaultIndex includes project, collection and prompt sections", () => {
  const out = renderVaultIndex(input());
  assert.match(out, /## Projects/);
  assert.match(out, /開源發布/);
  assert.match(out, /## Collections/);
  assert.match(out, /## Reusable prompts \(提示詞\)/);
  assert.match(out, /股票選股分析/);
  assert.match(out, /提示詞\/投資分析/);
  assert.match(out, /今日最重要 most-important/);
  assert.match(out, /\.ai\/INSTRUCTIONS\.md/);
});

test("renderVaultIndex escapes pipe and newline inside table cells", () => {
  const inferred = input();
  inferred.collections = [
    {
      ...collection,
      name: "含 | 管道符號",
      category: "提示詞/測試\n換行",
    },
  ];
  const out = renderVaultIndex(inferred);
  // The pipe must be escaped in a table cell, and the newline collapsed to a space.
  assert.match(out, /含 \\\| 管道符號/);
  assert.ok(!out.includes("測試\n換行"));
});

test("renderVaultIndex flags today's most-important task", () => {
  const inferred = input();
  inferred.tasks = [
    { ...baseTask, priority: "highest", taskDate: "2026-08-15" },
  ];
  const out = renderVaultIndex(inferred);
  assert.match(out, /寫第一份報告/);
});

function section(out: string, heading: string, nextHeading: string): string {
  const start = out.indexOf(heading);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const end = out.indexOf(nextHeading, start + heading.length);
  assert.ok(end >= 0, `missing following heading ${nextHeading}`);
  return out.slice(start, end);
}

function task(overrides: Partial<BrainTaskSnapshot>): BrainTaskSnapshot {
  return { ...baseTask, ...overrides };
}

test("renderVaultIndex lists today's tasks with title, time, project and sourcePath", () => {
  const out = renderVaultIndex(input());
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  assert.match(today, /今日任務/);
  assert.match(today, /寫第一份報告/);
  assert.match(today, /⏰ 09:30/);
  assert.match(today, /⏱ 30m/);
  assert.match(today, /開源發布/);
  assert.match(today, /10-收件匣\/待辦收件匣\.md/);
});

test("renderVaultIndex lists overdue tasks separately from today", () => {
  const out = renderVaultIndex({
    ...input(),
    tasks: [
      task({ id: "today", title: "今天的事", taskDate: "2026-08-15" }),
      task({
        id: "late",
        title: "過期的事",
        taskDate: "2026-08-10",
        startTime: "14:00",
        durationMinutes: 45,
        sourcePath: "Projects/開源發布.md",
      }),
    ],
  });
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  const overdue = section(out, "## Overdue tasks", "## Unscheduled ideas");
  assert.match(today, /今天的事/);
  assert.ok(!today.includes("過期的事"));
  assert.match(overdue, /逾期任務/);
  assert.match(overdue, /過期的事/);
  assert.match(overdue, /⏳ 2026-08-10/);
  assert.match(overdue, /⏰ 14:00/);
  assert.match(overdue, /⏱ 45m/);
  assert.match(overdue, /開源發布/);
  assert.match(overdue, /Projects\/開源發布\.md/);
  assert.ok(!overdue.includes("今天的事"));
});

test("renderVaultIndex lists unscheduled ideas with title and path", () => {
  const out = renderVaultIndex({
    ...input(),
    tasks: [
      task({
        id: "idea",
        title: "還沒排的想法",
        taskDate: null,
        startTime: null,
        durationMinutes: null,
        projectName: null,
        sourcePath: "10-收件匣/待辦收件匣.md",
      }),
    ],
  });
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.match(ideas, /未排程想法/);
  assert.match(ideas, /還沒排的想法/);
  assert.match(ideas, /10-收件匣\/待辦收件匣\.md/);
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  const overdue = section(out, "## Overdue tasks", "## Unscheduled ideas");
  assert.ok(!today.includes("還沒排的想法"));
  assert.ok(!overdue.includes("還沒排的想法"));
});

test("renderVaultIndex omits completed and future-dated tasks from the three lists", () => {
  const out = renderVaultIndex({
    ...input(),
    tasks: [
      task({ id: "done", title: "已完成", status: "done", completedAt: "2026-08-15" }),
      task({
        id: "future",
        title: "以後再做",
        taskDate: "2026-08-20",
        startTime: null,
        durationMinutes: null,
      }),
    ],
  });
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  const overdue = section(out, "## Overdue tasks", "## Unscheduled ideas");
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.ok(!today.includes("已完成") && !today.includes("以後再做"));
  assert.ok(!overdue.includes("已完成") && !overdue.includes("以後再做"));
  assert.ok(!ideas.includes("已完成") && !ideas.includes("以後再做"));
});

test("renderVaultIndex caps unscheduled ideas so the file stays bounded", () => {
  const limit = VAULT_INDEX_UNSCHEDULED_LIMIT;
  const tasks = Array.from({ length: limit + 10 }, (_, index) =>
    task({
      id: `idea-${index}`,
      title: `想法 ${String(index).padStart(2, "0")}`,
      taskDate: null,
      startTime: null,
      durationMinutes: null,
      rank: String(index).padStart(8, "0"),
      sourcePath: "10-收件匣/待辦收件匣.md",
    }),
  );
  const out = renderVaultIndex({ ...input(), tasks });
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.match(ideas, /想法 00/);
  assert.match(ideas, new RegExp(`想法 ${String(limit - 1).padStart(2, "0")}`));
  assert.ok(!ideas.includes(`想法 ${String(limit).padStart(2, "0")}`));
  assert.match(ideas, /10 more unscheduled ideas/);
});

test("renderVaultIndex uses empty placeholders when a list has no rows", () => {
  const out = renderVaultIndex({
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [],
    projects: [],
    collections: [],
  });
  assert.match(out, /No tasks scheduled for today/);
  assert.match(out, /No overdue tasks/);
  assert.match(out, /No unscheduled ideas/);
});

test("renderVaultIndex escapes pipes in task titles", () => {
  const out = renderVaultIndex({
    ...input(),
    tasks: [task({ title: "含 | 管道符號" })],
  });
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  assert.match(today, /含 \\\| 管道符號/);
});

test("INDEX encoding example is visible Markdown the parser can read", () => {
  const out = renderVaultIndex(input());
  assert.match(out, /⏰ <HH:MM>/);
  assert.match(out, /⏱ <minutes>m/);
  assert.match(out, /indented/);
  assert.match(out, /do not invent `publisher_id`/);
  const example = out.match(/- \[ \] #task [^\n]+⏰ [^\n]+/);
  assert.ok(example, "encoding spec includes a visible task line");
  const parsed = parseTaskLine(example[0].trim(), "example.md", 0);
  assert.ok(parsed);
  assert.equal(parsed.startTime, "09:30");
  assert.equal(parsed.durationMinutes, 30);
  assert.equal(parsed.taskDate, "2026-08-15");
});
