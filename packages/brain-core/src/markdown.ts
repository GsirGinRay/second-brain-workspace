import type {
  ParsedCollectionFrontmatter,
  BrainProjectSnapshot,
  BrainTaskSnapshot,
  ParsedMarkdownTask,
  ParsedProjectFrontmatter,
  TaskLineInput,
  TaskPriority,
  TaskStatus,
} from "./types";

export type TaskTokenKind =
  | "dueDate"
  | "plannedDate"
  | "completedAt"
  | "priority"
  | "project"
  | "startTime"
  | "duration";

export interface TaskTokenSpan {
  kind: TaskTokenKind;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  value?: string;
}

interface MarkerSpan {
  start: number;
  end: number;
  jsonStart: number;
  jsonEnd: number;
  value: Record<string, unknown>;
  /** The marker was present but its JSON payload could not be parsed. */
  parseFailed: boolean;
}

interface TaskLineAnalysis {
  rawLine: string;
  body: string;
  bodyStart: number;
  bodyEnd: number;
  checkboxStart: number;
  checkbox: string;
  tokenSpans: TaskTokenSpan[];
  marker: MarkerSpan | null;
  blockIdStart: number | null;
  projectSpan: TaskTokenSpan | null;
  priority: TaskPriority;
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

const PRIORITY_TO_TOKEN: Record<TaskPriority, string> = {
  highest: "\u{1F53A}",
  high: "\u{23EB}",
  medium: "\u{1F53C}",
  normal: "",
  low: "\u{1F53D}",
};

const TOKEN_TO_PRIORITY: Record<string, TaskPriority> = {
  "\u{1F53A}": "highest",
  "\u{23EB}": "high",
  "\u{1F53C}": "medium",
  "\u{1F53D}": "low",
};

const VALID_STATUSES = new Set<TaskStatus>(["todo", "doing", "waiting", "done"]);

/**
 * Ids the app generates are UUIDs, but ids authored elsewhere (older vaults,
 * other tools, hand-written notes) are legitimate too, so acceptance is by
 * safety rather than by UUID shape: the id is embedded in an HTML comment
 * marker, so it must be non-empty, bounded, and free of characters that could
 * break out of that marker or of the content-block delimiters derived from it.
 */
const UNSAFE_TASK_ID = /[^\w.@-]/;

export function isValidTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !UNSAFE_TASK_ID.test(value)
  );
}

/** Ids the app mints itself; used where a canonical UUID is required. */
const MANAGED_TASK_ID = /^[0-9a-f-]{36}$/i;

export function isManagedTaskId(value: unknown): value is string {
  return typeof value === "string" && MANAGED_TASK_ID.test(value);
}

const CODE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Track fenced code blocks line by line.
 *
 * Task syntax inside a fence is documentation ("this is what a task looks
 * like"), not a task. Without this, writing the format down in a note makes the
 * app adopt the example as a real task — and a placeholder id in that example
 * used to abort the entire vault scan.
 *
 * Returns a predicate that reports whether the given line is a fence delimiter
 * or sits inside one; callers skip those lines.
 */
export function createCodeFenceTracker(): (rawLine: string) => boolean {
  let open: string | null = null;
  return (rawLine: string) => {
    const line = rawLine.startsWith("﻿") ? rawLine.slice(1) : rawLine;
    const match = line.match(CODE_FENCE);
    if (match) {
      const marker = match[1]!;
      if (open === null) {
        open = marker;
        return true;
      }
      // A closing fence repeats the opening character, is at least as long,
      // and carries no info string.
      if (
        marker[0] === open[0] &&
        marker.length >= open.length &&
        line.slice(match[0].length).trim() === ""
      ) {
        open = null;
        return true;
      }
    }
    return open !== null;
  };
}

function parseMarker(value: string | undefined): Partial<BrainTaskSnapshot> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      // A malformed id (truncated write, hand-edited note, merge remnant) is
      // treated as absent so the task is re-adopted with a fresh id, instead of
      // being carried downstream where it used to throw and abort the scan.
      ...(isValidTaskId(parsed.id) ? { id: parsed.id } : {}),
      ...(typeof parsed.rank === "string" ? { rank: parsed.rank } : {}),
      ...(typeof parsed.status === "string" &&
      VALID_STATUSES.has(parsed.status as TaskStatus)
        ? { status: parsed.status as TaskStatus }
        : {}),
      ...(typeof parsed.startTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(parsed.startTime)
        ? { startTime: parsed.startTime }
        : {}),
      ...(typeof parsed.durationMinutes === "number" && Number.isInteger(parsed.durationMinutes) && parsed.durationMinutes >= 5 && parsed.durationMinutes <= 1440
        ? { durationMinutes: parsed.durationMinutes }
        : {}),
      ...(typeof parsed.timeZone === "string" && parsed.timeZone.length <= 100
        ? { timeZone: parsed.timeZone }
        : {}),
    };
  } catch {
    return {};
  }
}

