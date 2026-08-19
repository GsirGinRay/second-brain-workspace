import {
  formatTaskLine,
  extractTaskMarkdownContent,
  parseProjectFrontmatter,
  parseCollectionFrontmatter,
  parseTaskLine,
  patchTaskLineMinimal,
  patchTaskMarkdownContent,
  replaceMarkdownDocumentBody,
  replaceMarkdownDocumentTitle,
  rankForIndex,
  updateProjectFrontmatter,
  type BrainProjectSnapshot,
  type BrainCollectionSnapshot,
  type BrainTaskSnapshot,
  type SyncSnapshot,
} from "@second-brain/brain-core";

export interface LocalMarkdownFile {
  relativePath: string;
  sha256: string;
  bytesBase64: string;
}

export type MarkdownChange = {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
  operation?: "write";
} | {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
  operation: "create";
} | {
  relativePath: string;
  expectedSha256: string;
  operation: "delete";
  replacementBase64: "";
};

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface TaskLocation { relativePath: string; lineIndex: number; rawLine: string }

export interface StructuredVaultScan {
  snapshot: SyncSnapshot & { schemaVersion: 6; collections: BrainCollectionSnapshot[] };
  bootstrapChanges: MarkdownChange[];
}

const INBOX_PATH = "10-收件匣/待辦收件匣.md";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const TASK_CONTENT_START = /^\s*<!-- second-brain-task-content:[0-9a-f-]{36}:start -->\s*$/i;
const TASK_CONTENT_END = /^\s*<!-- second-brain-task-content:[0-9a-f-]{36}:end -->\s*$/i;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeFile(file: LocalMarkdownFile): string {
  return decoder.decode(decodeBase64(file.bytesBase64));
}

function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

function replaceLine(source: string, lineIndex: number, replacement: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = source.endsWith("\r\n") || source.endsWith("\n");
  const lines = splitLines(source);
  if (trailing) lines.pop();
  if (lineIndex < 0 || lineIndex >= lines.length) throw new Error("TASK_LINE_NOT_FOUND");
  lines[lineIndex] = replacement;
  return lines.join(newline) + (trailing ? newline : "");
}

function removeLine(source: string, lineIndex: number): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = source.endsWith("\r\n") || source.endsWith("\n");
  const lines = splitLines(source);
  if (trailing) lines.pop();
  if (lineIndex < 0 || lineIndex >= lines.length) throw new Error("TASK_LINE_NOT_FOUND");
  lines.splice(lineIndex, 1);
  return lines.join(newline) + (trailing && lines.length > 0 ? newline : "");
}

function makeChange(file: LocalMarkdownFile, replacement: string): MarkdownChange {
  return {
    relativePath: file.relativePath,
    expectedSha256: file.sha256,
    replacementBase64: encodeBase64(encoder.encode(replacement)),
  };
}

function safeInline(value: string, maxLength = 200): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!normalized || normalized.length > maxLength) throw new Error("INVALID_MARKDOWN_TITLE");
  return normalized;
}

function uniqueMarkdownPath(directory: string, title: string, existingPaths: readonly string[]): string {
  const base = safeInline(title, 100)
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ") || "Untitled";
  const used = new Set(existingPaths.map((path) => path.replace(/\\/g, "/").toLocaleLowerCase()));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const relativePath = `${directory}/${name}.md`;
    if (!used.has(relativePath.toLocaleLowerCase())) return relativePath;
  }
  throw new Error("MARKDOWN_PATH_EXHAUSTED");
}

export function buildProjectCreateChange(
  name: string,
  area: string | null,
  priority: number | null,
  existingPaths: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
  body = "",
): Extract<MarkdownChange, { operation: "create" }> {
  const title = safeInline(name);
  const category = area?.trim() ? safeInline(area) : "";
  const normalizedPriority = priority && [1, 2, 3].includes(priority) ? priority : "";
  const content = [
    "---",
    "type: project",
    `publisher_id: ${createId()}`,
    "status: planning",
    `area: ${category}`,
    `priority: ${normalizedPriority}`,
    "progress: 0",
    "focus_today: false",
    "start_date: ",
    "end_date: ",
    "completed_at: ",
    "---",
    `# ${title}`,
    "",
    ...body.replace(/\r?\n/g, "\r\n").split("\r\n"),
    "",
  ].join("\r\n");
  return {
    relativePath: uniqueMarkdownPath("Projects", title, existingPaths),
    expectedSha256: EMPTY_SHA256,
    replacementBase64: encodeBase64(encoder.encode(content)),
    operation: "create",
  };
}

