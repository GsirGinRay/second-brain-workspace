import { translate, type UiLanguage } from "./ui-preferences";

export function CategoryInput({
  value,
  onChange,
  existingCategories = [],
  placeholder = "",
  ariaLabel,
  listId,
  locale = "zh-TW",
  maxLength = 200,
}: {
  value: string;
  onChange: (next: string) => void;
  existingCategories?: string[];
  placeholder?: string;
  ariaLabel?: string;
  listId: string;
  locale?: UiLanguage;
  maxLength?: number;
}) {
  const sortedCategories = [
    ...new Set(existingCategories.map((cat) => cat.trim()).filter(Boolean)),
    // Pin the collation to the component's UI locale: localeCompare without an
    // explicit locale falls back to the machine default, which reordered CJK
    // categories differently on CI than on dev machines.
  ].sort((a, b) => a.localeCompare(b, locale === "zh-TW" ? "zh-Hant-TW" : "en"));

  const selectPlaceholder =
    locale === "zh-TW" ? "選擇現有分類…" : "Select existing…";
  const defaultPlaceholder = translate(locale, "app.uncategorized");

  return (
    <div className="category-input-group">
      <input
        list={listId}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder || defaultPlaceholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {sortedCategories.map((cat) => (
          <option key={cat} value={cat} />
        ))}
      </datalist>
      {sortedCategories.length > 0 && (
        <select
          className="category-quick-select"
          aria-label={ariaLabel ? `${ariaLabel} ${selectPlaceholder}` : selectPlaceholder}
          value={sortedCategories.includes(value) ? value : ""}
          onChange={(event) => {
            if (event.target.value) {
              onChange(event.target.value);
            }
          }}
        >
          <option value="" disabled>
            {selectPlaceholder}
          </option>
          {sortedCategories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
