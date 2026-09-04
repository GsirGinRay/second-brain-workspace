import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskLine,
  renderVaultIndex,
  scaffoldTemplateFiles,
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
  sourcePath: "收件匣/待辦.md",
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
  sourcePath: "專案/開源發布.md",
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
  sourcePath: "知識/提示詞/股票選股分析.md",
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

function section(out: string, heading: string, nextHeading: string): string {
  const start = out.indexOf(heading);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const end = out.indexOf(nextHeading, start + heading.length);
  assert.ok(end >= 0, `missing following heading ${nextHeading}`);
  return out.slice(start, end);
}

function tail(out: string, heading: string): string {
  const start = out.indexOf(heading);
  assert.ok(start >= 0, `missing heading ${heading}`);
  return out.slice(start);
}

function task(overrides: Partial<BrainTaskSnapshot>): BrainTaskSnapshot {
  return { ...baseTask, ...overrides };
}

test("renderVaultIndex is deterministic for the same snapshot", () => {
  assert.equal(renderVaultIndex(input()), renderVaultIndex(input()));
});

test("VAULT_INDEX_UNSCHEDULED_LIMIT is a small hardcoded bound", () => {
  assert.equal(VAULT_INDEX_UNSCHEDULED_LIMIT, 8);
});

test("renderVaultIndex renders an empty vault without throwing", () => {
  const out = renderVaultIndex({
    today: "2026-08-15",
    generatedAt: "2026-08-15T00:00:00.000Z",
    tasks: [],
    projects: [],
    collections: [],
  });
  assert.match(out, /No in-progress projects/);
  assert.match(out, /No important knowledge/);
  assert.match(out, /尚無/);
  assert.ok(!out.includes("日誌/2026-08-15.md"));
  assert.ok(!out.includes("On-disk encoding"));
  assert.ok(!out.includes("Folder conventions"));
  assert.ok(!out.includes("Reusable prompts"));
  assert.ok(!out.includes("No collections yet"));
});

test("renderVaultIndex lists in-progress projects with the canonical path", () => {
  const out = renderVaultIndex(input());
  const projects = section(
    out,
    "## In-progress projects",
    "## Today's tasks",
  );
  assert.match(projects, /進行中專案/);
  assert.match(projects, /開源發布/);
  assert.match(projects, /active/);
  assert.match(projects, /40%/);
  assert.match(projects, /專案\/開源發布\.md/);
  assert.match(out, /\.ai\/INSTRUCTIONS\.md/);
});

test("renderVaultIndex lists a legacy Projects/ path when that is the source", () => {
  const out = renderVaultIndex({
    ...input(),
    projects: [
      {
        ...project,
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "A",
        sourcePath: "Projects/A.md",
        status: "planning",
        progress: 0,
      },
    ],
  });
  const projects = section(
    out,
    "## In-progress projects",
    "## Today's tasks",
  );
  assert.match(projects, /\| A \|/);
  assert.match(projects, /planning/);
  assert.match(projects, /Projects\/A\.md/);
  assert.ok(!projects.includes("專案/開源發布.md"));
});

test("renderVaultIndex omits done and archived projects from the map", () => {
  const out = renderVaultIndex({
    ...input(),
    projects: [
      { ...project, status: "done", name: "已完成專案" },
      {
        ...project,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        status: "archived",
        name: "封存專案",
        sourcePath: "專案/封存專案.md",
      },
    ],
  });
  const projects = section(
    out,
    "## In-progress projects",
    "## Today's tasks",
  );
  assert.match(projects, /No in-progress projects/);
  assert.ok(!projects.includes("已完成專案"));
  assert.ok(!projects.includes("封存專案"));
});

