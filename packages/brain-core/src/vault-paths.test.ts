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
  LEGACY_INBOX_PATH,
  LEGACY_JOURNAL_DIR,
  LEGACY_TEMPLATES_DIR,
  isContentScanExcludedPath,
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