function findDateSpans(
  body: string,
  bodyStart: number,
  icon: string,
  kind: TaskTokenKind,
): TaskTokenSpan[] {
  const spans: TaskTokenSpan[] = [];
  const expression = new RegExp(
    icon + "\\s*(\\d{4}-\\d{2}-\\d{2})(?=\\s|$)",
    "gu",
  );
  for (const match of body.matchAll(expression)) {
    const start = match.index ?? 0;
    const valueOffset = match[0].indexOf(match[1]);
    spans.push({
      kind,
      start: bodyStart + start,
      end: bodyStart + start + match[0].length,
      valueStart: bodyStart + start + valueOffset,
      valueEnd: bodyStart + start + valueOffset + match[1].length,
      value: match[1],
    });
  }
  return spans;
}

function findTimeSpans(
  body: string,
  bodyStart: number,
): TaskTokenSpan[] {
  const spans: TaskTokenSpan[] = [];
  const expression = /⏰\s*((?:[01]\d|2[0-3]):[0-5]\d)(?=\s|$)/gu;
  for (const match of body.matchAll(expression)) {
    const start = match.index ?? 0;
    const valueOffset = match[0].indexOf(match[1]!);
    spans.push({
      kind: "startTime",
      start: bodyStart + start,
      end: bodyStart + start + match[0].length,
      valueStart: bodyStart + start + valueOffset,
      valueEnd: bodyStart + start + valueOffset + match[1]!.length,
      value: match[1],
    });
  }
  return spans;
}

function findDurationSpans(
  body: string,
  bodyStart: number,
): TaskTokenSpan[] {
  const spans: TaskTokenSpan[] = [];
  const expression = /⏱\s*(\d{1,4})m(?=\s|$)/gu;
  for (const match of body.matchAll(expression)) {
    const start = match.index ?? 0;
    const valueOffset = match[0].indexOf(match[1]!);
    spans.push({
      kind: "duration",
      start: bodyStart + start,
      end: bodyStart + start + match[0].length,
      valueStart: bodyStart + start + valueOffset,
      valueEnd: bodyStart + start + valueOffset + match[1]!.length,
      value: match[1],
    });
  }
  return spans;
}

function analyzeTaskLine(rawLine: string): TaskLineAnalysis | null {
  const bomOffset = rawLine.startsWith("\uFEFF") ? 1 : 0;
  const normalizedLine = rawLine.slice(bomOffset);
  const header = normalizedLine.match(/^(\s*-\s*\[)([ xX])\]/);
  if (!header) return null;
  const taskPrefix = normalizedLine.match(/^\s*-\s*\[[ xX]\]\s+#task\b\s*/);
  if (!taskPrefix) return null;
  const bodyStart = bomOffset + taskPrefix[0].length;
  let bodyEnd = rawLine.length;
  while (bodyEnd > bodyStart && /\s/u.test(rawLine[bodyEnd - 1])) bodyEnd -= 1;
  const body = rawLine.slice(bodyStart, bodyEnd);
  const tokenSpans = [
    ...findDateSpans(body, bodyStart, "\u{1F4C5}", "dueDate"),
    ...findDateSpans(body, bodyStart, "\u{23F3}", "plannedDate"),
    ...findDateSpans(body, bodyStart, "\u2705", "completedAt"),
    ...findTimeSpans(body, bodyStart),
    ...findDurationSpans(body, bodyStart),
  ];

  const priorityEntries = Object.entries(TOKEN_TO_PRIORITY);
  for (const [token, priority] of priorityEntries) {
    const expression = new RegExp(
      "(?:^|\\s)(" + token + ")(?=\\s|$)",
      "gu",
    );
    const match = expression.exec(body);
    if (match) {
      const start = match.index + match[0].indexOf(token);
      tokenSpans.push({
        kind: "priority",
        start: bodyStart + start,
        end: bodyStart + start + token.length,
        valueStart: bodyStart + start,
        valueEnd: bodyStart + start + token.length,
        value: token,
      });
      break;
    }
  }

  const wikilinks = [...body.matchAll(/\[\[([^\]\n]+)\]\]/g)];
  const lastWikilink = wikilinks.at(-1);
  const projectSpan = lastWikilink
    ? {
        kind: "project" as const,
        start: bodyStart + (lastWikilink.index ?? 0),
        end:
          bodyStart +
          (lastWikilink.index ?? 0) +
          lastWikilink[0].length,
        valueStart:
          bodyStart +
          (lastWikilink.index ?? 0) +
          lastWikilink[0].indexOf(lastWikilink[1]),
        valueEnd:
          bodyStart +
          (lastWikilink.index ?? 0) +
          lastWikilink[0].indexOf(lastWikilink[1]) +
          lastWikilink[1].length,
        value: lastWikilink[1],
      }
    : null;
  if (projectSpan) tokenSpans.push(projectSpan);

  const markerMatch = body.match(
    /<!--\s*publisher-task:(\{[\s\S]*?\})\s*-->/,
  );
  const marker = markerMatch
    ? {
        start: bodyStart + (markerMatch.index ?? 0),
        end: bodyStart + (markerMatch.index ?? 0) + markerMatch[0].length,
        jsonStart:
          bodyStart +
          (markerMatch.index ?? 0) +
          markerMatch[0].indexOf(markerMatch[1]),
        jsonEnd:
          bodyStart +
          (markerMatch.index ?? 0) +
          markerMatch[0].indexOf(markerMatch[1]) +
          markerMatch[1].length,
        ...(() => {
          try {
            return {
              value: JSON.parse(markerMatch[1]) as Record<string, unknown>,
              parseFailed: false,
            };
          } catch {
            return { value: {} as Record<string, unknown>, parseFailed: true };
          }
        })(),
      }
    : null;
  const blockIdMatch = body.match(/\s+\^[A-Za-z0-9][A-Za-z0-9_-]*(?=\s|$)/);

  return {
    rawLine,
    body,
    bodyStart,
    bodyEnd,
    checkboxStart: bomOffset + header[1].length,
    checkbox: header[2],
    tokenSpans: tokenSpans.sort((left, right) => left.start - right.start),
    marker,
    blockIdStart: blockIdMatch
      ? bodyStart + (blockIdMatch.index ?? 0)
      : null,
    projectSpan,
    priority:
      tokenSpans.find((span) => span.kind === "priority")?.value
        ? TOKEN_TO_PRIORITY[
            tokenSpans.find((span) => span.kind === "priority")?.value ?? ""
          ]
        : "normal",
  };
}

function replaceRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
  let result = source;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + " " + result.slice(range.end);
  }
  return result;
}

function parsedTaskFromAnalysis(
  analysis: TaskLineAnalysis,
  sourcePath: string,
  lineIndex: number,
): ParsedMarkdownTask {
  const markerRange = analysis.marker
    ? [{ start: analysis.marker.start, end: analysis.marker.end }]
    : [];
  const tokenRanges = analysis.tokenSpans
    .filter((span) => span.kind !== "project")
    .map((span) => ({ start: span.start, end: span.end }));
  const projectRange = analysis.projectSpan
    ? [{ start: analysis.projectSpan.start, end: analysis.projectSpan.end }]
    : [];
  const titleBody = replaceRanges(
    analysis.rawLine.slice(analysis.bodyStart, analysis.bodyEnd),
    [
      ...markerRange.map((range) => ({
        start: range.start - analysis.bodyStart,
        end: range.end - analysis.bodyStart,
      })),
      ...tokenRanges.map((range) => ({
        start: range.start - analysis.bodyStart,
        end: range.end - analysis.bodyStart,
      })),
      ...projectRange.map((range) => ({
        start: range.start - analysis.bodyStart,
        end: range.end - analysis.bodyStart,
      })),
    ],
  );
  const markerValues = analysis.marker
    ? parseMarker(JSON.stringify(analysis.marker.value))
    : {};
  const status: TaskStatus =
    analysis.checkbox.toLowerCase() === "x"
      ? "done"
      : markerValues.status ?? "todo";
  const dateValue = (kind: TaskTokenKind) =>
    analysis.tokenSpans.find((span) => span.kind === kind)?.value ?? null;
  const visibleStart = dateValue("startTime");
  const visibleDuration = dateValue("duration");
  const parsedDuration = visibleDuration ? Number(visibleDuration) : NaN;
  const durationFromToken =
    Number.isInteger(parsedDuration) && parsedDuration >= 5 && parsedDuration <= 1440
      ? parsedDuration
      : null;
  const startTime = visibleStart ?? markerValues.startTime ?? null;
  const rawMarkerId = analysis.marker?.value.id;
  const markerIssue: ParsedMarkdownTask["markerIssue"] = analysis.marker
    ? analysis.marker.parseFailed
      ? "unparsable"
      : rawMarkerId != null && rawMarkerId !== "" && !isValidTaskId(rawMarkerId)
        ? "unsafe-id"
        : undefined
    : undefined;
  return {
    ...(markerIssue ? { markerIssue } : {}),
    id: markerValues.id ?? null,
    title: titleBody.replace(/\s+/g, " ").trim(),
    status,
    taskDate: dateValue("plannedDate") ?? dateValue("dueDate"),
    priority: analysis.priority,
    projectId: null,
    projectName: analysis.projectSpan?.value ?? null,
    rank: markerValues.rank ?? "",
    sourcePath,
    sourceHeading: null,
    completedAt: dateValue("completedAt"),
    startTime,
    durationMinutes: startTime
      ? (durationFromToken ?? markerValues.durationMinutes ?? 30)
      : null,
    timeZone: markerValues.timeZone ?? "Asia/Taipei",
    lineIndex,
    rawLine: analysis.rawLine,
  };
}

export function parseTaskLine(
  line: string,
  sourcePath: string,
  lineIndex: number,
): ParsedMarkdownTask | null {
  const analysis = analyzeTaskLine(line);
  return analysis ? parsedTaskFromAnalysis(analysis, sourcePath, lineIndex) : null;
}

