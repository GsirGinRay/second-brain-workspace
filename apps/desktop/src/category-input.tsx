import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { translate, type UiLanguage } from "./ui-preferences";

type Option =
  | { kind: "none" }
  | { kind: "existing"; name: string }
  | { kind: "create"; name: string };

export function CategoryInput({
  value,
  onChange,
  existingCategories = [],
  placeholder = "",
  ariaLabel,
  listId,
  locale = "zh-TW",
  maxLength = 200,
  initialQuery = "",
}: {
  value: string;
  onChange: (next: string) => void;
  existingCategories?: string[];
  placeholder?: string;
  ariaLabel?: string;
  listId: string;
  locale?: UiLanguage;
  maxLength?: number;
  initialQuery?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const menuId = listId || generatedId;

  const sortedCategories = useMemo(() => [
    ...new Set(existingCategories.map((cat) => cat.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, locale === "zh-TW" ? "zh-Hant-TW" : "en")), [existingCategories, locale]);

  useEffect(() => {
    if (!open) setQuery(initialQuery);
  }, [initialQuery, open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const trimmed = query.trim().slice(0, maxLength);
  const matches = trimmed
    ? sortedCategories.filter((cat) => cat.toLowerCase().includes(trimmed.toLowerCase()))
    : sortedCategories;
  const hasExactMatch = trimmed
    ? sortedCategories.some((cat) => cat.toLowerCase() === trimmed.toLowerCase())
    : false;
  const options = useMemo<Option[]>(() => [
    { kind: "none" },
    ...matches.map((name): Option => ({ kind: "existing", name })),
    ...(trimmed && !hasExactMatch ? [{ kind: "create" as const, name: trimmed }] : []),
  ], [hasExactMatch, matches, trimmed]);

  useEffect(() => {
    if (!open) return;
    if (trimmed && !hasExactMatch && matches.length === 0) {
      setActiveIndex(Math.max(0, options.length - 1));
      return;
    }
    setActiveIndex(0);
  }, [hasExactMatch, matches.length, open, options.length, trimmed]);

  const pick = (option: Option) => {
    if (option.kind === "none") onChange("");
    else onChange(option.name);
    setOpen(false);
  };
  const onInputKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (trimmed && !hasExactMatch && matches.length === 0) {
        pick({ kind: "create", name: trimmed });
        return;
      }
      pick(options[activeIndex] ?? { kind: "none" });
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    }
  };
  const labelFor = (option: Option) => {
    if (option.kind === "none") return translate(locale, "picker.noCategory");
    if (option.kind === "existing") return option.name;
    return translate(locale, "picker.createCategory", { name: option.name });
  };

  const openMenu = () => {
    setQuery(initialQuery);
    setOpen(true);
    const focusSearch = () => inputRef.current?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusSearch);
    else focusSearch();
  };

  return (
    <div className="category-input-group project-picker" ref={rootRef}>
      <button
        type="button"
        className="project-picker-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className={`project-picker-trigger-label${value ? "" : " is-placeholder"}`}>
          {value || placeholder || translate(locale, "picker.chooseCategory")}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div className="project-picker-menu" role="listbox" id={menuId} aria-label={ariaLabel}>
          <div className="project-picker-field" onClick={(event) => event.stopPropagation()}>
            <Search aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded={open}
              aria-controls={menuId}
              aria-label={ariaLabel}
              autoComplete="off"
              maxLength={maxLength}
              value={query}
              placeholder={translate(locale, "picker.searchCategory")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            {query && (
              <button type="button" className="project-picker-clear" aria-label={translate(locale, "app.cancel")} onClick={() => setQuery("")}>
                <X aria-hidden="true" />
              </button>
            )}
          </div>
          {options.map((option, index) => {
            const isCreate = option.kind === "create";
            const selectedName = option.kind === "existing" ? option.name : option.kind === "none" ? "" : null;
            const isSelected = selectedName !== null && selectedName === value;
            return (
              <button
                type="button"
                key={option.kind === "existing" ? option.name : option.kind}
                role="option"
                aria-selected={isSelected}
                className={`project-picker-option ${index === activeIndex ? "active" : ""} ${isCreate ? "project-picker-create" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(option)}
              >
                {isCreate && <Plus aria-hidden="true" />}
                <strong>{labelFor(option)}</strong>
                {isSelected && <Check aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
