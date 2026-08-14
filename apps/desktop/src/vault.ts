import {
  formatTaskLine,
  parseProjectFrontmatter,
  parseTaskLine,
  patchTaskLineMinimal,
  rankForIndex,
  updateProjectFrontmatter,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type SyncSnapshot,
} from "@second-brain/brain-core";

export interface LocalMarkdownFile {
  relativePath: string;
  sha256: string;
  bytesBase64: string;
}

export interface MarkdownChange {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
}

interface TaskLocation { relativePath: string; lineIndex: number; rawLine: string }

export interface StructuredVaultScan {
  snapshot: SyncSnapshot & { schemaVersion: 5 };
  bootstrapChanges: MarkdownChange[];
}

const INBOX_PATH = "10-收件匣/待辦收件匣.md";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

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
  const sources = new Map(files.map((file) => [file.relativePath, decodeFile(file)]));
  const changedSources = new Map<string, string>();

  for (const file of files) {
    const source = sources.get(file.relativePath)!;
    const project = parseProjectFrontmatter(source, file.relativePath);
    if (project) {
      const id = project.id ?? createId();
      const { frontmatterStart: _frontmatterStart, frontmatterEnd: _frontmatterEnd, ...snapshot } = project;
      projects.push({ ...snapshot, id, schemaVersion: 5 });
      if (!project.id) {
        const patched = updateProjectFrontmatter(source, { publisher_id: id });
        changedSources.set(file.relativePath, patched);
        sources.set(file.relativePath, patched);
      }
    }
  }
  assertUnique(projects.map((project) => project.id), "DUPLICATE_PROJECT_ID");
  const projectIdByName = new Map(projects.map((project) => [project.name, project.id]));

  for (const file of files) {
    let source = sources.get(file.relativePath)!;
    const lines = splitLines(source);
    for (let index = 0; index < lines.length; index += 1) {
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
        schemaVersion: 5,
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
      schemaVersion: 5,
      routineTemplates: [],
      tasks,
      projects,
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
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
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

  const removedByPath = new Map<string, number[]>();
  for (const [id, location] of locations) {
    if (desiredTaskIds.has(id)) continue;
    removedByPath.set(location.relativePath, [
      ...(removedByPath.get(location.relativePath) ?? []),
      location.lineIndex,
    ]);
  }
  for (const [relativePath, lineIndexes] of removedByPath) {
    let source = currentSources.get(relativePath)!;
    for (const lineIndex of lineIndexes.sort((left, right) => right - left)) {
      source = removeLine(source, lineIndex);
    }
    currentSources.set(relativePath, source);
    changed.add(relativePath);
  }

  for (const project of desired.projects) {
    if (!project.id || !project.sourcePath || !byPath.has(project.sourcePath)) continue;
    const source = currentSources.get(project.sourcePath)!;
    const next = updateProjectFrontmatter(source, {
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
    if (next !== source) {
      currentSources.set(project.sourcePath, next);
      changed.add(project.sourcePath);
    }
  }

  const missingTasks = desired.tasks.filter((task) => task.id && !locations.has(task.id));
  if (missingTasks.length > 0) {
    const inbox = byPath.get(INBOX_PATH);
    if (!inbox) throw new Error("INBOX_FILE_NOT_FOUND");
    let source = currentSources.get(INBOX_PATH)!;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    for (const task of missingTasks) {
      if (source.includes(`\"id\":\"${task.id}\"`)) continue;
      if (!source.endsWith("\n")) source += newline;
      source += formatTaskLine({ ...task, sourcePath: INBOX_PATH }) + newline;
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
