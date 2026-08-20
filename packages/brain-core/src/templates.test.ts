import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTemplateVariables,
  instantiateTemplate,
  renderTemplateDocument,
  scaffoldTemplateFiles,
  TEMPLATE_PACKS,
} from "./index";

test("instantiateTemplate replaces known placeholders and keeps unknown", () => {
  const out = instantiateTemplate("Hello {{name}}, do {{任务}} now {{typo}}.", {
    name: "世界",
    任务: "寫報告",
  });
  assert.equal(out, "Hello 世界, do 寫報告 now {{typo}}.");
});

test("extractTemplateVariables returns deduplicated ordered names", () => {
  assert.deepEqual(
    extractTemplateVariables("{{a}} {{b}} {{a}} again {{ c }}"),
    ["a", "b", "c"],
  );
});

test("renderTemplateDocument emits frontmatter and body", () => {
  const doc = renderTemplateDocument({
    name: "通用專案",
    kind: "project",
    hint: "通用專案模板",
    body: "# {{專案名稱}}\n\n下一步：{{下一步}}",
  });
  assert.match(doc, /^---\ntype: template\ntemplate_kind: project\nai_hint: 通用專案模板\n---/);
  assert.match(doc, /# 通用專案/);
});

test("scaffold files cover the five packs and merge without collisions", () => {
  const ids = TEMPLATE_PACKS.map((pack) => pack.id);
  const files = scaffoldTemplateFiles(ids);
  assert.ok(files[".ai/INSTRUCTIONS.md"]);
  assert.ok(files[".ai/INDEX.md"]);
  assert.ok(files["CLAUDE.md"]);
  assert.ok(files["AGENTS.md"]);
  assert.ok(files["10-收件匣/待辦收件匣.md"]);
  assert.ok(files["Collections/股票選股分析.md"]);
  assert.ok(files["90-模板/通用專案.md"]);
  assert.ok(files["Prompts/README.md"]);
  assert.ok(files["Projects/README.md"]);
  assert.ok(files["Collections/README.md"]);
});

test("scaffolding only the prompts pack does not create AI files", () => {
  const files = scaffoldTemplateFiles(["prompts"]);
  assert.ok(files["Collections/股票選股分析.md"]);
  assert.equal(files[".ai/INSTRUCTIONS.md"], undefined);
});
