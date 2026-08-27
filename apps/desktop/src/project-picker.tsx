import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { projectColor, type BrainProjectSnapshot } from "@second-brain/brain-core";
import { translate, type UiLanguage } from "./ui-preferences";

/**
 * Searchable project association control shared by quick capture, the task
 * detail dialog and inline task rows. Doubles as an inline creation form: when
 * the query names no existing project, a “new project” row creates one through
 * onCreateProject and selects it immediately.
 *
 * Same-name projects are never offered twice: scanning resolves task→project
 * links by display name, so a duplicate would silently rebind to the wrong
 * document — the create row hides whenever an exact match already exists.
 */

export interface CreatedProject {
  id: string | null;
  name: string;
}

type Option =
  | { kind: "none" }
  | { kind: "project"; project: BrainProjectSnapshot }
  | { kind: "create"; name: string };

const keyOf = (project: { id: string | null; name: string }) => project.id ?? `name:${project.name}`;

function syntheticProject(created: CreatedProject): BrainProjectSnapshot {
  return {
    schemaVersion: 6,
    id: created.id,
    name: created.name,
    sourcePath: null,
    status: "planning",
    area: null,
    priority: null,
    progress: 0,
    focusToday: false,
    startDate: null,
    endDate: null,
    completedAt: null,
  };
}

export function ProjectPicker({
  projects,
  valueId,
  onSelect,
  onCreateProject,
  locale = "zh-TW",
  variant = "form",
  ariaLabel,
  initialQuery = "",
}: {
  projects: BrainProjectSnapshot[];
  valueId: string | null;
  onSelect: (project: BrainProjectSnapshot | null) => void;
  onCreateProject?: (name: string) => Promise<CreatedProject | null>;
  locale?: UiLanguage;
  variant?: "form" | "compact";
  ariaLabel?: string;
  /** Search text the menu starts with each time it opens (context hints). */
  initialQuery?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Keep an idle closed picker in sync with a changed seed query.
  useEffect(() => {
    if (!open) setQuery(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const selected = projects.find((project) => project.id && project.id === valueId) ?? null;

  const trimmed = query.trim();
  const matches = useMemo(
    () => (trimmed
      ? projects.filter((project) => project.name.toLowerCase().includes(trimmed.toLowerCase()))
      : [...projects]
    ).sort((left, right) => left.name.localeCompare(right.name, locale === "zh-TW" ? "zh-Hant-TW" : "en")),
    [locale, projects, trimmed],
  );
  const hasExactMatch = trimmed
    ? projects.some((project) => project.name.toLowerCase() === trimmed.toLowerCase())
    : false;

  const options = useMemo<Option[]>(() => [
    { kind: "none" },
    ...matches.map((project): Option => ({ kind: "project", project })),
    ...(onCreateProject && trimmed && !hasExactMatch ? [{ kind: "create" as const, name: trimmed }] : []),
  ], [hasExactMatch, matches, onCreateProject, trimmed]);

  const openMenu = () => {
    setQuery(initialQuery);
    setActiveIndex(0);
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const closeMenu = () => {
    setOpen(false);
    setQuery("");
  };
  const pick = async (option: Option) => {
    if (option.kind === "none") {
      onSelect(null);
      closeMenu();
      return;
    }
    if (option.kind === "project") {
      onSelect(option.project);
      closeMenu();
      return;
    }
    if (!onCreateProject || creating) return;
    setCreating(true);
    try {
      const created = await onCreateProject(option.name);
      if (created) {
        onSelect(syntheticProject(created));
        closeMenu();
      }
    } finally {
      setCreating(false);
    }
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
      void pick(options[activeIndex] ?? { kind: "none" });
    } else if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
    }
  };

  const labelFor = (option: Option) => {
    if (option.kind === "none") return translate(locale, "picker.none");
    if (option.kind === "project") return option.project.name;
    return translate(locale, "picker.create", { name: option.name });
  };

  const menu = open && (
    <div className="project-picker-menu" role="listbox" id="project-picker-listbox" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const isCreate = option.kind === "create";
        const isSelected = option.kind === "project"
          ? Boolean(option.project.id && option.project.id === valueId)
          : option.kind === "none" && !valueId;
        return (
          <button
            type="button"
            key={option.kind === "project" ? keyOf(option.project) : option.kind}
            role="option"
            aria-selected={isSelected}
            className={`project-picker-option ${index === activeIndex ? "active" : ""} ${isCreate ? "project-picker-create" : ""}`}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => void pick(option)}
          >
            {option.kind === "project" && (
              <span className="dot" style={{ background: projectColor(option.project.id ?? option.project.name).accent }} aria-hidden="true" />
            )}
            {isCreate && <Plus aria-hidden="true" />}
            <strong>{creating && isCreate ? translate(locale, "picker.creating") : labelFor(option)}</strong>
            {isSelected && <Check aria-hidden="true" />}
          </button>
        );
      })}
      {matches.length === 0 && trimmed && hasExactMatch === false && !onCreateProject && (
        <span className="project-picker-empty">{translate(locale, "picker.empty")}</span>
      )}
    </div>
  );

  if (variant === "compact") {
    return (
      <div className="project-picker project-picker-compact" ref={rootRef}>
        <button
          type="button"
          className="project-picker-chip"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={selected?.name ?? translate(locale, "picker.none")}
          onClick={() => (open ? closeMenu() : openMenu())}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") return; // native click
            if (event.key === "Escape") closeMenu();
          }}
        >
          <span
            className="dot"
            style={{ background: projectColor(selected?.id ?? selected?.name ?? "").accent }}
            aria-hidden="true"
          />
          <strong>{selected?.name ?? translate(locale, "picker.none")}</strong>
          <ChevronDown aria-hidden="true" />
        </button>
        {menu}
      </div>
    );
  }

  return (
    <div className="project-picker" ref={rootRef}>
      <div className="project-picker-field">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? "project-picker-listbox" : undefined}
          aria-label={ariaLabel}
          autoComplete="off"
          value={open ? query : (selected?.name ?? "")}
          placeholder={translate(locale, "picker.searchPlaceholder")}
          onFocus={() => !open && openMenu()}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            if (!open) setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
        />
        {open && query && (
          <button type="button" className="project-picker-clear" aria-label={translate(locale, "app.cancel")} onClick={() => setQuery("")}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>
      {menu}
    </div>
  );
}