test("renderVaultIndex lists only importance 1 knowledge with title, category and path", () => {
  const out = renderVaultIndex({
    ...input(),
    collections: [
      collection,
      {
        ...collection,
        id: "44444444-4444-4444-8444-444444444444",
        name: "普通收藏",
        sourcePath: "知識/參考/普通收藏.md",
        category: "參考",
        importance: 2,
      },
      {
        ...collection,
        id: "55555555-5555-4555-8555-555555555555",
        name: "更普通",
        sourcePath: "Collections/更普通.md",
        category: "筆記",
        importance: 3,
      },
    ],
  });
  const knowledge = section(
    out,
    "## Important knowledge",
    "## Today's journal",
  );
  assert.match(knowledge, /常用知識/);
  assert.match(knowledge, /股票選股分析/);
  assert.match(knowledge, /提示詞\/投資分析/);
  assert.match(knowledge, /知識\/提示詞\/股票選股分析\.md/);
  assert.ok(!knowledge.includes("普通收藏"));
  assert.ok(!knowledge.includes("更普通"));
  assert.ok(!out.includes("## Collections"));
  assert.ok(!out.includes("## Reusable prompts"));
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
  assert.match(out, /含 \\\| 管道符號/);
  assert.ok(!out.includes("測試\n換行"));
});

test("renderVaultIndex lists today's highest-priority task in the today table", () => {
  const inferred = input();
  inferred.tasks = [
    { ...baseTask, priority: "highest", taskDate: "2026-08-15" },
  ];
  const out = renderVaultIndex(inferred);
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  assert.match(today, /寫第一份報告/);
});

test("renderVaultIndex lists today's tasks with title, time, project and sourcePath", () => {
  const out = renderVaultIndex(input());
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  assert.match(today, /今日任務/);
  assert.match(today, /寫第一份報告/);
  assert.match(today, /⏰ 09:30/);
  assert.match(today, /⏱ 30m/);
  assert.match(today, /開源發布/);
  assert.match(today, /收件匣\/待辦\.md/);
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
        sourcePath: "專案/開源發布.md",
      }),
    ],
  });
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  const overdue = section(out, "## Overdue tasks", "## Important knowledge");
  assert.match(today, /今天的事/);
  assert.ok(!today.includes("過期的事"));
  assert.match(overdue, /逾期任務/);
  assert.match(overdue, /過期的事/);
  assert.match(overdue, /⏳ 2026-08-10/);
  assert.match(overdue, /⏰ 14:00/);
  assert.match(overdue, /⏱ 45m/);
  assert.match(overdue, /開源發布/);
  assert.match(overdue, /專案\/開源發布\.md/);
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
        sourcePath: "收件匣/待辦.md",
      }),
    ],
  });
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.match(ideas, /未排程想法/);
  assert.match(ideas, /還沒排的想法/);
  assert.match(ideas, /收件匣\/待辦\.md/);
  const today = section(out, "## Today's tasks", "## Overdue tasks");
  const overdue = section(out, "## Overdue tasks", "## Important knowledge");
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
  const overdue = section(out, "## Overdue tasks", "## Important knowledge");
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.ok(!today.includes("已完成") && !today.includes("以後再做"));
  assert.ok(!overdue.includes("已完成") && !overdue.includes("以後再做"));
  assert.ok(!ideas.includes("已完成") && !ideas.includes("以後再做"));
});

