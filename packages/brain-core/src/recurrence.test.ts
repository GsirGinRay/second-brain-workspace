import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskLine, parseTaskLine, patchTaskLine } from "./markdown";
import { describeRecurrence, formatRecurrence, nextOccurrence, parseRecurrence } from "./recurrence";

const rule = (text: string) => {
  const parsed = parseRecurrence(text);
  assert.ok(parsed, `expected "${text}" to parse`);
  return parsed;
};

test("parses the Obsidian Tasks wording and formats it canonically", () => {
  const cases: Array<[string, string]> = [
    ["every day", "every day"],
    ["Every 3 days", "every 3 days"],
    ["every weekday", "every weekday"],
    ["every week", "every week"],
    ["every 2 weeks", "every 2 weeks"],
    ["every week on Monday, Thursday", "every week on Monday, Thursday"],
    ["every Monday and Friday", "every week on Monday, Friday"],
    ["every month", "every month"],
    ["every month on the 5th", "every month on the 5th"],
    ["every month on the last", "every month on the last"],
    ["every year", "every year"],
  ];
  for (const [input, canonical] of cases) assert.equal(formatRecurrence(rule(input)), canonical);
});

test("rejects rules it does not understand", () => {
  for (const input of ["every", "every 0 days", "every week on Funday", "every month on the 32nd", "daily", "every day on Monday"]) {
    assert.equal(parseRecurrence(input), null, input);
  }
});

test("computes the next occurrence after a date", () => {
  assert.equal(nextOccurrence(rule("every day"), "2026-10-20"), "2026-10-21");
  assert.equal(nextOccurrence(rule("every 3 days"), "2026-10-30"), "2026-11-02");
  // 2026-10-23 is a Friday.
  assert.equal(nextOccurrence(rule("every weekday"), "2026-10-23"), "2026-10-26");
  assert.equal(nextOccurrence(rule("every week"), "2026-10-20"), "2026-10-27");
  // 2026-10-20 is a Tuesday.
  assert.equal(nextOccurrence(rule("every week on Monday, Thursday"), "2026-10-20"), "2026-10-22");
  assert.equal(nextOccurrence(rule("every week on Monday, Thursday"), "2026-10-22"), "2026-10-26");
  assert.equal(nextOccurrence(rule("every 2 weeks on Monday"), "2026-10-19"), "2026-11-02");
  assert.equal(nextOccurrence(rule("every month on the 5th"), "2026-10-03"), "2026-10-05");
  assert.equal(nextOccurrence(rule("every month on the 5th"), "2026-10-05"), "2026-11-05");
  assert.equal(nextOccurrence(rule("every month on the 31st"), "2026-01-31"), "2026-02-28");
  assert.equal(nextOccurrence(rule("every month on the 31st"), "2026-02-28"), "2026-03-31");
  assert.equal(nextOccurrence(rule("every month on the last"), "2026-02-28"), "2026-03-31");
  assert.equal(nextOccurrence(rule("every month"), "2026-10-20"), "2026-11-20");
  assert.equal(nextOccurrence(rule("every year"), "2028-02-29"), "2029-02-28");
});

test("describes rules in both languages", () => {
  assert.equal(describeRecurrence(rule("every week on Monday, Wednesday"), "zh-TW"), "每週一、三");
  assert.equal(describeRecurrence(rule("every 2 weeks"), "zh-TW"), "每 2 週");
  assert.equal(describeRecurrence(rule("every 3 months"), "zh-TW"), "每 3 個月");
  assert.equal(describeRecurrence(rule("every month on the 5th"), "zh-TW"), "每月 5 號");
  assert.equal(describeRecurrence(rule("every weekday"), "en"), "Every weekday");
  assert.equal(describeRecurrence(rule("every month on the 22nd"), "en"), "Every month on the 22nd");
});

test("task lines read the rule and keep it out of the title", () => {
  const parsed = parseTaskLine("- [ ] #task 交週報 🔁 every week on Monday ⏳ 2026-10-26", "a.md", 0);
  assert.equal(parsed?.title, "交週報");
  assert.equal(parsed?.recurrence, "every week on Monday");
  assert.equal(parsed?.taskDate, "2026-10-26");
});

test("an unknown rule stays visible as title text and adds no field", () => {
  const parsed = parseTaskLine("- [ ] #task 繳費 🔁 whenever", "a.md", 0);
  assert.equal(parsed?.title, "繳費 🔁 whenever");
  assert.equal("recurrence" in (parsed ?? {}), false);
});

