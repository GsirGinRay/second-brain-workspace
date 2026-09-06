import assert from "node:assert/strict";
import test from "node:test";
import { renderDailyJournalDocument } from "./journal";
import {
  buildOutcomeKnowledgeDraft,
  defaultJournalKnowledgeTitle,
  extractMarkdownSection,
  extractWikilinkTargets,
  journalUpgradeContent,
  knowledgeMentionsProject,
  relatedKnowledgeForProject,
  renderOutcomeKnowledgeBody,
} from "./knowledge";
import type { BrainCollectionSnapshot } from "./types";

function collection(
  overrides: Partial<BrainCollectionSnapshot> & Pick<BrainCollectionSnapshot, "name" | "body">,
): BrainCollectionSnapshot {
  return {
    schemaVersion: 6,
    id: overrides.id ?? "c1",
    name: overrides.name,
    sourcePath: overrides.sourcePath ?? "知識/方法/note.md",
    category: overrides.category ?? "方法",
    importance: overrides.importance ?? 1,
    body: overrides.body,
  };
}

test("outcome knowledge body records the source date and reuses attachment paths", () => {
  const body = renderOutcomeKnowledgeBody({
    content: "會議結論：改用可見 Markdown\n\n![](附件/開源發表/shot.png)",
    sourceDate: "2026-08-15",
  });
  assert.match(body, /^來源：2026-08-15\n/);
  assert.match(body, /會議結論：改用可見 Markdown/);
  assert.match(body, /!\[\]\(附件\/開源發表\/shot\.png\)/);
  assert.equal((body.match(/附件\/開源發表\/shot\.png/g) ?? []).length, 1);
});

test("outcome knowledge does not duplicate an existing source-date line", () => {
  const body = renderOutcomeKnowledgeBody({
    content: "來源：2026-08-15\n\n已寫過",
    sourceDate: "2026-08-15",
  });
  assert.equal((body.match(/來源：2026-08-15/g) ?? []).length, 1);
});

test("invalid source dates are omitted", () => {
  const body = renderOutcomeKnowledgeBody({
    content: "只有正文",
    sourceDate: "not-a-date",
  });
  assert.equal(body, "只有正文");
});

test("attachments mentioned only in the source markdown are reused, not copied", () => {
  const body = renderOutcomeKnowledgeBody({
    content: "結論",
    sourceDate: "2026-08-15",
    attachmentSource: "見 [簡報](附件/開源發表/deck.pdf)\n\n![](附件/開源發表/deck.pdf)",
  });
  assert.match(body, /\[deck\.pdf\]\(附件\/開源發表\/deck\.pdf\)/);
  assert.equal((body.match(/附件\/開源發表\/deck\.pdf/g) ?? []).length, 1);
});

test("buildOutcomeKnowledgeDraft keeps the task title and notes", () => {
  const draft = buildOutcomeKnowledgeDraft({
    title: "寫第一份教學",
    content: "## Notes\n\n- 可見的任務清單",
    sourceDate: "2026-08-15",
  });
  assert.equal(draft.name, "寫第一份教學");
  assert.match(draft.body, /來源：2026-08-15/);
  assert.match(draft.body, /可見的任務清單/);
  assert.doesNotMatch(draft.body, /\[\[/);
});

test("journal upgrade prefers 可升級的知識, then 結論, and ignores an empty template", () => {
  const filled = [
    "# 2026-08-15",
    "",
    "## 今日會議",
    "",
    "standup",
    "",
    "## 結論",
    "",
    "先寫結論",
    "",
    "## 產生的任務",
    "",
    "## 可升級的知識",
    "",
    "這段該留下",
    "",
  ].join("\n");
  assert.equal(extractMarkdownSection(filled, "可升級的知識"), "這段該留下");
  assert.equal(journalUpgradeContent(filled), "這段該留下");

  const conclusionsOnly = filled.replace("這段該留下", "");
  assert.equal(journalUpgradeContent(conclusionsOnly), "先寫結論");

  const empty = renderDailyJournalDocument("2026-08-15");
  assert.equal(journalUpgradeContent(empty), "");
});

test("free-form journal body is kept when the scaffold sections are empty", () => {
  const source = "# 2026-08-15\n\n隨手記的會議重點\n";
  assert.equal(journalUpgradeContent(source), "隨手記的會議重點");
});

test("journal knowledge title uses the first content line", () => {
  assert.equal(defaultJournalKnowledgeTitle("2026-08-15", "這段該留下"), "這段該留下");
  assert.equal(defaultJournalKnowledgeTitle("2026-08-15", ""), "2026-08-15 結論");
});

test("related knowledge matches wikilinks, aliases, and a labeled project name", () => {
  const linked = collection({
    id: "linked",
    name: "會議紀錄",
    body: "步驟\n\n[[開源發表]]",
  });
  const aliased = collection({
    id: "aliased",
    name: "別名",
    body: "見 [[開源發表|Launch]]",
  });
  const labeled = collection({
    id: "labeled",
    name: "標籤",
    body: "專案：開源發表",
  });
  const unrelated = collection({
    id: "other",
    name: "開源發表",
    body: "只是同名的知識標題，沒有提到專案",
  });
  const related = relatedKnowledgeForProject(
    [linked, aliased, labeled, unrelated],
    "開源發表",
  );
  assert.deepEqual(related.map((item) => item.id), ["linked", "aliased", "labeled"]);
  assert.equal(knowledgeMentionsProject(unrelated, "開源發表"), false);
  assert.deepEqual(extractWikilinkTargets("見 [[開源發表|Launch]] 與 [[其他]]"), [
    "開源發表",
    "其他",
  ]);
});

test("related knowledge is empty when the project name is blank", () => {
  assert.deepEqual(
    relatedKnowledgeForProject([collection({ name: "A", body: "[[X]]" })], "  "),
    [],
  );
});
