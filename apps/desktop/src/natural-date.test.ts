import assert from "node:assert/strict";
import test from "node:test";
import { parseNaturalDate } from "./natural-date";

// 2026-10-20 is a Tuesday.
const TODAY = "2026-10-20";

function parse(input: string, today = TODAY) {
  return parseNaturalDate(input, today);
}

function dateOf(input: string, today = TODAY) {
  return parse(input, today)?.date;
}

function timeOf(input: string) {
  return parse(input)?.time;
}

function durationOf(input: string) {
  return parse(input)?.durationMinutes;
}

test("relative day words resolve against today", () => {
  assert.equal(dateOf("今天交報告"), "2026-10-20");
  assert.equal(dateOf("今日交報告"), "2026-10-20");
  assert.equal(dateOf("明天交報告"), "2026-10-21");
  assert.equal(dateOf("明日交報告"), "2026-10-21");
  assert.equal(dateOf("後天交報告"), "2026-10-22");
  assert.equal(dateOf("大後天交報告"), "2026-10-23");
  assert.equal(dateOf("昨天的帳"), "2026-10-19");
  assert.equal(dateOf("明天交報告", "2026-12-31"), "2027-01-01");
  assert.equal(dateOf("後天交報告", "2028-02-28"), "2028-03-01");
});

test("bare weekdays mean the next occurrence, counting today", () => {
  assert.equal(dateOf("週五開會"), "2026-10-23");
  assert.equal(dateOf("週二開會"), "2026-10-20");
  assert.equal(dateOf("週一開會"), "2026-10-26");
  assert.equal(dateOf("周三開會"), "2026-10-21");
  assert.equal(dateOf("星期六爬山"), "2026-10-24");
  assert.equal(dateOf("星期日爬山"), "2026-10-25");
  assert.equal(dateOf("禮拜天爬山"), "2026-10-25");
  assert.equal(dateOf("禮拜一報告"), "2026-10-26");
});

test("this-week and next-week weekdays use Monday-based weeks", () => {
  assert.equal(dateOf("這週一補記"), "2026-10-19");
  assert.equal(dateOf("這週五開會"), "2026-10-23");
  assert.equal(dateOf("本週日休息"), "2026-10-25");
  assert.equal(dateOf("下週一開會"), "2026-10-26");
  assert.equal(dateOf("下週五開會"), "2026-10-30");
  assert.equal(dateOf("下星期日開會"), "2026-11-01");
  assert.equal(dateOf("下個禮拜三開會"), "2026-10-28");
  assert.equal(dateOf("下下週三開會"), "2026-11-04");
  // On a Sunday, next Monday is the following day.
  assert.equal(dateOf("下週一開會", "2026-10-25"), "2026-10-26");
});

test("explicit dates parse with and without a year", () => {
  assert.equal(dateOf("10/25 繳費"), "2026-10-25");
  assert.equal(dateOf("繳費10月25日"), "2026-10-25");
  assert.equal(dateOf("10月25號繳費"), "2026-10-25");
  assert.equal(dateOf("十月二十五日繳費"), "2026-10-25");
  assert.equal(dateOf("2026/10/25 繳費"), "2026-10-25");
  assert.equal(dateOf("2026-10-25 繳費"), "2026-10-25");
  assert.equal(dateOf("2027年3月1日 續約"), "2027-03-01");
  assert.equal(dateOf("10/20 today"), "2026-10-20");
});

test("month/day already in the past rolls to next year", () => {
  assert.equal(dateOf("10/19 繳費"), "2027-10-19");
  assert.equal(dateOf("1月5日 繳費"), "2027-01-05");
  assert.equal(dateOf("2/29 檢查", "2027-03-01"), "2028-02-29");
});

test("invalid calendar dates are ignored", () => {
  assert.equal(parse("2/30 檢查"), null);
  assert.equal(parse("13/5 檢查"), null);
  assert.equal(parse("2026-02-30 檢查"), null);
});

test("offsets and next-month days", () => {
  assert.equal(dateOf("3天後回覆"), "2026-10-23");
  assert.equal(dateOf("三天後回覆"), "2026-10-23");
  assert.equal(dateOf("兩週後複診"), "2026-11-03");
  assert.equal(dateOf("2個星期後複診"), "2026-11-03");
  assert.equal(dateOf("3個月後回診"), "2027-01-20");
  assert.equal(dateOf("下個月5號繳卡費"), "2026-11-05");
  assert.equal(dateOf("下個月十五號繳卡費"), "2026-11-15");
  assert.equal(dateOf("下個月31號繳卡費"), "2026-11-30");
  assert.equal(dateOf("1個月後", "2026-01-31"), "2026-02-28");
});

