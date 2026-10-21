import { useState } from "react";
import { describeRecurrence, formatRecurrence, parseRecurrence, type RecurrenceRule } from "@second-brain/brain-core";

type Locale = "zh-TW" | "en";
type CustomUnit = "day" | "week" | "month" | "year";

const CUSTOM = "__custom__";
// Monday first, matching how people in Taiwan read a week.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const ZH_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
}

/** Presets anchored on the task's date, so "every week" means its weekday. */
export function recurrencePresets(taskDate: string | null | undefined, today: string): string[] {
  const anchor = taskDate ?? today;
  const weekday = weekdayOf(anchor);
  const day = Number(anchor.slice(8, 10));
  const rules: RecurrenceRule[] = [
    { unit: "day", interval: 1 },
    { unit: "weekday" },
    { unit: "week", interval: 1, weekdays: [weekday] },
    { unit: "week", interval: 2, weekdays: [weekday] },
    { unit: "month", interval: 1, day },
    { unit: "month", interval: 1, day: "last" },
    { unit: "year", interval: 1 },
  ];
  return rules.map(formatRecurrence);
}

export function recurrenceLabel(value: string | null | undefined, locale: Locale): string | null {
  const rule = value ? parseRecurrence(value) : null;
  return rule ? describeRecurrence(rule, locale) : null;
}

/**
 * The rule the custom editor starts from: the current rule when there is one,
 * otherwise weekly on the anchor's weekday. Weekday-only rules open as a week
 * with Monday to Friday ticked so they stay editable.
 */
export function customRuleFrom(value: string | null | undefined, anchor: string): Exclude<RecurrenceRule, { unit: "weekday" }> {
  const rule = value ? parseRecurrence(value) : null;
  if (!rule) return { unit: "week", interval: 1, weekdays: [weekdayOf(anchor)] };
  if (rule.unit === "weekday") return { unit: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] };
  if (rule.unit === "week" && !rule.weekdays.length) return { ...rule, weekdays: [weekdayOf(anchor)] };
  if (rule.unit === "month" && rule.day === null) return { ...rule, day: Number(anchor.slice(8, 10)) };
  return rule;
}

/** Switches the unit while keeping the interval, filling in an anchored detail. */
export function withCustomUnit(rule: Exclude<RecurrenceRule, { unit: "weekday" }>, unit: CustomUnit, anchor: string): Exclude<RecurrenceRule, { unit: "weekday" }> {
  const interval = rule.interval;
  if (unit === "week") return { unit, interval, weekdays: rule.unit === "week" ? rule.weekdays : [weekdayOf(anchor)] };
  if (unit === "month") return { unit, interval, day: rule.unit === "month" ? rule.day : Number(anchor.slice(8, 10)) };
  return { unit, interval };
}

/** Toggles one weekday; the last remaining day cannot be switched off. */
export function toggleWeekday(weekdays: readonly number[], day: number): number[] {
  if (weekdays.includes(day)) return weekdays.length > 1 ? weekdays.filter((item) => item !== day) : [...weekdays];
  return [...weekdays, day].sort((left, right) => left - right);
}

function CustomRecurrenceEditor({ rule, anchor, locale, onChange }: {
  rule: Exclude<RecurrenceRule, { unit: "weekday" }>;
  anchor: string;
  locale: Locale;
  onChange: (rule: Exclude<RecurrenceRule, { unit: "weekday" }>) => void;
}) {
  const zh = locale === "zh-TW";
  // Kept as text so the box can be cleared while typing a new number.
  const [intervalText, setIntervalText] = useState(String(rule.interval));
  const units: { value: CustomUnit; label: string }[] = zh
    ? [{ value: "day", label: "天" }, { value: "week", label: "週" }, { value: "month", label: "個月" }, { value: "year", label: "年" }]
    : [{ value: "day", label: "day(s)" }, { value: "week", label: "week(s)" }, { value: "month", label: "month(s)" }, { value: "year", label: "year(s)" }];
  return (
    <div className="recurrence-custom" role="group" aria-label={zh ? "自訂重複" : "Custom repeat"}>
      <div className="recurrence-custom-row">
        <span>{zh ? "每" : "Every"}</span>
        <input
          type="number"
          min={1}
          max={365}
          inputMode="numeric"
          aria-label={zh ? "間隔" : "Interval"}
          value={intervalText}
          onChange={(event) => {
            setIntervalText(event.target.value);
            const interval = Number(event.target.value);
            if (Number.isInteger(interval) && interval >= 1 && interval <= 365) onChange({ ...rule, interval });
          }}
          onBlur={() => setIntervalText(String(rule.interval))}
        />
        <select aria-label={zh ? "單位" : "Unit"} value={rule.unit} onChange={(event) => onChange(withCustomUnit(rule, event.target.value as CustomUnit, anchor))}>
          {units.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}
        </select>
        {rule.unit === "month" && (
          <select aria-label={zh ? "日期" : "Day"} value={String(rule.day)} onChange={(event) => onChange({ ...rule, day: event.target.value === "last" ? "last" : Number(event.target.value) })}>
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{zh ? `${day} 號` : `on the ${day}`}</option>)}
            <option value="last">{zh ? "最後一天" : "on the last day"}</option>
          </select>
        )}
      </div>
      {rule.unit === "week" && (
        <div className="recurrence-weekdays">
          {WEEK_ORDER.map((day) => (
            <button
              key={day}
              type="button"
              aria-pressed={rule.weekdays.includes(day)}
              className={rule.weekdays.includes(day) ? "active" : undefined}
              onClick={() => onChange({ ...rule, weekdays: toggleWeekday(rule.weekdays, day) })}
            >
              {zh ? ZH_WEEKDAYS[day] : EN_WEEKDAYS[day]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RecurrenceSelect({ value, taskDate, today, locale, label, onChange }: {
  value: string | null | undefined;
  taskDate: string | null | undefined;
  today: string;
  locale: Locale;
  label: string;
  onChange: (value: string | null) => void;
}) {
  const presets = recurrencePresets(taskDate, today);
  const anchor = taskDate ?? today;
  // Opens on "Custom…" and stays open while editing, even when the edited
  // rule happens to match a preset.
  const [customOpen, setCustomOpen] = useState(() => Boolean(value && !presets.includes(value)));
  const showCustom = customOpen && Boolean(value);
  const options = value && !presets.includes(value) && !showCustom ? [value, ...presets] : presets;
  return (
    <div className={showCustom ? "recurrence-field custom" : "recurrence-field"}>
      <label>
        {label}
        <select
          value={showCustom ? CUSTOM : value ?? ""}
          onChange={(event) => {
            if (event.target.value === CUSTOM) {
              setCustomOpen(true);
              onChange(formatRecurrence(customRuleFrom(value, anchor)));
              return;
            }
            setCustomOpen(false);
            onChange(event.target.value || null);
          }}
        >
          <option value="">{locale === "zh-TW" ? "不重複" : "Does not repeat"}</option>
          {options.map((rule) => <option key={rule} value={rule}>{recurrenceLabel(rule, locale) ?? rule}</option>)}
          <option value={CUSTOM}>{showCustom && value ? `${locale === "zh-TW" ? "自訂：" : "Custom: "}${recurrenceLabel(value, locale) ?? value}` : (locale === "zh-TW" ? "自訂…" : "Custom…")}</option>
        </select>
      </label>
      {showCustom && (
        <CustomRecurrenceEditor
          rule={customRuleFrom(value, anchor)}
          anchor={anchor}
          locale={locale}
          onChange={(rule) => onChange(formatRecurrence(rule))}
        />
      )}
    </div>
  );
}