export function buildCollectionCreateChange(
  name: string,
  category: string | null,
  importance: number | null,
  existingPaths: readonly string[],
  createId: () => string = () => crypto.randomUUID(),
  body = "",
): Extract<MarkdownChange, { operation: "create" }> {
  const title = safeInline(name);
  const normalizedCategory = category?.trim() ? safeInline(category) : "";
  const normalizedImportance = importance && [1, 2, 3].includes(importance) ? importance : "";
  const content = [
    "---",
    "type: collection",
    `publisher_id: ${createId()}`,
    `category: ${normalizedCategory}`,
    `importance: ${normalizedImportance}`,
    "---",
    `# ${title}`,
    "",
    ...body.replace(/\r?\n/g, "\r\n").split("\r\n"),
    "",
  ].join("\r\n");
  return {
    relativePath: uniqueMarkdownPath("Collections", title, existingPaths),
    expectedSha256: EMPTY_SHA256,
    replacementBase64: encodeBase64(encoder.encode(content)),
    operation: "create",
  };
}

function assertUnique(values: Array<string | null>, code: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) throw new Error(code);
    seen.add(value);
  }
}

export function scanStructuredVault(
  files: LocalMarkdownFile[],
  createId: () => string = () => crypto.randomUUID(),
): StructuredVaultScan {
  const tasks: BrainTaskSnapshot[] = [];
  const projects: BrainProjectSnapshot[] = [];
  const collections: BrainCollectionSnapshot[] = [];
  const sources = new Map(files.map((file) => [file.relativePath, decodeFile(file)]));
  const changedSources = new Map<string, string>();

  for (const file of files) {
    const source = sources.get(file.relativePath)!;
    const project = parseProjectFrontmatter(source, file.relativePath);
    if (project) {
      const id = project.id ?? createId();
      const { frontmatterStart: _frontmatterStart, frontmatterEnd: _frontmatterEnd, ...snapshot } = project;
      projects.push({ ...snapshot, id, schemaVersion: 6 });
      if (!project.id) {
        const patched = updateProjectFrontmatter(source, { publisher_id: id });
        changedSources.set(file.relativePath, patched);
        sources.set(file.relativePath, patched);
      }
    }
    const collection = parseCollectionFrontmatter(source, file.relativePath);
    if (collection) {
      const id = collection.id ?? createId();
      const { frontmatterStart: _frontmatterStart, frontmatterEnd: _frontmatterEnd, ...snapshot } = collection;
      collections.push({ ...snapshot, id, schemaVersion: 6 });
      if (!collection.id) {
        const patched = updateProjectFrontmatter(source, { publisher_id: id });
        changedSources.set(file.relativePath, patched);
        sources.set(file.relativePath, patched);
      }
    }
  }
  assertUnique(projects.map((project) => project.id), "DUPLICATE_PROJECT_ID");
  assertUnique(collections.map((collection) => collection.id), "DUPLICATE_COLLECTION_ID");
  const projectIdByName = new Map(projects.map((project) => [project.name, project.id]));

  for (const file of files) {
    let source = sources.get(file.relativePath)!;
    const lines = splitLines(source);
    let insideTaskContent = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (TASK_CONTENT_START.test(lines[index]!)) { insideTaskContent = true; continue; }
      if (TASK_CONTENT_END.test(lines[index]!)) { insideTaskContent = false; continue; }
      if (insideTaskContent) continue;
      const parsed = parseTaskLine(lines[index]!, file.relativePath, index);
      if (!parsed) continue;
      const id = parsed.id ?? createId();
      const rank = parsed.rank || rankForIndex(tasks.length);
      const { lineIndex: _lineIndex, rawLine: _rawLine, ...snapshot } = parsed;
      const task: BrainTaskSnapshot = {
        ...snapshot,
        id,
        rank,
        projectId: parsed.projectName ? projectIdByName.get(parsed.projectName) ?? null : null,
        schemaVersion: 6,
        body: extractTaskMarkdownContent(source, id),
      };
      tasks.push(task);
      if (!parsed.id || !parsed.rank) {
        const patchedLine = patchTaskLineMinimal(parsed.rawLine, task);
        source = replaceLine(source, index, patchedLine);
        lines[index] = patchedLine;
        changedSources.set(file.relativePath, source);
        sources.set(file.relativePath, source);
      }
    }
  }
  assertUnique(tasks.map((task) => task.id), "DUPLICATE_TASK_ID");
  return {
    snapshot: {
      schemaVersion: 6,
      routineTemplates: [],
      tasks,
      projects,
      collections,
      fileHashes: Object.fromEntries(files.map((file) => [file.relativePath, file.sha256])),
    },
    bootstrapChanges: [...changedSources].map(([relativePath, replacement]) =>
      makeChange(files.find((file) => file.relativePath === relativePath)!, replacement)),
  };
}