export function formatTaskLine(task: TaskLineInput): string {
  const parts = [
    "- [" + (task.status === "done" ? "x" : " ") + "] #task",
    task.title.trim() || "(無標題)",
  ];
  if (task.projectName) parts.push("[[" + task.projectName + "]]");
  const priority = PRIORITY_TO_TOKEN[task.priority];
  if (priority) parts.push(priority);
  const taskDate = task.taskDate ?? task.plannedDate ?? task.dueDate ?? null;
  if (taskDate) parts.push("\u{23F3} " + taskDate);
  if (task.startTime) {
    parts.push("\u{23F0} " + task.startTime);
    parts.push("\u{23F1} " + (task.durationMinutes ?? 30) + "m");
  }
  if (task.status === "done" && task.completedAt) {
    parts.push("\u2705 " + task.completedAt);
  }
  const marker = {
    id: task.id,
    status: task.status,
    rank: task.rank,
    ...(task.startTime ? {
      startTime: task.startTime,
      durationMinutes: task.durationMinutes ?? 30,
      timeZone: task.timeZone ?? "Asia/Taipei",
    } : {}),
  };
  parts.push(
    "<!-- publisher-task:" +
      JSON.stringify(marker) +
      " -->",
  );
  return parts.join(" ");
}

function findSpan(
  analysis: TaskLineAnalysis,
  kind: TaskTokenKind,
): TaskTokenSpan | undefined {
  return analysis.tokenSpans.find((span) => span.kind === kind);
}

function removeSpan(rawLine: string, span: TaskTokenSpan): Edit {
  let start = span.start;
  let end = span.end;
  if (start > 0 && /\s/u.test(rawLine[start - 1])) start -= 1;
  else if (end < rawLine.length && /\s/u.test(rawLine[end])) end += 1;
  return { start, end, replacement: "" };
}

function tokenInsertionPoint(analysis: TaskLineAnalysis): number {
  return Math.min(
    analysis.marker?.start ?? analysis.bodyEnd,
    analysis.blockIdStart ?? analysis.bodyEnd,
  );
}

function addTokenEdit(
  rawLine: string,
  analysis: TaskLineAnalysis,
  token: string,
): Edit {
  const start = tokenInsertionPoint(analysis);
  const before = rawLine[start - 1];
  const after = rawLine[start];
  const prefix = before && !/\s/u.test(before) ? " " : "";
  const suffix = after && !/\s/u.test(after) ? " " : "";
  return { start, end: start, replacement: prefix + token + suffix };
}

function scheduleTokenEdits(
  rawLine: string,
  analysis: TaskLineAnalysis,
  startTime: string | null,
  durationMinutes: number | null,
): Edit[] {
  const edits: Edit[] = [];
  const timeSpan = findSpan(analysis, "startTime");
  const durationSpan = findSpan(analysis, "duration");
  if (!startTime) {
    if (timeSpan) edits.push(removeSpan(rawLine, timeSpan));
    if (durationSpan) edits.push(removeSpan(rawLine, durationSpan));
    return edits;
  }
  const duration = durationMinutes ?? 30;
  if (!timeSpan && !durationSpan) {
    edits.push(addTokenEdit(rawLine, analysis, `\u{23F0} ${startTime} \u{23F1} ${duration}m`));
    return edits;
  }
  if (timeSpan) {
    if (timeSpan.value !== startTime) {
      edits.push({
        start: timeSpan.valueStart,
        end: timeSpan.valueEnd,
        replacement: startTime,
      });
    }
  } else {
    edits.push(addTokenEdit(rawLine, analysis, `\u{23F0} ${startTime}`));
  }
  const durationText = String(duration);
  if (durationSpan) {
    if (durationSpan.value !== durationText) {
      edits.push({
        start: durationSpan.valueStart,
        end: durationSpan.valueEnd,
        replacement: durationText,
      });
    }
  } else {
    edits.push(addTokenEdit(rawLine, analysis, `\u{23F1} ${duration}m`));
  }
  return edits;
}

/** Add visible ⏰ / ⏱ tokens when JSON still holds the schedule. Does not strip dates. */
export function withVisibleScheduleTokens(
  rawLine: string,
  startTime: string | null,
  durationMinutes: number | null,
): string {
  if (!startTime) return rawLine;
  const analysis = analyzeTaskLine(rawLine);
  if (!analysis) return rawLine;
  const edits = scheduleTokenEdits(rawLine, analysis, startTime, durationMinutes);
  return edits.length ? applyEdits(rawLine, edits) : rawLine;
}

function markerFieldEdit(
  rawLine: string,
  marker: MarkerSpan,
  key: string,
  value: string | null,
): Edit | null {
  const json = rawLine.slice(marker.jsonStart, marker.jsonEnd);
  const expression = new RegExp(
    '("' +
      key +
      '"\\s*:\\s*)(("(?:\\\\.|[^"\\\\])*")|null)',
  );
  const match = expression.exec(json);
  if (!match) return null;
  const start = marker.jsonStart + match.index + match[1].length;
  return { start, end: start + match[2].length, replacement: JSON.stringify(value) };
}

