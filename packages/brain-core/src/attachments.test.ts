import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  attachmentFolderForJournal,
  attachmentFolderForKnowledge,
  attachmentFolderForProject,
  attachmentFolderForTask,
  canAddAttachments,
  canonicalAttachmentPath,
  extractAttachmentHrefs,
  isAllowedAttachmentExtension,
  isImageAttachmentPath,
  renderAttachmentMarkdown,
  sanitizeAttachmentFileName,
  sanitizeAttachmentFolderName,
  uniqueAttachmentFileName,
  vaultAttachmentRelativePath,
} from "./attachments";

test("attachment allowlist accepts images and documents and rejects executables", () => {
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "txt", "md", "csv"]) {
    assert.equal(isAllowedAttachmentExtension(ext), true, ext);
  }
  for (const ext of ["exe", "js", "html", "htm", "bat", "cmd", "ps1", "dll"]) {
    assert.equal(isAllowedAttachmentExtension(ext), false, ext);
  }
  assert.equal(sanitizeAttachmentFileName("photo.PNG"), "photo.png");
  assert.equal(sanitizeAttachmentFileName("notes.pdf"), "notes.pdf");
  assert.equal(sanitizeAttachmentFileName("payload.exe"), null);
  assert.equal(sanitizeAttachmentFileName("click.js"), null);
  assert.equal(sanitizeAttachmentFileName("page.html"), null);
  assert.equal(sanitizeAttachmentFileName("../escape.png"), "escape.png");
  assert.equal(sanitizeAttachmentFileName(".hidden.png"), null);
  assert.equal(ATTACHMENT_MAX_FILE_BYTES, 16 * 1024 * 1024);
});

test("attachment folders sanitize to a single safe component", () => {
  assert.equal(sanitizeAttachmentFolderName("Personal System"), "Personal System");
  assert.equal(sanitizeAttachmentFolderName("a/../b"), "");
  assert.equal(sanitizeAttachmentFolderName(".hidden"), "");
  assert.equal(sanitizeAttachmentFolderName("foo:bar"), "foo bar");
  assert.equal(attachmentFolderForProject("開源發布"), "開源發布");
  assert.equal(attachmentFolderForProject(""), "專案");
  assert.equal(attachmentFolderForKnowledge("FAQ"), "FAQ");
  assert.equal(attachmentFolderForKnowledge("提示詞/投資分析"), "提示詞");
  assert.equal(attachmentFolderForKnowledge(null), "知識");
  assert.equal(attachmentFolderForJournal(), "日誌");
  assert.equal(attachmentFolderForTask("開源發布"), "開源發布");
  assert.equal(attachmentFolderForTask(null), "收件匣");
});

test("duplicate attachment names take a -2 suffix", () => {
  assert.equal(uniqueAttachmentFileName("photo.png", []), "photo.png");
  assert.equal(
    uniqueAttachmentFileName("photo.png", ["photo.png"]),
    "photo-2.png",
  );
  assert.equal(
    uniqueAttachmentFileName("photo.png", ["photo.png", "photo-2.png"]),
    "photo-3.png",
  );
  assert.equal(
    canonicalAttachmentPath("開源發布", "photo-2.png"),
    "附件/開源發布/photo-2.png",
  );
});

test("markdown links are images for pictures and named links for other files", () => {
  assert.equal(
    renderAttachmentMarkdown("附件/開源發布/photo.png"),
    "![](附件/開源發布/photo.png)",
  );
  assert.equal(
    renderAttachmentMarkdown("附件/開源發布/brief.pdf"),
    "[brief.pdf](附件/開源發布/brief.pdf)",
  );
  assert.equal(
    renderAttachmentMarkdown("附件/Personal System/a.png"),
    "![](<附件/Personal System/a.png>)",
  );
  assert.equal(isImageAttachmentPath("附件/FAQ/a.webp"), true);
  assert.equal(isImageAttachmentPath("附件/FAQ/a.pdf"), false);
});

test("vault attachment hrefs reject escape and keep only 附件/<folder>/<file>", () => {
  assert.equal(
    vaultAttachmentRelativePath("附件/開源發布/photo.png"),
    "附件/開源發布/photo.png",
  );
  assert.equal(
    vaultAttachmentRelativePath("../附件/開源發布/photo.png"),
    null,
  );
  assert.equal(vaultAttachmentRelativePath("專案/photo.png"), null);
  assert.equal(vaultAttachmentRelativePath("附件/photo.png"), null);
  assert.equal(vaultAttachmentRelativePath("附件/開源發布/photo.exe"), null);
  assert.equal(vaultAttachmentRelativePath("https://example.com/a.png"), null);
  assert.equal(vaultAttachmentRelativePath("附件/foo/../bar/a.png"), null);
});

test("a task may hold only one attachment link", () => {
  const empty = "";
  const one = "需要這份資料\n\n[](附件/收件匣/brief.pdf)";
  const image = "![](附件/收件匣/photo.png)";
  assert.deepEqual(extractAttachmentHrefs(one), ["附件/收件匣/brief.pdf"]);
  assert.equal(canAddAttachments(empty, 1, 1), true);
  assert.equal(canAddAttachments(one, 1, 1), false);
  assert.equal(canAddAttachments(image, 1, 1), false);
  assert.equal(canAddAttachments(empty, 2, 1), false);
  assert.equal(canAddAttachments(one, 1), true);
});
