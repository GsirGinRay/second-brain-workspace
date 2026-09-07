import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_AI_DIR,
  CANONICAL_ATTACHMENTS_DIR,
  CANONICAL_COLLECTION_WRITE_DIR,
  CANONICAL_INBOX_PATH,
  CANONICAL_JOURNAL_DIR,
  CANONICAL_KNOWLEDGE_DIR,
  CANONICAL_PROJECTS_DIR,
  CANONICAL_TEMPLATES_DIR,
  KNOWLEDGE_CATEGORIES,
  LEGACY_ATTACHMENTS_DIR,
  LEGACY_INBOX_PATH,
  LEGACY_JOURNAL_DIR,
  LEGACY_TEMPLATES_DIR,
  canonicalKnowledgeWriteDir,
  collectionMatchesCategoryFilter,
  isContentScanExcludedPath,
  isJournalNotePath,
  journalNoteDateKey,
  knowledgeFilterCategories,
  resolveDailyJournal,
  resolveInboxWritePath,
  resolveTodayJournalPath,
} from "./vault-paths";

test("canonical write paths are the official vault folders", () => {
  assert.equal(CANONICAL_PROJECTS_DIR, "專案");
  assert.equal(CANONICAL_KNOWLEDGE_DIR, "知識");
  assert.equal(CANONICAL_JOURNAL_DIR, "日誌");
  assert.equal(LEGACY_JOURNAL_DIR, "05-每日工作台");
  assert.equal(CANONICAL_INBOX_PATH, "收件匣/待辦.md");
  assert.equal(CANONICAL_ATTACHMENTS_DIR, "附件");
  assert.equal(CANONICAL_TEMPLATES_DIR, "模板");
  assert.equal(LEGACY_ATTACHMENTS_DIR, "99-附件");
  assert.equal(CANONICAL_AI_DIR, ".ai");
  assert.equal(CANONICAL_COLLECTION_WRITE_DIR, "知識");
  assert.deepEqual(KNOWLEDGE_CATEGORIES, [
    "FAQ",
    "產業",
    "社群",
    "影片",
    "方法",
    "提示詞",
  ]);
});

test("new inbox writes prefer 收件匣/待辦.md unless only the legacy inbox exists", () => {
  assert.equal(resolveInboxWritePath([]), "收件匣/待辦.md");
  assert.equal(
    resolveInboxWritePath(["Projects/A.md"]),
    "收件匣/待辦.md",
  );
  assert.equal(
    resolveInboxWritePath(["10-收件匣/待辦收件匣.md"]),
    LEGACY_INBOX_PATH,
  );
  assert.equal(
    resolveInboxWritePath([
      "10-收件匣/待辦收件匣.md",
      "收件匣/待辦.md",
    ]),
    "收件匣/待辦.md",
  );
});

test("content scan skips templates, attachments, tmp, and backup directories", () => {
  assert.equal(isContentScanExcludedPath("專案/A.md"), false);
  assert.equal(isContentScanExcludedPath("Projects/A.md"), false);
  assert.equal(isContentScanExcludedPath("知識/筆記.md"), false);
  assert.equal(isContentScanExcludedPath("Collections/Prompts.md"), false);
  assert.equal(isContentScanExcludedPath("收件匣/待辦.md"), false);
  assert.equal(isContentScanExcludedPath("10-收件匣/待辦收件匣.md"), false);
  assert.equal(isContentScanExcludedPath("模板/通用專案.md"), true);
  assert.equal(isContentScanExcludedPath(`${LEGACY_TEMPLATES_DIR}/通用專案.md`), true);
  assert.equal(isContentScanExcludedPath("附件/圖.md"), true);
  assert.equal(isContentScanExcludedPath("tmp/scratch.md"), true);
  assert.equal(isContentScanExcludedPath("tmp/backup-2026-08-15/old.md"), true);
  assert.equal(isContentScanExcludedPath("notes/backup-copy/x.md"), true);
  assert.equal(isContentScanExcludedPath("專案/backup.md"), false);
});

