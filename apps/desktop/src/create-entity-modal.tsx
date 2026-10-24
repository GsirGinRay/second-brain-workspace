import {
  attachmentFolderForKnowledge,
  type BrainProjectSnapshot,
} from "@second-brain/brain-core";
import {
  X,
} from "lucide-react";
import { useState } from "react";
import { useUiPreferences } from "./app-shared";
import { CategoryInput } from "./category-input";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import { ProjectPicker } from "./project-picker";
import {
  withRelatedProjectWikilink,
} from "./vault";

export function CreateEntityModal({
  kind,
  mode = "create",
  initialName,
  initialBody = "",
  initialCategory = "",
  initialProjectId = null,
  templates = [],
  existingCategories = [],
  projects = [],
  onClose,
  onCreate,
  onCreateProject,
}: {
  kind: "project" | "collection";
  mode?: "create" | "save-outcome";
  initialName: string;
  initialBody?: string;
  initialCategory?: string;
  initialProjectId?: string | null;
  templates?: { name: string; body: string }[];
  existingCategories?: string[];
  projects?: BrainProjectSnapshot[];
  onClose: () => void;
  onCreate: (name: string, category: string | null, importance: number | null, body: string) => Promise<void>;
  onCreateProject?: (name: string) => Promise<{ id: string; name: string } | null>;
}) {
  const { t, preferences } = useUiPreferences();
  const saveOutcome = mode === "save-outcome";
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory);
  const [importance, setImportance] = useState("");
  const [body, setBody] = useState(initialBody);
  const [relatedProjectId, setRelatedProjectId] = useState<string | null>(initialProjectId);
  const [relatedProjectName, setRelatedProjectName] = useState<string | null>(
    projects.find((project) => project.id === initialProjectId)?.name ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (!name.trim() || name.trim().length > 200 || submitting) return;
    setSubmitting(true);
    try {
      const relatedName = relatedProjectName ?? projects.find((project) => project.id === relatedProjectId)?.name ?? null;
      const nextBody = kind === "project" ? "" : withRelatedProjectWikilink(body, relatedName);
      await onCreate(name.trim(), category.trim() || null, importance ? Number(importance) : null, nextBody);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal entity-modal" role="dialog" aria-modal="true" aria-label={t(kind === "project" ? "entity.project.title" : saveOutcome ? "knowledge.save.title" : "entity.collection.title")}>
        <div className="modal-header"><div><span className="eyebrow">{kind === "project" ? "OUTCOME" : "KNOWLEDGE"}</span><h2>{t(kind === "project" ? "entity.project.title" : saveOutcome ? "knowledge.save.title" : "entity.collection.title")}</h2></div><button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose}><X aria-hidden="true" /></button></div>
        <p className="entity-guidance">{t(kind === "project" ? "entity.project.help" : saveOutcome ? "knowledge.save.help" : "entity.collection.help")}</p>
        <label>{t("entity.field.name")}<input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>
          {t("entity.field.category")}
          <CategoryInput
            value={category}
            existingCategories={existingCategories}
            listId={`create-entity-${kind}-category`}
            ariaLabel={t("entity.field.category")}
            onChange={setCategory}
          />
        </label>
        <label>{t("entity.field.importance")}<select value={importance} onChange={(event) => setImportance(event.target.value)}><option value="">{t("project.importance.unset")}</option><option value="1">{t("project.importance.high")}</option><option value="2">{t("project.importance.medium")}</option><option value="3">{t("project.importance.low")}</option></select></label>
        {kind === "collection" && (
          <div className="quick-project-field">
            <span className="quick-field-label">{t("task.field.project")}</span>
            <ProjectPicker
              projects={projects}
              valueId={relatedProjectId}
              onSelect={(project) => {
                setRelatedProjectId(project?.id ?? null);
                setRelatedProjectName(project?.name ?? null);
              }}
              onCreateProject={onCreateProject}
              locale={preferences.language}
              ariaLabel={t("task.field.project")}
            />
          </div>
        )}
        {kind === "collection" && !saveOutcome && templates.length > 0 && (
          <label>{preferences.language === "zh-TW" ? "套用模板" : "Apply template"}<select value="" onChange={(event) => { const picked = templates.find((item) => item.name === event.target.value); if (picked) { setBody(picked.body); if (!name.trim()) setName(picked.name); } }}><option value="">{preferences.language === "zh-TW" ? "不使用模板" : "No template"}</option>{templates.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        )}
        {kind === "collection" && <MarkdownBlockEditor value={body} onChange={setBody} locale={preferences.language} attachmentFolder={attachmentFolderForKnowledge(category)} />}
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t("app.cancel")}</button><button className="primary" disabled={!name.trim() || submitting} onClick={() => void submit()}>{t(submitting ? "app.creating" : "app.create")}</button></div>
      </section>
    </div>
  );
}