function patchMarker(
  rawLine: string,
  analysis: TaskLineAnalysis,
  current: ParsedMarkdownTask,
  desired: TaskLineInput,
): Edit[] {
  const values: Record<string, unknown> = {
    id: desired.id,
    status: desired.status,
    rank: desired.rank,
    ...(desired.startTime ? {
      startTime: desired.startTime,
      durationMinutes: desired.durationMinutes ?? 30,
      timeZone: desired.timeZone ?? "Asia/Taipei",
    } : {}),
  };
  if (analysis.marker) {
    const managedKeys = ["id", "status", "rank", "startTime", "durationMinutes", "timeZone"];
    const nextMarker = { ...analysis.marker.value };
    for (const key of managedKeys) delete nextMarker[key];
    Object.assign(nextMarker, values);
    const replacement = JSON.stringify(nextMarker);
    const currentJson = rawLine.slice(analysis.marker.jsonStart, analysis.marker.jsonEnd);
    return replacement === currentJson ? [] : [{
      start: analysis.marker.jsonStart,
      end: analysis.marker.jsonEnd,
      replacement,
    }];
  }
  if (
    desired.id === current.id &&
    desired.status === current.status &&
    desired.rank === current.rank
    && (desired.startTime ?? null) === (current.startTime ?? null)
    && (desired.durationMinutes ?? null) === (current.durationMinutes ?? null)
    && (desired.timeZone ?? "Asia/Taipei") === (current.timeZone ?? "Asia/Taipei")
  ) {
    return [];
  }
  return [
    {
      start: tokenInsertionPoint(analysis),
      end: tokenInsertionPoint(analysis),
      replacement:
        (rawLine[tokenInsertionPoint(analysis) - 1] &&
        !/\s/u.test(rawLine[tokenInsertionPoint(analysis) - 1])
          ? " "
          : "") +
        "<!-- publisher-task:" +
        JSON.stringify(values) +
        " -->",
    },
  ];
}

function patchDate(
  rawLine: string,
  analysis: TaskLineAnalysis,
  kind: TaskTokenKind,
  icon: string,
  currentValue: string | null,
  desiredValue: string | null | undefined,
): Edit | null {
  if (desiredValue === undefined || desiredValue === currentValue) return null;
  const span = findSpan(analysis, kind);
  if (span && desiredValue) {
    return {
      start: span.valueStart,
      end: span.valueEnd,
      replacement: desiredValue,
    };
  }
  if (span) return removeSpan(rawLine, span);
  if (desiredValue) return addTokenEdit(rawLine, analysis, icon + " " + desiredValue);
  return null;
}