test("today's journal path prefers 日誌/ and can point at legacy 05-每日工作台/", () => {
  assert.equal(resolveTodayJournalPath("2026-08-15", []), null);
  assert.equal(
    resolveTodayJournalPath("2026-08-15", ["日誌/2026-08-15.md"]),
    "日誌/2026-08-15.md",
  );
  assert.equal(
    resolveTodayJournalPath("2026-08-15", ["05-每日工作台/2026-08-15.md"]),
    "05-每日工作台/2026-08-15.md",
  );
  assert.equal(
    resolveTodayJournalPath("2026-08-15", [
      "05-每日工作台/2026-08-15.md",
      "日誌/2026-08-15.md",
    ]),
    "日誌/2026-08-15.md",
  );
  assert.equal(
    resolveTodayJournalPath("2026-08-15", ["日誌/2026-08-14.md"]),
    null,
  );
  assert.equal(
    resolveTodayJournalPath("2026-08-15", [
      "tmp/backup-2026-08-15/日誌.md",
    ]),
    null,
  );
});

test("only YYYY-MM-DD notes under 日誌/ or 05-每日工作台/ count as journals", () => {
  assert.equal(isJournalNotePath("日誌/2026-08-15.md"), true);
  assert.equal(isJournalNotePath("05-每日工作台/2026-08-15.md"), true);
  assert.equal(journalNoteDateKey("日誌/2026-08-15.md"), "2026-08-15");
  assert.equal(journalNoteDateKey("05-每日工作台/2026-08-15.md"), "2026-08-15");
  assert.equal(isJournalNotePath("日誌/README.md"), false);
  assert.equal(isJournalNotePath("日誌/2026-08-15-notes.md"), false);
  assert.equal(isJournalNotePath("日誌/2026-13-40.md"), false);
  assert.equal(isJournalNotePath("專案/2026-08-15.md"), false);
  assert.equal(isJournalNotePath("tmp/backup/日誌/2026-08-15.md"), false);
  assert.equal(journalNoteDateKey("知識/2026-08-15.md"), null);
});

test("new journal writes always target 日誌/ for that date, never another day", () => {
  assert.deepEqual(resolveDailyJournal("2026-08-15", []), {
    relativePath: "日誌/2026-08-15.md",
    exists: false,
  });
  assert.deepEqual(
    resolveDailyJournal("2026-08-15", ["日誌/2026-08-16.md"]),
    { relativePath: "日誌/2026-08-15.md", exists: false },
  );
  assert.deepEqual(
    resolveDailyJournal("2026-08-16", ["日誌/2026-08-15.md"]),
    { relativePath: "日誌/2026-08-16.md", exists: false },
  );
  assert.deepEqual(
    resolveDailyJournal("2026-08-15", ["05-每日工作台/2026-08-15.md"]),
    { relativePath: "05-每日工作台/2026-08-15.md", exists: true },
  );
  assert.deepEqual(
    resolveDailyJournal("2026-08-15", [
      "05-每日工作台/2026-08-15.md",
      "日誌/2026-08-15.md",
    ]),
    { relativePath: "日誌/2026-08-15.md", exists: true },
  );
});

test("new knowledge writes under 知識/<category>/ including 提示詞 subcategories", () => {
  assert.equal(canonicalKnowledgeWriteDir("FAQ"), "知識/FAQ");
  assert.equal(canonicalKnowledgeWriteDir("提示詞"), "知識/提示詞");
  assert.equal(canonicalKnowledgeWriteDir("提示詞/寫作"), "知識/提示詞");
  assert.equal(canonicalKnowledgeWriteDir("方法"), "知識/方法");
  assert.equal(canonicalKnowledgeWriteDir(null), "知識");
  assert.equal(canonicalKnowledgeWriteDir("參考"), "知識");
});

test("knowledge category filter keeps unknown and uncategorized notes listable", () => {
  assert.equal(collectionMatchesCategoryFilter("FAQ", "all"), true);
  assert.equal(collectionMatchesCategoryFilter(null, "all"), true);
  assert.equal(collectionMatchesCategoryFilter("參考", "all"), true);
  assert.equal(collectionMatchesCategoryFilter("FAQ", "FAQ"), true);
  assert.equal(collectionMatchesCategoryFilter("提示詞/寫作", "FAQ"), false);
  assert.equal(collectionMatchesCategoryFilter(null, "FAQ"), false);
  assert.equal(collectionMatchesCategoryFilter("參考", "FAQ"), false);
  assert.equal(collectionMatchesCategoryFilter("提示詞", "提示詞"), true);
  assert.equal(collectionMatchesCategoryFilter("提示詞/寫作", "提示詞"), true);
  assert.equal(collectionMatchesCategoryFilter("參考", "參考"), true);
  assert.deepEqual(
    knowledgeFilterCategories(["FAQ", "提示詞/寫作", "參考", null, ""]),
    ["FAQ", "產業", "社群", "影片", "方法", "提示詞", "參考"],
  );
});
