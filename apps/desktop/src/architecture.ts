import {
  renderVaultIndex,
  scaffoldTemplateFiles,
  type TemplatePackId,
  type VaultIndexInput,
} from "@second-brain/brain-core";
import type { LocalMarkdownFile, MarkdownChange } from "./vault";

/**
 * Desktop-side helpers for the "AI 可讀架構" workstream: scaffolding the
 * vault-architecture template packs (WP0) and regenerating `.ai/INDEX.md`
 * (Workstream A). Both produce ordinary MarkdownChange objects so they flow
 * through the existing backup / atomic-write / recovery-journal path.
 */

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const INDEX_PATH = ".ai/INDEX.md";

function encodeBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)));
}

/** Decode a UTF-8 base64 string (WebView2/Node agnostic). */
export function decodeBase64(value: string): string {
  return decodeURIComponent(escape(atob(value)));
}

/**
 * Build `create` changes for every file in the selected template packs whose
 * relative path does not already exist in the vault.
 */
export function scaffoldArchitectureChanges(
  existingPaths: readonly string[],
  packIds: readonly TemplatePackId[],
): MarkdownChange[] {
  const used = new Set(existingPaths.map((path) => path.replace(/\\/g, "/").toLowerCase()));
  const out: MarkdownChange[] = [];
  for (const [relativePath, content] of Object.entries(
    scaffoldTemplateFiles(packIds),
  )) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (used.has(normalized.toLowerCase())) continue;
    out.push({
      relativePath: normalized,
      expectedSha256: EMPTY_SHA256,
      replacementBase64: encodeBase64(content),
      operation: "create",
    });
  }
  return out;
}

/**
 * Render the current `.ai/INDEX.md` and return a change only when the content
 * differs from what is on disk (or when the file is missing). Because `.ai/`
 * is excluded from scanning, the caller supplies the previous index file
 * (obtained via `readMarkdownFiles([".ai/INDEX.md"])`) or `undefined`.
 */
export function renderIndexChange(
  input: VaultIndexInput,
  existing: LocalMarkdownFile | undefined,
): MarkdownChange | null {
  const content = renderVaultIndex(input);
  if (existing && decodeBase64(existing.bytesBase64) === content) return null;
  return {
    relativePath: INDEX_PATH,
    expectedSha256: existing?.sha256 ?? EMPTY_SHA256,
    replacementBase64: encodeBase64(content),
    operation: existing ? "write" : "create",
  } as MarkdownChange;
}