function applyEdits(rawLine: string, edits: Edit[]): string {
  const ordered = [...edits]
    .filter((edit) => edit.start <= edit.end)
    .sort((left, right) => right.start - left.start);
  let output = rawLine;
  for (const edit of ordered) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

export function patchTaskLine(
  rawOrParsed: string | Pick<ParsedMarkdownTask, "rawLine">,
  desired: TaskLineInput,
): string {
  const rawLine = typeof rawOrParsed === "string" ? rawOrParsed : rawOrParsed.rawLine;
  const analysis = analyzeTaskLine(rawLine);
  if (!analysis) return rawLine;
  const current = parsedTaskFromAnalysis(analysis, "", -1);
  const edits: Edit[] = [];
  const checked = desired.status === "done" ? "x" : " ";
  if (analysis.checkbox.toLowerCase() !== checked) {
    edits.push({ start: analysis.checkboxStart, end: analysis.checkboxStart + 1, replacement: checked });
  }
  const desiredTaskDate = desired.taskDate ?? desired.plannedDate ?? desired.dueDate ?? null;
  // V3 has one task date. Always remove the legacy due token during a write.
  const dueSpan = findSpan(analysis, "dueDate");
  const plannedSpan = findSpan(analysis, "plannedDate");
  if (!plannedSpan && dueSpan && desiredTaskDate) {
    edits.push({ start: dueSpan.start, end: dueSpan.end, replacement: `\u{23F3} ${desiredTaskDate}` });
  } else {
    if (dueSpan) edits.push(removeSpan(rawLine, dueSpan));
    // The parsed snapshot exposes the effective date as `taskDate`, so the
    // current planned token value must be read from the analysis span itself.
    // Passing `current.plannedDate ?? null` would always be null and make
    // removing a planned date a no-op (patchDate treats null === null).
    const plannedEdit = patchDate(rawLine, analysis, "plannedDate", "\u{23F3}", plannedSpan?.value ?? null, desiredTaskDate);
    if (plannedEdit) edits.push(plannedEdit);
  }
  const completedShouldChange =
    desired.completedAt !== current.completedAt ||
    (desired.status === "done" && desired.completedAt !== null);
  if (completedShouldChange) {
    const completedEdit = patchDate(
      rawLine,
      analysis,
      "completedAt",
      "\u2705",
      current.completedAt,
      desired.completedAt,
    );
    if (completedEdit) edits.push(completedEdit);
  }

  if (desired.priority !== current.priority) {
    const span = findSpan(analysis, "priority");
    if (span && desired.priority === "normal") edits.push(removeSpan(rawLine, span));
    else if (span) {
      edits.push({
        start: span.start,
        end: span.end,
        replacement: PRIORITY_TO_TOKEN[desired.priority],
      });
    } else if (desired.priority !== "normal") {
      edits.push(addTokenEdit(rawLine, analysis, PRIORITY_TO_TOKEN[desired.priority]));
    }
  }

  if (desired.projectName !== current.projectName) {
    if (analysis.projectSpan && desired.projectName) {
      edits.push({
        start: analysis.projectSpan.valueStart,
        end: analysis.projectSpan.valueEnd,
        replacement: desired.projectName,
      });
    } else if (analysis.projectSpan) {
      edits.push(removeSpan(rawLine, analysis.projectSpan));
    } else if (desired.projectName) {
      edits.push(addTokenEdit(rawLine, analysis, "[[" + desired.projectName + "]]"));
    }
  }

  edits.push(
    ...scheduleTokenEdits(
      rawLine,
      analysis,
      desired.startTime ?? null,
      desired.startTime ? (desired.durationMinutes ?? 30) : null,
    ),
  );

  edits.push(...patchMarker(rawLine, analysis, current, desired));

  if (desired.title !== current.title) {
    const firstToken = analysis.tokenSpans
      .map((span) => span.start)
      .concat(
        analysis.marker?.start ?? [],
        analysis.blockIdStart ?? [],
      )
      .filter((position) => position >= analysis.bodyStart)
      .sort((left, right) => left - right)[0];
    const titleEnd = firstToken ?? analysis.bodyEnd;
    const titleStart = analysis.bodyStart + (rawLine.slice(analysis.bodyStart, titleEnd).match(/^\s*/)?.[0].length ?? 0);
    edits.push({ start: titleStart, end: titleEnd, replacement: desired.title });
  }

  return edits.length ? applyEdits(rawLine, edits) : rawLine;
}

export const patchTaskLineMinimal = patchTaskLine;

function parseScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function stringifyScalar(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function parseProjectFrontmatter(
  source: string,
  sourcePath: string,
): ParsedProjectFrontmatter | null {
  const content = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return null;
  const values = new Map<string, string | number | boolean | null>();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) values.set(match[1], parseScalar(match[2]));
  }
  if (values.get("type") !== "project") return null;
  const bodyLines = lines.slice(closing + 1);
  const headingIndex = bodyLines.findIndex((line) => /^#\s+/.test(line));
  const heading = headingIndex < 0 ? undefined : bodyLines[headingIndex]!.replace(/^#\s+/, "").trim();
  if (!heading) return null;
  return {
    id:
      typeof values.get("publisher_id") === "string"
        ? (values.get("publisher_id") as string)
        : null,
    name: heading,
    sourcePath,
    status: String(values.get("status") ?? "active"),
    area: values.get("area") == null ? null : String(values.get("area")),
    priority:
      typeof values.get("priority") === "number"
        ? (values.get("priority") as number)
        : null,
    progress:
      typeof values.get("progress") === "number"
        ? (values.get("progress") as number)
        : null,
    focusToday: values.get("focus_today") === true,
    startDate:
      values.get("start_date") == null ? null : String(values.get("start_date")),
    endDate:
      values.get("end_date") == null
        ? values.get("target_date") == null
          ? null
          : String(values.get("target_date"))
        : String(values.get("end_date")),
    completedAt:
      values.get("completed_at") == null
        ? null
        : String(values.get("completed_at")),
    body: bodyLines.slice(headingIndex + 1).join("\n").trim(),
    frontmatterStart: 0,
    frontmatterEnd: closing,
  };
}

const TASK_CONTENT_PREFIX = "second-brain-task-content";
const TASK_BODY_INDENT = "  ";
const LEGACY_TASK_CONTENT_MARKER =
  /^\s*<!--\s*second-brain-task-content:[^:]+:(?:start|end)\s*-->\s*$/i;

function taskContentMarkers(id: string): { start: string; end: string } {
  if (!isManagedTaskId(id)) throw new Error("TASK_ID_INVALID");
  return {
    start: `<!-- ${TASK_CONTENT_PREFIX}:${id}:start -->`,
    end: `<!-- ${TASK_CONTENT_PREFIX}:${id}:end -->`,
  };
}

function looksLikeTaskLine(rawLine: string): boolean {
  const line = rawLine.startsWith("\uFEFF") ? rawLine.slice(1) : rawLine;
  if (isBodyContinuation(line)) return false;
  return /^\s*-\s*\[[ xX]\]\s+#task\b/.test(line);
}

function isBodyContinuation(line: string): boolean {
  return line.startsWith("  ") || line.startsWith("\t");
}

function unindentBodyLine(line: string): string {
  if (line.startsWith("\t")) return line.slice(1);
  if (line.startsWith("  ")) return line.slice(2);
  return line;
}

function splitSourceLines(source: string): string[] {
  return source.split(/\r?\n/);
}

/** First line index after the indented notes that belong to the task at `taskLineIndex`. */
export function endIndexOfTaskBody(
  lines: readonly string[],
  taskLineIndex: number,
): number {
  let index = taskLineIndex + 1;
  if (index >= lines.length) return index;
  if (lines[index]!.trim() === "") {
    let peek = index + 1;
    while (peek < lines.length && lines[peek]!.trim() === "") peek += 1;
    if (
      peek >= lines.length
      || !isBodyContinuation(lines[peek]!)
      || looksLikeTaskLine(lines[peek]!)
      || LEGACY_TASK_CONTENT_MARKER.test(lines[peek]!)
    ) {
      return taskLineIndex + 1;
    }
  } else if (
    !isBodyContinuation(lines[index]!)
    || looksLikeTaskLine(lines[index]!)
    || LEGACY_TASK_CONTENT_MARKER.test(lines[index]!)
  ) {
    return taskLineIndex + 1;
  }
  while (index < lines.length) {
    const line = lines[index]!;
    if (LEGACY_TASK_CONTENT_MARKER.test(line)) break;
    if (isBodyContinuation(line)) {
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      let peek = index + 1;
      while (peek < lines.length && lines[peek]!.trim() === "") peek += 1;
      if (
        peek < lines.length
        && isBodyContinuation(lines[peek]!)
        && !looksLikeTaskLine(lines[peek]!)
      ) {
        index += 1;
        continue;
      }
      break;
    }
    if (looksLikeTaskLine(line)) break;
    break;
  }
  return index;
}

function extractIndentedTaskBody(source: string, taskLineIndex: number): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitSourceLines(source);
  const end = endIndexOfTaskBody(lines, taskLineIndex);
  const raw = lines.slice(taskLineIndex + 1, end);
  while (raw.length > 0 && raw[0]!.trim() === "") raw.shift();
  while (raw.length > 0 && raw[raw.length - 1]!.trim() === "") raw.pop();
  if (raw.length === 0) return "";
  return raw.map(unindentBodyLine).join(newline);
}

function findTaskLineIndexById(source: string, id: string): number {
  const lines = splitSourceLines(source);
  const inCodeFence = createCodeFenceTracker();
  let insideComment = false;
  let skipUntil = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (inCodeFence(line)) continue;
    if (LEGACY_TASK_CONTENT_MARKER.test(line)) {
      insideComment = /:start\s*-->\s*$/i.test(line);
      continue;
    }
    if (insideComment) continue;
    if (index < skipUntil) continue;
    const parsed = parseTaskLine(line, "", index);
    if (!parsed) continue;
    skipUntil = endIndexOfTaskBody(lines, index);
    if (parsed.id === id) return index;
  }
  return -1;
}