test("Chinese periods convert to 24h time", () => {
  assert.equal(timeOf("下午3點開會"), "15:00");
  assert.equal(timeOf("晚上8點聚餐"), "20:00");
  assert.equal(timeOf("中午12點午餐"), "12:00");
  assert.equal(timeOf("中午1點午餐"), "13:00");
  assert.equal(timeOf("凌晨1點備份"), "01:00");
  assert.equal(timeOf("凌晨12點備份"), "00:00");
  assert.equal(timeOf("早上9點晨會"), "09:00");
  assert.equal(timeOf("上午10點半晨會"), "10:30");
  assert.equal(timeOf("早上12點"), "12:00");
  assert.equal(timeOf("傍晚6點散步"), "18:00");
  assert.equal(timeOf("下午3點15分"), "15:15");
  assert.equal(timeOf("下午3點15"), "15:15");
  assert.equal(timeOf("下午3:30開會"), "15:30");
  assert.equal(timeOf("下午三點開會"), "15:00");
  assert.equal(timeOf("晚上十點半睡覺"), "22:30");
  assert.equal(timeOf("下午兩點開會"), "14:00");
  assert.equal(timeOf("下午15點開會"), "15:00");
});

test("hours without a period are read literally", () => {
  assert.equal(timeOf("3點開會"), "03:00");
  assert.equal(timeOf("3點半開會"), "03:30");
  assert.equal(timeOf("15點開會"), "15:00");
  assert.equal(timeOf("兩點半開會"), "02:30");
  assert.equal(timeOf("十點整開會"), "10:00");
  assert.equal(timeOf("15:30 開會"), "15:30");
  assert.equal(timeOf("9:05 開會"), "09:05");
});

test("evening hours past midnight move a recognized date forward", () => {
  const late = parse("明天晚上12點上線");
  assert.equal(late?.date, "2026-10-22");
  assert.equal(late?.time, "00:00");
  const veryLate = parse("明天晚上1點上線");
  assert.equal(veryLate?.date, "2026-10-22");
  assert.equal(veryLate?.time, "01:00");
  // Without a date, "晚上12點" is tonight's midnight, not 00:00 earlier today.
  const noDate = parse("晚上12點上線");
  assert.equal(noDate?.date, "2026-10-21");
  assert.equal(noDate?.time, "00:00");
  assert.equal(noDate?.timeDayOffset, 1);
});

test("kinds limit what is recognized and leave the rest in the title", () => {
  const timeOnly = parseNaturalDate("明天下午3點開會", "2026-10-20", { kinds: ["time", "duration"] });
  assert.equal(timeOnly?.date, undefined);
  assert.equal(timeOnly?.time, "15:00");
  assert.equal(timeOnly?.title, "明天開會");
  const noDuration = parseNaturalDate("讀書1小時", "2026-10-20", { kinds: ["date", "time"] });
  assert.equal(noDuration, null);
});

test("今晚 / 明早 imply both a date and a period", () => {
  const tonight = parse("今晚8點看球");
  assert.equal(tonight?.date, "2026-10-20");
  assert.equal(tonight?.time, "20:00");
  assert.equal(tonight?.title, "看球");
  const morning = parse("明早7點跑步");
  assert.equal(morning?.date, "2026-10-21");
  assert.equal(morning?.time, "07:00");
  assert.equal(parse("今晚看球")?.date, "2026-10-20");
});

test("English meridiem times", () => {
  assert.equal(timeOf("call 3pm"), "15:00");
  assert.equal(timeOf("call at 3:30pm"), "15:30");
  assert.equal(timeOf("call at 11 AM"), "11:00");
  assert.equal(timeOf("call 12am"), "00:00");
  assert.equal(timeOf("call 12pm"), "12:00");
  assert.equal(timeOf("call 9:15 a.m."), "09:15");
  assert.equal(parse("call 13pm"), null);
});

test("durations in Chinese and English", () => {
  assert.equal(durationOf("寫週報30分鐘"), 30);
  assert.equal(durationOf("寫週報 四十五分鐘"), 45);
  assert.equal(durationOf("讀書1小時"), 60);
  assert.equal(durationOf("讀書1.5小時"), 90);
  assert.equal(durationOf("讀書一個半小時"), 90);
  assert.equal(durationOf("讀書兩個小時"), 120);
  assert.equal(durationOf("讀書半小時"), 30);
  assert.equal(durationOf("讀書2小時30分鐘"), 150);
  assert.equal(durationOf("讀書1個鐘頭"), 60);
  assert.equal(durationOf("read 90m"), 90);
  assert.equal(durationOf("read 2h"), 120);
  assert.equal(durationOf("read 1h30m"), 90);
  assert.equal(durationOf("read for 45 min"), 45);
  assert.equal(durationOf("read for 1.5 hours"), 90);
});

