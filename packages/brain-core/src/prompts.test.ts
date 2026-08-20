import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionToPrompt,
  extractPromptVariables,
  fillPromptVariables,
  parsePluginExport,
  promptToCollection,
  renderPluginExport,
  toCollectionCategory,
  type BrainCollectionSnapshot,
} from "./index";

test("parsePluginExport accepts a wrapped { prompts } object", () => {
  const json = JSON.stringify({
    version: "2.0.7",
    exportedAt: "2026-08-15T00:00:00.000Z",
    prompts: [{ name: "SEO 文章", category: "寫作", content: "請寫一篇 [主題]…" }],
  });
  const prompts = parsePluginExport(json);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.name, "SEO 文章");
  assert.equal(prompts[0]!.category, "寫作");
});

test("parsePluginExport accepts a bare array and trims names", () => {
  const prompts = parsePluginExport(
    JSON.stringify([{ name: "  股票分析  ", category: "投資分析", content: "x" }]),
  );
  assert.equal(prompts[0]!.name, "股票分析");
});

test("parsePluginExport rejects bad JSON, non-array and empty names", () => {
  assert.throws(() => parsePluginExport("{ nope"), /valid JSON/);
  assert.throws(() => parsePluginExport('{"prompts": {}}'), /must be an array/);
  assert.throws(
    () => parsePluginExport(JSON.stringify([{ name: "   ", content: "x" }])),
    /name must not be empty/,
  );
});

test("plugin export ⇄ import round-trips", () => {
  const original = [
    { name: "股票選股分析", category: "投資分析", content: "你是一位分析專家…", pinned: true },
  ];
  const exportJson = renderPluginExport(original, "2.0.7");
  const parsed = parsePluginExport(exportJson);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.name, "股票選股分析");
  assert.equal(parsed[0]!.category, "投資分析");
  assert.equal(parsed[0]!.pinned, true);
});

test("toCollectionCategory prefixes the 提示詞 root and normalizes", () => {
  assert.equal(toCollectionCategory("投資分析"), "提示詞/投資分析");
  assert.equal(toCollectionCategory(""), "提示詞");
  assert.equal(toCollectionCategory("提示詞"), "提示詞");
  assert.equal(toCollectionCategory("提示詞/寫作"), "提示詞/寫作");
});

test("promptToCollection produces a collection in the 提示詞 category", () => {
  const now = () => "2026-08-15T00:00:00.000Z";
  const col = promptToCollection(
    { name: "股票分析", category: "投資分析", content: "body" },
    now,
  );
  assert.equal(col.category, "提示詞/投資分析");
  assert.equal(col.name, "股票分析");
  assert.equal(col.body, "body");
  assert.equal(col.id, null);
});

test("collectionToPrompt strips the 提示詞 root prefix", () => {
  const col: BrainCollectionSnapshot = {
    id: "33333333-3333-4333-8333-333333333333",
    schemaVersion: 6,
    name: "股票分析",
    sourcePath: null,
    category: "提示詞/投資分析",
    importance: null,
    body: "body",
  };
  const prompt = collectionToPrompt(col, { pinned: true });
  assert.equal(prompt.category, "投資分析");
  assert.equal(prompt.content, "body");
  assert.equal(prompt.pinned, true);
  assert.equal(prompt.id, "33333333-3333-4333-8333-333333333333");
});

test("extractPromptVariables returns deduplicated single-token placeholders", () => {
  assert.deepEqual(
    extractPromptVariables("分析 [主題] 的 [主題] 資料，排除 [連結](url) 與內嵌 (x)"),
    ["主題"],
  );
  assert.deepEqual(
    extractPromptVariables("[name] [target] 完成後寄給 [name]"),
    ["name", "target"],
  );
});

test("fillPromptVariables replaces known variables and keeps unknown", () => {
  assert.equal(
    fillPromptVariables("寫一篇關於 [主題] 的文章", { 主題: "AI" }),
    "寫一篇關於 AI 的文章",
  );
  assert.equal(
    fillPromptVariables("目標 [目標] 權重 [權重|60%] 未知 [x]",
      { 目標: "上市" }),
    "目標 上市 權重 [權重|60%] 未知 [x]",
  );
});
