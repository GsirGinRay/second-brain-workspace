import { describeRecurrence, formatRecurrence, parseRecurrence, type RecurrenceRule } from "@second-brain/brain-core";

type Locale = "zh-TW" | "en";

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

export function RecurrenceSelect({ value, taskDate, today, locale, label, onChange }: {
  value: string | null | undefined;
  taskDate: string | null | undefined;
  today: string;
  locale: Locale;
  label: string;
  onChange: (value: string | null) => void;
}) {
  const presets = recurrencePresets(taskDate, today);
  const options = value && !presets.includes(value) ? [value, ...presets] : presets;
  return (
    <label>
      {label}
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">{locale === "zh-TW" ? "不重複" : "Does not repeat"}</option>
        {options.map((rule) => <option key={rule} value={rule}>{recurrenceLabel(rule, locale) ?? rule}</option>)}
      </select>
    </label>
  );
}

