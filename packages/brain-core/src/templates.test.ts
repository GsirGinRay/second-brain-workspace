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
  assert.match(files[".ai/INSTRUCTIONS.md"], /如何新增一行任務/);
  assert.match(files[".ai/INSTRUCTIONS.md"], /只打開 INDEX 列出的一個檔/);
  assert.ok(files[".ai/INDEX.md"]);
  assert.ok(files["CLAUDE.md"]);
  assert.ok(files["AGENTS.md"]);
  assert.ok(files["收件匣/待辦.md"]);
  assert.ok(files["知識/提示詞/會議紀錄.md"]);
  assert.ok(files["知識/提示詞/寫作大綱.md"]);
  assert.equal(files["Collections/股票選股分析.md"], undefined);
  assert.ok(files["模板/通用專案.md"]);
  assert.ok(files["知識/提示詞/README.md"]);
  assert.ok(files["專案/README.md"]);
  assert.ok(files["知識/README.md"]);
  assert.equal(files["10-收件匣/待辦收件匣.md"], undefined);
  assert.equal(files["Projects/README.md"], undefined);
  assert.equal(files["Collections/README.md"], undefined);
  assert.equal(files["90-模板/通用專案.md"], undefined);
});

test("architecture defaults to projects and knowledge; optional packs can be added later", () => {
  const defaults = TEMPLATE_PACKS.filter((pack) => pack.defaultSelected !== false).map(
    (pack) => pack.id,
  );
  assert.deepEqual(defaults, ["projects", "knowledge"]);
  for (const id of ["prompts", "templates", "ai"] as const) {
    const pack = TEMPLATE_PACKS.find((item) => item.id === id);
    assert.ok(pack, `${id} pack exists`);
    assert.equal(pack.defaultSelected, false);
    assert.match(pack.description, /之後需要再加/);
  }
});

test("scaffolding only the prompts pack uses generic writing samples, not stock picking", () => {
  const files = scaffoldTemplateFiles(["prompts"]);
  assert.ok(files["知識/提示詞/會議紀錄.md"]);
  assert.ok(files["知識/提示詞/寫作大綱.md"]);
  assert.equal(files["Collections/股票選股分析.md"], undefined);
  assert.equal(files[".ai/INSTRUCTIONS.md"], undefined);
  const joined = Object.values(files).join("\n");
  assert.doesNotMatch(joined, /股票|選股|開源發表/);
});

test("first-run samples are a deletable getting-started project, three teaching tasks, and a neutral collection", () => {
  let n = 0;
  const files = scaffoldTemplateFiles([], {
    today: "2026-08-15",
    samples: true,
    createId: () => `00000000-0000-4000-8000-00000000000${n++}`,
  });
  const project = files["專案/開始使用.md"];
  const collection = files["知識/以後要查的資料.md"];
  assert.ok(project, "sample project lives under 專案/");
  assert.ok(collection, "sample collection lives under 知識/");
  assert.match(project, /^---\ntype: project\nid: 00000000-0000-4000-8000-[0-9a-f]{12}/m);
  assert.match(collection, /^---\ntype: collection\nid: 00000000-0000-4000-8000-[0-9a-f]{12}/m);
  assert.match(project, /可直接改名或刪除/);
  assert.doesNotMatch(project, /publisher_id/);
  assert.doesNotMatch(collection, /publisher_id/);
  assert.equal(files["Inbox.md"], undefined);
  assert.equal(files["Personal System.md"], undefined);
  assert.equal(files["Projects/開源發表.md"], undefined);
  assert.equal(files["Collections/寫作素材.md"], undefined);
  assert.equal(files["Collections/股票選股分析.md"], undefined);
  assert.equal(files["模板/通用專案.md"], undefined);
  assert.equal(files["90-模板/通用專案.md"], undefined);
  assert.equal(files["Prompts/README.md"], undefined);
  assert.equal(files["CLAUDE.md"], undefined);
  assert.equal(files["AGENTS.md"], undefined);
  const inbox = files["收件匣/待辦.md"];
  assert.ok(inbox);
  assert.equal([...inbox.matchAll(/#task /g)].length, 3);
  assert.match(inbox, /完成這一則/);
  assert.match(inbox, /把它排到今天或日曆/);
  assert.match(inbox, /在任務下面寫一段筆記/);
  assert.match(inbox, /⏳ 2026-08-15/);
  assert.match(inbox, /⏰ 09:30/);
  assert.match(inbox, /⏱ 30m/);
  assert.match(inbox, /\[\[開始使用\]\]/);
  assert.match(inbox, /\n  ## Notes\n/);
  assert.doesNotMatch(inbox, /publisher_id/);
  assert.doesNotMatch(inbox, /<!-- publisher-task:/);
  assert.doesNotMatch(Object.values(files).join("\n"), /股票|選股|開源發表/);
});

test("first-run samples stay out of the architecture when samples are off", () => {
  const files = scaffoldTemplateFiles(["projects"], { samples: false, today: "2026-08-15" });
  assert.equal(
    Object.keys(files).some((path) => path.startsWith("專案/") && path !== "專案/README.md"),
    false,
  );
});
