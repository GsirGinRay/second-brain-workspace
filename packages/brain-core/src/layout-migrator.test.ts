import assert from "node:assert/strict";
import test from "node:test";
import {
  hintsForLayoutMigration,
  isManualIndexPath,
  layoutMigrationHasWork,
  planVaultLayoutMigration,
} from "./layout-migrator";

function plan(paths: string[], extra: { entityType?: "project" | "collection"; category?: string | null }[] = []) {
  return planVaultLayoutMigration(
    paths.map((relativePath, index) => ({ relativePath, ...(extra[index] ?? {}) })),
  );
}

function moves(result: ReturnType<typeof planVaultLayoutMigration>) {
  return result.moves.map((item) => `${item.from}=>${item.to}:${item.reason}`).sort();
}

function duplicates(result: ReturnType<typeof planVaultLayoutMigration>) {
  return result.duplicates.map((item) => `${item.from}=>${item.to}~${item.existing}`).sort();
}

test("legacy folders move onto the canonical vault layout without renaming files", () => {
  const result = plan([
    "Projects/Personal System.md",
    "Collections/Prompt Library.md",
    "05-每日工作台/2026-08-15.md",
    "10-收件匣/待辦收件匣.md",
    "90-模板/通用專案.md",
    "99-附件/開源發表/shot.png",
    "20-學員FAQ/如何開始.md",
  ], [
    { entityType: "project" },
    { entityType: "collection", category: "提示詞/寫作" },
    {},
    {},
    {},
    {},
    {},
  ]);
  assert.deepEqual(moves(result), [
    "05-每日工作台/2026-08-15.md=>日誌/2026-08-15.md:journal",
    "10-收件匣/待辦收件匣.md=>收件匣/待辦.md:inbox",
    "20-學員FAQ/如何開始.md=>知識/FAQ/如何開始.md:knowledge",
    "90-模板/通用專案.md=>模板/通用專案.md:template",
    "99-附件/開源發表/shot.png=>附件/開源發表/shot.png:attachment",
    "Collections/Prompt Library.md=>知識/提示詞/Prompt Library.md:knowledge",
    "Projects/Personal System.md=>專案/Personal System.md:project",
  ]);
  assert.equal(result.duplicates.length, 0);
});

test("new writes already in canonical folders stay put", () => {
  const result = plan([
    "專案/Personal System.md",
    "知識/FAQ/如何開始.md",
    "日誌/2026-08-15.md",
    "收件匣/待辦.md",
    "模板/通用專案.md",
    "附件/開源發表/shot.png",
    ".ai/INDEX.md",
  ]);
  assert.equal(result.moves.length, 0);
  assert.equal(result.duplicates.length, 0);
  assert.ok(result.kept.every((item) => item.reason === "already-canonical"));
  assert.equal(layoutMigrationHasWork(result), false);
});

test("a project note outside 專案/ still relocates by type", () => {
  const result = plan(["Launch.md"], [{ entityType: "project" }]);
  assert.deepEqual(moves(result), ["Launch.md=>專案/Launch.md:project"]);
});

test("collection category chooses 知識/<分類>/; unknown category stays at 知識/", () => {
  const known = plan(
    ["Collections/Note.md"],
    [{ entityType: "collection", category: "FAQ" }],
  );
  assert.deepEqual(moves(known), ["Collections/Note.md=>知識/FAQ/Note.md:knowledge"]);
  const unknown = plan(
    ["Collections/Note.md"],
    [{ entityType: "collection", category: "參考" }],
  );
  assert.deepEqual(moves(unknown), ["Collections/Note.md=>知識/Note.md:knowledge"]);
});

test("numbered long-term notes map onto knowledge categories by folder name", () => {
  const result = plan([
    "20-學員FAQ/a.md",
    "30-提示詞庫/會議.md",
    "40-產業/觀察.md",
    "50-方法/複盤.md",
  ]);
  assert.deepEqual(moves(result), [
    "20-學員FAQ/a.md=>知識/FAQ/a.md:knowledge",
    "30-提示詞庫/會議.md=>知識/提示詞/會議.md:knowledge",
    "40-產業/觀察.md=>知識/產業/觀察.md:knowledge",
    "50-方法/複盤.md=>知識/方法/複盤.md:knowledge",
  ]);
});

