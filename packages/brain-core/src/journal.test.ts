import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_JOURNAL_HEADINGS,
  isBlankDailyJournal,
  renderDailyJournalDocument,
} from "./journal";

test("new daily journals are a blank canvas with only the date heading", () => {
  const doc = renderDailyJournalDocument("2026-08-15");
  assert.equal(doc, "# 2026-08-15\r\n\r\n");
  assert.deepEqual([...DAILY_JOURNAL_HEADINGS], [
    "今日會議",
    "結論",
    "產生的任務",
    "可升級的知識",
  ]);
  for (const heading of DAILY_JOURNAL_HEADINGS) {
    assert.doesNotMatch(doc, new RegExp(`## ${heading}`));
  }
  assert.equal(isBlankDailyJournal(doc), true);
  assert.equal(isBlankDailyJournal("# 2026-08-15\n\n## 結論\n\n寫下"), false);
  assert.ok(!doc.includes("2026-08-16"));
  assert.ok(!doc.includes("2026-08-14"));
});

test("journal documents reject invalid calendar dates", () => {
  assert.throws(() => renderDailyJournalDocument("2026-13-40"), /INVALID_JOURNAL_DATE/);
  assert.throws(() => renderDailyJournalDocument("today"), /INVALID_JOURNAL_DATE/);
});