function taskLocations(files: LocalMarkdownFile[]): Map<string, TaskLocation> {
  const locations = new Map<string, TaskLocation>();
  for (const file of files) {
    const lines = splitLines(decodeFile(file));
    let insideTaskContent = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (TASK_CONTENT_START.test(lines[lineIndex]!)) { insideTaskContent = true; continue; }
      if (TASK_CONTENT_END.test(lines[lineIndex]!)) { insideTaskContent = false; continue; }
      if (insideTaskContent) continue;
      const task = parseTaskLine(lines[lineIndex]!, file.relativePath, lineIndex);
      if (task?.id) locations.set(task.id, { relativePath: file.relativePath, lineIndex, rawLine: task.rawLine });
    }
  }
  return locations;
}

export function applyDesiredSnapshot(
  files: LocalMarkdownFile[],
  desired: SyncSnapshot,
): MarkdownChange[] {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const currentSources = new Map(files.map((file) => [file.relativePath, decodeFile(file)]));
  const locations = taskLocations(files);
  const changed = new Set<string>();
  const desiredTaskIds = new Set(desired.tasks.flatMap((task) => task.id ? [task.id] : []));

  for (const task of desired.tasks) {
    if (!task.id) continue;
    const location = locations.get(task.id);
    if (!location) continue;
    const source = currentSources.get(location.relativePath)!;
    const currentLine = splitLines(source)[location.lineIndex]!;
    const nextLine = patchTaskLineMinimal(currentLine, task);
    if (nextLine !== currentLine) {
      currentSources.set(location.relativePath, replaceLine(source, location.lineIndex, nextLine));
      changed.add(location.relativePath);
    }
  }

  const removedByPath = new Map<string, Array<{ id: string; lineIndex: number }>>();
  for (const [id, location] of locations) {
    if (desiredTaskIds.has(id)) continue;
    removedByPath.set(location.relativePath, [
      ...(removedByPath.get(location.relativePath) ?? []),
      { id, lineIndex: location.lineIndex },
    ]);
  }
  for (const [relativePath, removals] of removedByPath) {
    let source = currentSources.get(relativePath)!;
    for (const removal of removals.sort((left, right) => right.lineIndex - left.lineIndex)) {
      source = removeLine(source, removal.lineIndex);
      source = patchTaskMarkdownContent(source, removal.id, "");
    }
    currentSources.set(relativePath, source);
    changed.add(relativePath);
  }

  for (const project of desired.projects) {
    if (!project.id || !project.sourcePath || !byPath.has(project.sourcePath)) continue;
    const source = currentSources.get(project.sourcePath)!;
    let next = updateProjectFrontmatter(source, {
      publisher_id: project.id,
      status: project.status,
      area: project.area,
      priority: project.priority,
      progress: project.progress,
      focus_today: project.focusToday,
      start_date: project.startDate ?? null,
      end_date: project.endDate ?? null,
      target_date: null,
      completed_at: project.completedAt ?? null,
    });
    const parsed = parseProjectFrontmatter(source, project.sourcePath);
    if (parsed?.name !== project.name) next = replaceMarkdownDocumentTitle(next, project.name);
    if (project.body !== undefined && parsed?.body !== project.body) next = replaceMarkdownDocumentBody(next, project.body);
    if (next !== source) {
      currentSources.set(project.sourcePath, next);
      changed.add(project.sourcePath);
    }
  }

  for (const collection of desired.collections ?? []) {
    if (!collection.id || !collection.sourcePath || !byPath.has(collection.sourcePath)) continue;
    const source = currentSources.get(collection.sourcePath)!;
    let next = updateProjectFrontmatter(source, {
      publisher_id: collection.id,
      category: collection.category,
      importance: collection.importance,
    });
    const parsed = parseCollectionFrontmatter(source, collection.sourcePath);
    if (parsed?.name !== collection.name) next = replaceMarkdownDocumentTitle(next, collection.name);
    if (parsed?.body !== collection.body) next = replaceMarkdownDocumentBody(next, collection.body);
    if (next !== source) {
      currentSources.set(collection.sourcePath, next);
      changed.add(collection.sourcePath);
    }
  }

  for (const task of desired.tasks) {
    if (!task.id || !locations.has(task.id) || task.body === undefined) continue;
    const relativePath = locations.get(task.id)!.relativePath;
    const source = currentSources.get(relativePath)!;
    const next = patchTaskMarkdownContent(source, task.id, task.body);
    if (next !== source) {
      currentSources.set(relativePath, next);
      changed.add(relativePath);
    }
  }

  const missingTasks = desired.tasks.filter((task) => task.id && !locations.has(task.id));
  if (missingTasks.length > 0) {
    const inbox = byPath.get(INBOX_PATH);
    let source = inbox ? currentSources.get(INBOX_PATH)! : "# 待辦收件匣\r\n\r\n## 新增 Task\r\n";
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    for (const task of missingTasks) {
      if (source.includes(`\"id\":\"${task.id}\"`)) continue;
      if (!source.endsWith("\n")) source += newline;
      source += formatTaskLine({ ...task, sourcePath: INBOX_PATH }) + newline;
      if (task.body) source = patchTaskMarkdownContent(source, task.id!, task.body);
    }
    if (!inbox) {
      return [
        ...[...changed].sort().map((relativePath) => makeChange(byPath.get(relativePath)!, currentSources.get(relativePath)!)),
        {
          relativePath: INBOX_PATH,
          expectedSha256: EMPTY_SHA256,
          replacementBase64: encodeBase64(encoder.encode(source)),
          operation: "create" as const,
        },
      ];
    }
    if (source !== currentSources.get(INBOX_PATH)) {
      currentSources.set(INBOX_PATH, source);
      changed.add(INBOX_PATH);
    }
  }

  return [...changed]
    .sort()
    .map((relativePath) => makeChange(byPath.get(relativePath)!, currentSources.get(relativePath)!));
}