test("rules this app does not fully understand stay literal title text", () => {
  for (const line of [
    "- [ ] #task Team sync 🔁 every month on the 2nd Wednesday ⏳ 2026-10-14",
    "- [ ] #task Payroll 🔁 every month on the last Friday",
    "- [ ] #task Water 🔁 every 3 days when done",
    "- [ ] #task Bday 🔁 every year on October 20",
    "- [ ] #task 🔁 every day Review inbox",
  ]) {
    const parsed = parseTaskLine(line, "a.md", 0);
    assert.equal("recurrence" in (parsed ?? {}), false, line);
    assert.match(parsed?.title ?? "", /🔁 every/, line);
  }
});

test("Chinese title text after the rule ends it; block ids are kept", () => {
  const parsed = parseTaskLine("- [ ] #task 🔁 every day 運動 ^abc123", "a.md", 0);
  assert.equal(parsed?.recurrence, "every day");
  assert.equal(parsed?.title.startsWith("運動"), true);
});

test("with several rules the first counts; changing or clearing removes them all", () => {
  const line = "- [ ] #task A 🔁 every day 🔁 every week";
  const parsed = parseTaskLine(line, "a.md", 0)!;
  assert.equal(parsed.recurrence, "every day");
  assert.equal(parsed.title, "A");
  const cleared = patchTaskLine(line, { ...parsed, id: "t", rank: "a", recurrence: null });
  assert.doesNotMatch(cleared, /🔁/);
  assert.equal(parseTaskLine(cleared, "a.md", 0)?.title, "A");
  const changed = patchTaskLine(line, { ...parsed, id: "t", rank: "a", recurrence: "every year" });
  assert.equal((changed.match(/🔁/gu) ?? []).length, 1);
  assert.equal(parseTaskLine(changed, "a.md", 0)?.recurrence, "every year");
  const retitled = patchTaskLine(line, { ...parsed, id: "t", rank: "a", title: "NEW" });
  assert.equal(parseTaskLine(retitled, "a.md", 0)?.title, "NEW");
});

test("an invalid rule is never written into the file", () => {
  const base = parseTaskLine("- [ ] #task 交週報", "a.md", 0)!;
  const injected = "every day\n- [ ] #task fake";
  assert.equal(patchTaskLine(base.rawLine, { ...base, recurrence: injected }), base.rawLine);
  assert.doesNotMatch(formatTaskLine({ ...base, id: "t", rank: "a", recurrence: injected }), /fake|🔁/);
  assert.match(formatTaskLine({ ...base, id: "t", rank: "a", recurrence: "Every Monday" }), /🔁 every week on Monday/);
});

test("format and patch round-trip the rule", () => {
  const base = parseTaskLine("- [ ] #task 交週報 ⏳ 2026-10-26", "a.md", 0)!;
  const added = patchTaskLine(base.rawLine, { ...base, id: "t1", rank: "a", recurrence: "every week on Monday" });
  assert.equal(parseTaskLine(added, "a.md", 0)?.recurrence, "every week on Monday");
  const changed = patchTaskLine(added, { ...parseTaskLine(added, "a.md", 0)!, recurrence: "every 2 weeks" });
  assert.match(changed, /🔁 every 2 weeks/);
  assert.doesNotMatch(changed, /Monday/);
  const removed = patchTaskLine(changed, { ...parseTaskLine(changed, "a.md", 0)!, recurrence: null });
  assert.doesNotMatch(removed, /🔁/);
  assert.equal(parseTaskLine(removed, "a.md", 0)?.title, "交週報");
  const untouched = patchTaskLine(changed, { ...parseTaskLine(changed, "a.md", 0)!, recurrence: undefined });
  assert.equal(untouched, changed);
  const formatted = formatTaskLine({ ...base, id: "t2", rank: "b", recurrence: "every day" });
  assert.equal(parseTaskLine(formatted, "a.md", 0)?.recurrence, "every day");
});

test("snapshots with an unknown rule still load, with the rule dropped", async () => {
  const { BrainTaskSnapshotSchema } = await import("./types");
  const base = { id: "t", title: "A", status: "todo", priority: "normal", projectId: null, projectName: null, rank: "a", sourcePath: null, sourceHeading: null, completedAt: null };
  assert.equal(BrainTaskSnapshotSchema.parse({ ...base, recurrence: "whenever" }).recurrence, null);
  assert.equal(BrainTaskSnapshotSchema.parse({ ...base, recurrence: "Every Monday" }).recurrence, "every week on Monday");
  assert.equal("recurrence" in BrainTaskSnapshotSchema.parse(base), false);
});
