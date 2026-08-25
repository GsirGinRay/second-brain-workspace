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

  /**
   * One control, not two. The input already carries every existing category through its
   * datalist, so a second picker beside it offered the same values through a second entry
   * point for the same field. The browser draws the list arrow itself, which is also the
   * only way it matches the arrows the neighbouring selects draw — a hand-built one differs
   * in weight and placement no matter how closely it is tuned.
   */
  return (
    <div className="category-input-group" title={sortedCategories.length > 0 ? selectPlaceholder : undefined}>
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
    </div>
  );
}