export function buildProjectDeleteChanges(
  files: LocalMarkdownFile[],
  snapshot: SyncSnapshot,
  projectId: string,
): MarkdownChange[] {
  const project = snapshot.projects.find((item) => item.id === projectId);
  if (!project?.sourcePath) throw new Error("PROJECT_SOURCE_NOT_FOUND");
  const source = files.find((file) => file.relativePath === project.sourcePath);
  if (!source) throw new Error("PROJECT_SOURCE_NOT_FOUND");
  const unlinkedTasks = snapshot.tasks.map((task) => task.projectId === projectId
    ? { ...task, projectId: null, projectName: null }
    : task);
  // Excluding the project file makes tasks stored inside it "missing", so the
  // normal local-first writer safely relocates them to the inbox before delete.
  const writes = applyDesiredSnapshot(files.filter((file) => file.relativePath !== project.sourcePath), {
    ...snapshot,
    tasks: unlinkedTasks,
    projects: snapshot.projects.filter((item) => item.id !== projectId),
  });
  return [...writes, {
    relativePath: project.sourcePath,
    expectedSha256: source.sha256,
    operation: "delete",
    replacementBase64: "",
  }];
}

export function buildCollectionDeleteChange(
  files: LocalMarkdownFile[],
  collection: Pick<BrainCollectionSnapshot, "id" | "sourcePath">,
): MarkdownChange {
  if (!collection.sourcePath) throw new Error("COLLECTION_SOURCE_NOT_FOUND");
  const source = files.find((file) => file.relativePath === collection.sourcePath);
  if (!source) throw new Error("COLLECTION_SOURCE_NOT_FOUND");
  return {
    relativePath: collection.sourcePath,
    expectedSha256: source.sha256,
    operation: "delete",
    replacementBase64: "",
  };
}
