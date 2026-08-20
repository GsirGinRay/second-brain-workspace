import assert from "node:assert/strict";
import test from "node:test";
import {
  renderVaultIndex,
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