test("English dates", () => {
  assert.equal(dateOf("pay rent today"), "2026-10-20");
  assert.equal(dateOf("pay rent tomorrow"), "2026-10-21");
  assert.equal(dateOf("pay rent Tomorrow"), "2026-10-21");
  assert.equal(dateOf("pay rent friday"), "2026-10-23");
  assert.equal(dateOf("pay rent fri"), "2026-10-23");
  assert.equal(dateOf("pay rent tue"), "2026-10-20");
  assert.equal(dateOf("pay rent next monday"), "2026-10-26");
  assert.equal(dateOf("pay rent next fri"), "2026-10-30");
  assert.equal(dateOf("pay rent this monday"), "2026-10-19");
  assert.equal(dateOf("pay rent on sun"), "2026-10-25");
  assert.equal(dateOf("pay rent in 3 days"), "2026-10-23");
  assert.equal(dateOf("pay rent in 2 weeks"), "2026-11-03");
});

test("combined phrases fill every field and leave a clean title", () => {
  const result = parse("明天下午3點開會1小時");
  assert.deepEqual(
    {
      title: result?.title,
      date: result?.date,
      time: result?.time,
      durationMinutes: result?.durationMinutes,
      matchedText: result?.matchedText,
    },
    { title: "開會", date: "2026-10-21", time: "15:00", durationMinutes: 60, matchedText: "明天 下午3點 1小時" },
  );
  assert.deepEqual(
    result?.spans.map((span) => [span.kind, span.start, span.end, span.text]),
    [
      ["date", 0, 2, "明天"],
      ["time", 2, 6, "下午3點"],
      ["duration", 8, 11, "1小時"],
    ],
  );

  const english = parse("Call mom tomorrow at 3pm for 30m");
  assert.equal(english?.title, "Call mom");
  assert.equal(english?.date, "2026-10-21");
  assert.equal(english?.time, "15:00");
  assert.equal(english?.durationMinutes, 30);
  assert.equal(english?.matchedText, "tomorrow at 3pm for 30m");

  const iso = parse("2026-11-02 15:30 dentist");
  assert.equal(iso?.date, "2026-11-02");
  assert.equal(iso?.time, "15:30");
  assert.equal(iso?.title, "dentist");
});

test("time-only and duration-only results omit the other fields", () => {
  assert.deepEqual(parse("下午3點開會"), {
    title: "開會",
    time: "15:00",
    matchedText: "下午3點",
    spans: [{ kind: "time", start: 0, end: 4, text: "下午3點" }],
  });
  const duration = parse("冥想10分鐘");
  assert.equal(duration?.date, undefined);
  assert.equal(duration?.time, undefined);
  assert.equal(duration?.durationMinutes, 10);
  assert.equal(duration?.title, "冥想");
});

test("dangling connectors around the phrase are dropped", () => {
  assert.equal(parse("明天下午3點的會議")?.title, "會議");
  assert.equal(parse("在明天下午3點開會")?.title, "開會");
  assert.equal(parse("週五前交報告")?.title, "交報告");
  assert.equal(parse("週五之前交報告")?.title, "交報告");
  assert.equal(parse("明天前往台北")?.title, "前往台北");
  assert.equal(parse("交報告，明天")?.title, "交報告");
  assert.equal(parse("review PR on friday")?.title, "review PR");
});

test("whitespace is tidied and ASCII words are not glued together", () => {
  assert.equal(parse("Buy milk  tomorrow  please")?.title, "Buy milk please");
  assert.equal(parse("meeting明天review")?.title, "meeting review");
  assert.equal(parse("  明天  ")?.title, "");
});

test("non-date numbers and words are not recognized", () => {
  for (const input of [
    "買3本書",
    "第2版",
    "更新到 v0.6.1",
    "台積電2330",
    "Q3 財報",
    "10月營收",
    "快一點",
    "多一點時間",
    "第3點建議",
    "考了90分",
    "每週五倒垃圾",
    "每個星期一開會",
    "sunny day",
    "satellite photos",
    "the sun is out",
    "mondays are hard",
    "monitor setup",
    "item 2330/10",
    "v1.2h",
    "ratio 1:2",
    "",
  ]) {
    assert.equal(parse(input), null, input);
  }
});

test("only the first phrase of each kind is used", () => {
  const result = parse("明天或後天交報告");
  assert.equal(result?.date, "2026-10-21");
  assert.equal(result?.title, "或後天交報告");
});

test("invalid today throws", () => {
  assert.throws(() => parseNaturalDate("明天", "2026/10/20"), RangeError);
  assert.throws(() => parseNaturalDate("明天", "2026-02-30"), RangeError);
});