test("renderVaultIndex caps unscheduled ideas so the file stays bounded", () => {
  assert.equal(VAULT_INDEX_UNSCHEDULED_LIMIT, 8);
  const tasks = Array.from({ length: 18 }, (_, index) =>
    task({
      id: `idea-${index}`,
      title: `想法 ${String(index).padStart(2, "0")}`,
      taskDate: null,
      startTime: null,
      durationMinutes: null,
      rank: String(index).padStart(8, "0"),
      sourcePath: "收件匣/待辦.md",
    }),
  );
  const out = renderVaultIndex({ ...input(), tasks });
  const ideas = section(out, "## Unscheduled ideas", "## Operating instructions");
  assert.match(ideas, /想法 00/);
  assert.match(ideas, /想法 07/);
  assert.ok(!ideas.includes("想法 08"));
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

test("renderVaultIndex omits tmp/backup and other excluded paths from the body", () => {
  const out = renderVaultIndex({
    ...input(),
    tasks: [
      task({
        id: "backup-idea",
        title: "備份裡的想法",
        taskDate: null,
        startTime: null,
        durationMinutes: null,
        sourcePath: "tmp/backup-2026-08-15/old.md",
      }),
      task({
        id: "template-idea",
        title: "模板裡的想法",
        taskDate: null,
        startTime: null,
        durationMinutes: null,
        sourcePath: "模板/通用專案.md",
      }),
    ],
    projects: [
      {
        ...project,
        name: "備份專案",
        sourcePath: "tmp/backup-2026-08-15/專案.md",
      },
    ],
    collections: [
      {
        ...collection,
        name: "附件筆記",
        sourcePath: "附件/note.md",
      },
    ],
    existingPaths: [
      "tmp/backup-2026-08-15/old.md",
      "模板/通用專案.md",
      "90-模板/舊模板.md",
      "附件/note.md",
    ],
  });
  assert.ok(!out.includes("tmp/backup"));
  assert.ok(!out.includes("backup-2026-08-15"));
  assert.ok(!out.includes("模板/通用專案.md"));
  assert.ok(!out.includes("90-模板"));
  assert.ok(!out.includes("附件/note.md"));
  assert.ok(!out.includes("備份裡的想法"));
  assert.ok(!out.includes("模板裡的想法"));
  assert.ok(!out.includes("備份專案"));
  assert.ok(!out.includes("附件筆記"));
});

test("renderVaultIndex lists today's journal only when the canonical file exists", () => {
  const missing = renderVaultIndex(input());
  const missingJournal = section(
    missing,
    "## Today's journal",
    "## Unscheduled ideas",
  );
  assert.match(missingJournal, /今日日誌/);
  assert.match(missingJournal, /尚無/);
  assert.ok(!missingJournal.includes("日誌/2026-08-15.md"));
  assert.ok(!missingJournal.includes("05-每日工作台/2026-08-15.md"));

  const present = renderVaultIndex({
    ...input(),
    existingPaths: ["日誌/2026-08-15.md", "日誌/2026-08-14.md"],
  });
  const journal = section(
    present,
    "## Today's journal",
    "## Unscheduled ideas",
  );
  assert.match(journal, /日誌\/2026-08-15\.md/);
  assert.ok(!journal.includes("尚無"));
  assert.ok(!journal.includes("日誌/2026-08-14.md"));
});

test("renderVaultIndex can point at a legacy daily-note journal when that file exists", () => {
  const out = renderVaultIndex({
    ...input(),
    existingPaths: ["05-每日工作台/2026-08-15.md"],
  });
  const journal = section(
    out,
    "## Today's journal",
    "## Unscheduled ideas",
  );
  assert.match(journal, /05-每日工作台\/2026-08-15\.md/);
  assert.ok(!journal.includes("日誌/2026-08-15.md"));
});

test("renderVaultIndex prefers the canonical journal when both files exist", () => {
  const out = renderVaultIndex({
    ...input(),
    existingPaths: [
      "05-每日工作台/2026-08-15.md",
      "日誌/2026-08-15.md",
    ],
  });
  const journal = section(
    out,
    "## Today's journal",
    "## Unscheduled ideas",
  );
  assert.match(journal, /日誌\/2026-08-15\.md/);
  assert.ok(!journal.includes("05-每日工作台/2026-08-15.md"));
});

test("renderVaultIndex tells AI to read INSTRUCTIONS, then INDEX, then only one listed file", () => {
  const out = renderVaultIndex(input());
  const ops = tail(out, "## Operating instructions");
  assert.match(ops, /\.ai\/INSTRUCTIONS\.md/);
  assert.match(ops, /only one listed file/i);
  assert.match(ops, /Do not read the entire inbox/);
  assert.doesNotMatch(ops, /Projects\//);
  assert.doesNotMatch(ops, /Collections\//);
  assert.doesNotMatch(ops, /On-disk encoding/);
  assert.doesNotMatch(out, /- \[ \] #task /);
});

test("INSTRUCTIONS short task format is visible Markdown the parser can read", () => {
  const files = scaffoldTemplateFiles(["ai"]);
  const instructions = files[".ai/INSTRUCTIONS.md"];
  assert.ok(instructions);
  assert.match(instructions, /如何新增一行任務/);
  assert.match(instructions, /只打開 INDEX 列出的一個檔/);
  assert.doesNotMatch(instructions, /編碼規格/);
  const example = instructions.match(/- \[ \] #task [^\n]+⏰ [^\n]+/);
  assert.ok(example, "INSTRUCTIONS includes a visible task line");
  const parsed = parseTaskLine(example[0].trim(), "example.md", 0);
  assert.ok(parsed);
  assert.equal(parsed.startTime, "09:30");
  assert.equal(parsed.durationMinutes, 30);
  assert.equal(parsed.taskDate, "2026-08-15");
});