test("manual indexes stay in place so wikilinks and archives are not rewritten", () => {
  assert.equal(isManualIndexPath("00-INDEX.md"), true);
  assert.equal(isManualIndexPath("20-學員FAQ/FAQ索引.md"), true);
  assert.equal(isManualIndexPath("00-INDEX/總覽.md"), true);
  assert.equal(isManualIndexPath("專案/Personal System.md"), false);
  const result = plan([
    "00-INDEX.md",
    "20-學員FAQ/FAQ索引.md",
    "20-學員FAQ/如何開始.md",
  ]);
  assert.deepEqual(
    result.kept.filter((item) => item.reason === "index").map((item) => item.from).sort(),
    ["00-INDEX.md", "20-學員FAQ/FAQ索引.md"],
  );
  assert.deepEqual(moves(result), ["20-學員FAQ/如何開始.md=>知識/FAQ/如何開始.md:knowledge"]);
});

test("duplicate destinations are flagged and never chosen as a silent delete", () => {
  const existingDest = plan([
    "Projects/A.md",
    "專案/A.md",
  ], [{ entityType: "project" }, { entityType: "project" }]);
  assert.equal(existingDest.moves.length, 0);
  assert.deepEqual(duplicates(existingDest), ["Projects/A.md=>專案/A.md~專案/A.md"]);
});

test("two sources that flatten to the same filename block each other", () => {
  const result = plan([
    "Projects/area/Same.md",
    "notes/Same.md",
  ], [{ entityType: "project" }, { entityType: "project" }]);
  assert.equal(result.moves.length, 0);
  assert.equal(result.duplicates.length, 2);
  assert.ok(result.duplicates.every((item) => item.to === "專案/Same.md"));
});

test("legacy inbox other files keep their names; journals skip non-dates", () => {
  const result = plan([
    "10-收件匣/靈感.md",
    "05-每日工作台/README.md",
    "05-每日工作台/2026-08-15-notes.md",
  ]);
  assert.deepEqual(moves(result), ["10-收件匣/靈感.md=>收件匣/靈感.md:inbox"]);
  assert.ok(result.kept.some((item) => item.from === "05-每日工作台/README.md" && item.reason === "unmapped"));
});

test("tmp and backup copies are ignored so they never re-enter the vault", () => {
  const result = plan([
    "tmp/backup-2026-08-15/Projects/A.md",
    "notes/backup-copy/A.md",
    "Projects/A.md",
  ], [{}, {}, { entityType: "project" }]);
  assert.deepEqual(moves(result), ["Projects/A.md=>專案/A.md:project"]);
  assert.ok(result.kept.some((item) => item.from.includes("tmp") && item.reason === "unmapped"));
});

test("type collection inside Projects goes to knowledge, not 專案/", () => {
  const result = plan(
    ["Projects/Prompt.md"],
    [{ entityType: "collection", category: "提示詞" }],
  );
  assert.deepEqual(moves(result), ["Projects/Prompt.md=>知識/提示詞/Prompt.md:knowledge"]);
});

test("type project inside Collections goes to 專案/", () => {
  const result = plan(
    ["Collections/Launch.md"],
    [{ entityType: "project" }],
  );
  assert.deepEqual(moves(result), ["Collections/Launch.md=>專案/Launch.md:project"]);
});

test("hintsForLayoutMigration prefers project type when a path is a project file", () => {
  const hints = hintsForLayoutMigration(
    ["Projects/A.md", "Collections/B.md", "notes.md"],
    [{ sourcePath: "Projects/A.md" }],
    [{ sourcePath: "Collections/B.md", category: "FAQ" }],
  );
  assert.deepEqual(hints, [
    { relativePath: "Projects/A.md", entityType: "project" },
    { relativePath: "Collections/B.md", entityType: "collection", category: "FAQ" },
    { relativePath: "notes.md" },
  ]);
});

test("already-canonical vault plus leftover inbox is still work", () => {
  const result = plan(["專案/A.md", "10-收件匣/待辦收件匣.md"]);
  assert.equal(layoutMigrationHasWork(result), true);
  assert.deepEqual(moves(result), ["10-收件匣/待辦收件匣.md=>收件匣/待辦.md:inbox"]);
});
