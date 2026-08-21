import type { BrainTaskSnapshot, RoutineTemplate } from "./types";

const DEFAULT_TEMPLATE_ID = "2b87f52f-e782-4e10-9d16-000000000001";

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function routineTaskId(templateId: string, itemId: string, date: string): string {
  const value = `${templateId}:${itemId}:${date}`;
  const words = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d].map((seed) => hash32(value, seed));
  const hex = words.map((word) => word.toString(16).padStart(8, "0")).join("").split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function createDefaultRoutineTemplate(templateId = DEFAULT_TEMPLATE_ID): RoutineTemplate {
  const titles = [
    "確認今日行程與會議",
    "確認今天誰生日並傳送祝福",
    "檢查並回覆電子郵件",
    "運動",
    "今日喝足 3000cc 水",
    "背英文單字",
  ];
  return {
    id: templateId,
    name: "每日啟動模板",
    version: 1,
    updatedAt: new Date(0).toISOString(),
    items: titles.map((title, index) => ({
      id: routineTaskId(templateId, `starter-${index}`, "template").replace(/^(.{8}-.{4})-5/, "$1-4"),
      title,
      enabled: true,
      projectId: null,
      projectName: null,
      priority: "normal",
      startTime: null,
      durationMinutes: null,
      rank: String(index).padStart(8, "0"),
    })),
  };
}

/**
 * A day owns exactly one P1, so a template must never describe more than one.
 * Keeps the first enabled P1 by rank and demotes every other P1 row to P2.
 * Returns the template untouched when it already holds at most one P1.
 */
export function enforceTemplateSingleP1(template: RoutineTemplate): RoutineTemplate {
  const contenders = [...template.items]
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id))
    .filter((item) => item.priority === "highest");
  if (contenders.length < 2) return template;
  const winner = contenders.find((item) => item.enabled) ?? contenders[0]!;
  return {
    ...template,
    items: template.items.map((item) =>
      item.priority === "highest" && item.id !== winner.id
        ? { ...item, priority: "high" as const }
        : item),
  };
}

export function applyRoutineTemplate(
  template: RoutineTemplate,
  existing: readonly BrainTaskSnapshot[],
  date: string,
): { tasks: BrainTaskSnapshot[]; created: BrainTaskSnapshot[] } {
  const ids = new Set(existing.flatMap((task) => task.id ? [task.id] : []));
  // A day owns exactly one P1. A P1 already on the board for that date keeps it; otherwise the
  // first enabled row by rank claims it and every later P1 row is created as P2 instead.
  let p1Claimed = existing.some((task) => task.taskDate === date && task.priority === "highest");
  const created = template.items
    .filter((item) => item.enabled)
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .flatMap((item) => {
      const id = routineTaskId(template.id, item.id, date);
      if (ids.has(id)) return [];
      let priority = item.priority;
      if (priority === "highest") {
        if (p1Claimed) priority = "high";
        else p1Claimed = true;
      }
      return [{
        id,
        title: item.title.trim(),
        status: "todo" as const,
        taskDate: date,
        priority,
        projectId: item.projectId,
        projectName: item.projectName,
        rank: item.rank,
        sourcePath: null,
        sourceHeading: null,
        completedAt: null,
        startTime: item.startTime,
        durationMinutes: item.startTime ? (item.durationMinutes ?? 30) : null,
        timeZone: "Asia/Taipei",
        schemaVersion: 5 as const,
      }];
    });
  return { tasks: [...existing, ...created], created };
}