function extractLegacyTaskComment(source: string, id: string): string {
  if (!isManagedTaskId(id)) return "";
  const markers = taskContentMarkers(id);
  const start = source.indexOf(markers.start);
  if (start < 0) return "";
  const bodyStart = start + markers.start.length;
  const end = source.indexOf(markers.end, bodyStart);
  if (end < 0) return "";
  return source.slice(bodyStart, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function removeLegacyTaskComment(source: string, id: string): string {
  if (!isManagedTaskId(id)) return source;
  const markers = taskContentMarkers(id);
  const start = source.indexOf(markers.start);
  if (start < 0) return source;
  const end = source.indexOf(markers.end, start + markers.start.length);
  if (end < 0) throw new Error("TASK_BODY_MARKER_INVALID");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let removeStart = start;
  let removeEnd = end + markers.end.length;
  if (source.slice(removeEnd, removeEnd + newline.length) === newline) {
    removeEnd += newline.length;
  }
  if (
    removeStart >= newline.length
    && source.slice(removeStart - newline.length, removeStart) === newline
  ) {
    removeStart -= newline.length;
  }
  const next = source.slice(0, removeStart) + source.slice(removeEnd);
  if ((source.endsWith("\r\n") || source.endsWith("\n")) && !next.endsWith("\n")) {
    return next + newline;
  }
  return next;
}

function replaceIndentedTaskBody(
  source: string,
  taskLineIndex: number,
  body: string,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = source.endsWith("\r\n") || source.endsWith("\n");
  const lines = splitSourceLines(source);
  if (trailing) lines.pop();
  if (taskLineIndex < 0 || taskLineIndex >= lines.length) return source;
  const end = endIndexOfTaskBody(lines, taskLineIndex);
  const next = lines.slice(0, taskLineIndex + 1);
  if (body.trim()) {
    const normalized = body.replace(/\r?\n/g, newline).replace(/^\r?\n+|\r?\n+$/g, "");
    next.push("");
    for (const line of normalized.split(newline)) {
      next.push(line.length ? TASK_BODY_INDENT + line : TASK_BODY_INDENT);
    }
  }
  next.push(...lines.slice(end));
  return next.join(newline) + (trailing ? newline : "");
}

export function extractTaskMarkdownContent(source: string, id: string): string {
  // Notes live with the task: ordinary Markdown indented under the list item.
  // Legacy HTML comment blocks (often parked at the end of the file) are still
  // read and merged, so a project outline under the task is not discarded when
  // older writes hid extra notes in comments.
  const lineIndex = findTaskLineIndexById(source, id);
  const indented = lineIndex >= 0 ? extractIndentedTaskBody(source, lineIndex) : "";
  const comment = extractLegacyTaskComment(source, id);
  if (indented && comment) {
    if (indented.includes(comment)) return indented;
    if (comment.includes(indented)) return comment;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return indented + newline + newline + comment;
  }
  return indented || comment;
}

export function patchTaskMarkdownContent(source: string, id: string, body: string): string {
  if (body.length > 2_000_000) throw new Error("TASK_BODY_TOO_LARGE");
  if (body.includes(`<!-- ${TASK_CONTENT_PREFIX}:`)) throw new Error("TASK_BODY_MARKER_CONFLICT");
  const withoutComment = removeLegacyTaskComment(source, id);
  const lineIndex = findTaskLineIndexById(withoutComment, id);
  if (lineIndex < 0) {
    // Refuse to write against an id we cannot locate; one bad marker must not
    // fail the whole batch.
    return withoutComment;
  }
  return replaceIndentedTaskBody(withoutComment, lineIndex, body);
}

export function replaceMarkdownDocumentBody(source: string, body: string): string {
  if (body.length > 2_000_000) throw new Error("MARKDOWN_BODY_TOO_LARGE");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? source.slice(1) : source;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const closing = lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && line === "---") : -1;
  const headingIndex = lines.findIndex((line, index) => index > closing && /^#\s+/.test(line));
  if (headingIndex < 0) throw new Error("MARKDOWN_HEADING_NOT_FOUND");
  const prefix = lines.slice(0, headingIndex + 1).join(newline);
  const normalizedBody = body.replace(/\r?\n/g, newline).replace(/^\r?\n+|\r?\n+$/g, "");
  return bom + prefix + newline + (normalizedBody ? newline + normalizedBody + newline : newline);
}

export function replaceMarkdownDocumentTitle(source: string, title: string): string {
  const normalized = title.normalize("NFKC").replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
  if (!normalized || normalized.length > 200) throw new Error("INVALID_MARKDOWN_TITLE");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? source.slice(1) : source;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const closing = lines[0] === "---" ? lines.findIndex((line, index) => index > 0 && line === "---") : -1;
  const headingIndex = lines.findIndex((line, index) => index > closing && /^#\s+/.test(line));
  if (headingIndex < 0) throw new Error("MARKDOWN_HEADING_NOT_FOUND");
  lines[headingIndex] = `# ${normalized}`;
  return bom + lines.join(newline);
}

export function parseCollectionFrontmatter(
  source: string,
  sourcePath: string,
): ParsedCollectionFrontmatter | null {
  const content = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return null;
  const values = new Map<string, string | number | boolean | null>();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) values.set(match[1], parseScalar(match[2]));
  }
  if (values.get("type") !== "collection") return null;
  const bodyLines = lines.slice(closing + 1);
  const headingIndex = bodyLines.findIndex((line) => /^#\s+/.test(line));
  if (headingIndex < 0) return null;
  const name = bodyLines[headingIndex]!.replace(/^#\s+/, "").trim();
  if (!name) return null;
  return {
    id: typeof values.get("publisher_id") === "string"
      ? String(values.get("publisher_id"))
      : null,
    name,
    sourcePath,
    category: values.get("category") == null ? null : String(values.get("category")),
    importance: typeof values.get("importance") === "number"
      && [1, 2, 3].includes(Number(values.get("importance")))
      ? Number(values.get("importance"))
      : null,
    body: bodyLines.slice(headingIndex + 1).join("\n").trim(),
    frontmatterStart: 0,
    frontmatterEnd: closing,
  };
}

export function updateProjectFrontmatter(
  source: string,
  updates: Record<string, string | number | boolean | null>,
): string {
  if (Object.keys(updates).length === 0) return source;
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const content = bom ? source.slice(1) : source;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") return source;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) return source;
  for (const [key, value] of Object.entries(updates)) {
    const line = key + ": " + stringifyScalar(value);
    const index = lines.findIndex(
      (candidate, lineIndex) =>
        lineIndex > 0 &&
        lineIndex < closing &&
        candidate.startsWith(key + ":"),
    );
    if (index >= 0) lines[index] = line;
    else lines.splice(closing, 0, line);
  }
  return bom + lines.join(newline);
}
