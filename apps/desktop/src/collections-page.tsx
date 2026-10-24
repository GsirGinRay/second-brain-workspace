import {
  attachmentFolderForKnowledge,
  collectionMatchesCategoryFilter,
  extractPromptVariables,
  fillPromptVariables,
  knowledgeFilterCategories,
  type BrainCollectionSnapshot,
} from "@second-brain/brain-core";
import {
  Plus,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Empty, useUiPreferences } from "./app-shared";
import { CategoryInput } from "./category-input";
import { DangerConfirmButton } from "./danger-confirm";
import {
  AutosaveStatus,
  DEFAULT_AUTOSAVE_DELAY_MS,
  rebaseDraft,
  useDraftPersistence,
} from "./entity-detail-dialog";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import { ImportanceControl } from "./priority-control";
import {
  type UiPreferences,
} from "./ui-preferences";

export function Collections({
  collections,
  selectedId,
  onSelect,
  onCreate,
  onSave,
  onDelete,
  onImportPrompts,
  onExportPrompts,
}: {
  collections: BrainCollectionSnapshot[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: () => void;
  onSave: (collection: BrainCollectionSnapshot) => Promise<boolean> | boolean;
  onDelete: (collection: BrainCollectionSnapshot) => Promise<boolean> | void;
  onImportPrompts: () => void;
  onExportPrompts: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [category, setCategory] = useState("all");
  const [importance, setImportance] = useState("all");
  const categories = knowledgeFilterCategories(collections.map((item) => item.category));
  const promptCount = collections.filter((item) => (item.category ?? "").trim().toLowerCase().startsWith("提示詞")).length;
  const visible = collections
    .filter((item) => collectionMatchesCategoryFilter(item.category, category))
    .filter((item) => importance === "all" || String(item.importance ?? "unset") === importance)
    .sort((left, right) => (left.importance ?? 99) - (right.importance ?? 99) || left.name.localeCompare(right.name));
  const selected = collections.find((item) => item.id === selectedId) ?? null;
  return (
    <section className="collections-workspace">
      <header className="project-workspace-header">
        <div><h2>{t("collection.title")}</h2><p>{t("collection.description")}</p>{promptCount > 0 && <span className="focus">{preferences.language === "zh-TW" ? `${promptCount} 支提示詞` : `${promptCount} prompts`}</span>}</div>
        <div className="top-actions">
          <button className="secondary-button" onClick={onImportPrompts}>{preferences.language === "zh-TW" ? "匯入提示詞" : "Import prompts"}</button>
          <button className="secondary-button" onClick={onExportPrompts} disabled={promptCount === 0}>{preferences.language === "zh-TW" ? "匯出提示詞" : "Export prompts"}</button>
          <button className="primary icon-action" aria-label={t("collection.action.add")} title={t("collection.action.add")} onClick={onCreate}><Plus aria-hidden="true" /></button>
        </div>
      </header>
      <div className="project-filters">
        <select aria-label={t("collection.filter.category")} value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">{t("project.filter.allCategories")}</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
        <select aria-label={t("collection.filter.importance")} value={importance} onChange={(event) => setImportance(event.target.value)}><option value="all">{t("project.filter.allImportance")}</option><option value="1">{t("project.importance.high")}</option><option value="2">{t("project.importance.medium")}</option><option value="3">{t("project.importance.low")}</option><option value="unset">{t("project.importance.unset")}</option></select>
      </div>
      <div className="collection-layout">
        <div className="collection-list">
          {visible.length === 0 ? <Empty text={t("collection.empty")} hint={t("collection.emptyHelp")} actionLabel={t("collection.action.add")} onAction={onCreate} /> : visible.map((item) => (
            <div key={item.id ?? item.sourcePath} className={`collection-list-item ${selected?.id === item.id ? "active" : ""}`}>
              <button type="button" className="collection-list-main" onClick={() => onSelect(item.id)}>
                <span><strong>{item.name}</strong><small>{item.category ?? t("app.uncategorized")}</small></span>
                <small>{item.body.slice(0, 100) || t("app.noContent")}</small>
              </button>
              <ImportanceControl
                value={item.importance}
                locale={preferences.language}
                onChange={(importance) => void onSave({ ...item, importance })}
              />
            </div>
          ))}
        </div>
        <article className="collection-preview">
          {selected ? <CollectionEditor key={selected.id ?? selected.name} collection={selected} existingCategories={categories} locale={preferences.language} onSave={onSave} onDelete={onDelete} /> : <Empty text={t("collection.select")} />}
        </article>
      </div>
    </section>
  );
}

export function collectionDraftDiffers(draft: BrainCollectionSnapshot, saved: BrainCollectionSnapshot): boolean {
  return draft.name.trim() !== saved.name
    || (draft.category ?? null) !== (saved.category ?? null)
    || (draft.importance ?? null) !== (saved.importance ?? null)
    || draft.body !== saved.body;
}

export function CollectionEditor({
  collection,
  locale,
  existingCategories = [],
  onSave,
  onDelete,
  autosaveDelayMs = DEFAULT_AUTOSAVE_DELAY_MS,
}: {
  collection: BrainCollectionSnapshot;
  locale: UiPreferences["language"];
  existingCategories?: string[];
  onSave: (collection: BrainCollectionSnapshot) => Promise<boolean> | boolean;
  onDelete: (collection: BrainCollectionSnapshot) => Promise<boolean> | void;
  autosaveDelayMs?: number;
}) {
  const { t } = useUiPreferences();
  const [value, setValue] = useState(collection);
  // Outside changes (the list's importance stars, the vault watcher) rebase
  // onto the draft so autosave never writes a stale field back.
  const baseRef = useRef(collection);
  // Deleting unmounts the editor; its final flush must not write the
  // collection back. Writes wait for the delete's outcome: skipped when it
  // succeeded, written normally when it failed and the editor stays open.
  const deletingRef = useRef<Promise<boolean> | null>(null);
  useLayoutEffect(() => {
    if (baseRef.current === collection) return;
    const base = baseRef.current;
    baseRef.current = collection;
    setValue((current) => rebaseDraft(base, current, collection));
  }, [collection]);
  const { save: persist, state: autosaveState } = useDraftPersistence({
    draft: value,
    dirty: collectionDraftDiffers(value, collection),
    canSave: value.name.trim().length > 0,
    write: async (draft) => {
      const deleting = deletingRef.current;
      if (deleting && await deleting) return true;
      return onSave({ ...draft, name: draft.name.trim() });
    },
    delayMs: autosaveDelayMs,
  });
  const isPrompt = (value.category ?? "").trim().toLowerCase().startsWith("提示詞");
  const variables = useMemo(() => extractPromptVariables(value.body), [value.body]);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [fillOpen, setFillOpen] = useState(false);
  const openFill = () => {
    setFillValues(Object.fromEntries(variables.map((name) => [name, ""])));
    setFillOpen(true);
  };
  const copyFilled = async () => {
    const cleaned: Record<string, string> = {};
    for (const name of variables) {
      cleaned[name] = (fillValues[name] ?? "").trim();
    }
    const filled = fillPromptVariables(value.body, cleaned);
    await navigator.clipboard?.writeText(filled);
    setFillOpen(false);
  };
  const save = () => {
    void persist();
  };
  const confirmDelete = async () => {
    const outcome = Promise.resolve(onDelete(value)).then((ok) => ok !== false, () => false);
    deletingRef.current = outcome;
    // A failed delete keeps the editor open; its edits must save again.
    if (!(await outcome)) deletingRef.current = null;
  };
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <>
    <div className="project-editor-grid">
      <label>{t("entity.field.name")}<input value={value.name} maxLength={200} onChange={(event) => setValue({ ...value, name: event.target.value })} /></label>
      <label>
        {t("entity.field.category")}
        <CategoryInput
          value={value.category ?? ""}
          existingCategories={existingCategories}
          listId={`collection-category-list-${collection.id ?? "new"}`}
          ariaLabel={t("entity.field.category")}
          onChange={(cat) => setValue({ ...value, category: cat || null })}
        />
      </label>
      <label>{t("entity.field.importance")}<select value={value.importance ?? ""} onChange={(event) => setValue({ ...value, importance: event.target.value ? Number(event.target.value) : null })}><option value="">{t("project.importance.unset")}</option><option value="1">{t("project.importance.high")}</option><option value="2">{t("project.importance.medium")}</option><option value="3">{t("project.importance.low")}</option></select></label>
    </div>
    <MarkdownBlockEditor value={value.body} onChange={(body) => setValue({ ...value, body })} locale={locale} attachmentFolder={attachmentFolderForKnowledge(value.category)} />
    <div className="project-actions">
      {isPrompt && variables.length > 0 && (
        <button className="secondary-button action-with-icon" onClick={openFill}>◆ {t("collection.fillCopy")}</button>
      )}
      <AutosaveStatus state={autosaveState} t={t} />
      <DangerConfirmButton className="danger icon-action" armLabel={t("collection.action.delete")} confirmLabel={t("confirm.deleteAgain")} onConfirm={() => void confirmDelete()} />
    </div>
    {fillOpen && (
      <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFillOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-label={t("collection.fillCopy")}>
          <div className="modal-header"><div><span className="eyebrow">PROMPT</span><h2>{t("collection.fillCopy")}</h2></div><button className="icon-button" onClick={() => setFillOpen(false)} aria-label={t("app.close")} title={t("app.close")}><X aria-hidden="true" /></button></div>
          <p>{t("collection.fillHelp")}</p>
          {variables.map((name) => (
            <label className="fill-field" key={name}>{name}<input value={fillValues[name] ?? ""} autoFocus={name === variables[0]} onChange={(event) => setFillValues((prev) => ({ ...prev, [name]: event.target.value }))} /></label>
          ))}
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => setFillOpen(false)}>{t("app.cancel")}</button>
            <button className="primary" onClick={() => void copyFilled()}>{t("collection.copy")}</button>
          </div>
        </section>
      </div>
    )}
  </>;
}
