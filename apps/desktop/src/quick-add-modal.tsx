import {
  attachmentFolderForTask,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
} from "@second-brain/brain-core";
import {
  CalendarDays,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newTask, shiftDateKey, taipeiDateKey, useUiPreferences } from "./app-shared";
import { MarkdownBlockEditor } from "./markdown-block-editor";
import { parseNaturalDate, type NaturalDateMatch } from "./natural-date";
import { ProjectPicker } from "./project-picker";
import { RecurrenceSelect, recurrenceLabel } from "./recurrence-picker";
import {
  markMostImportant,
} from "./task-actions";
import {
  type UiPreferences,
} from "./ui-preferences";

export function describeNaturalWhen(match: NaturalDateMatch, date: string | undefined, language: UiPreferences["language"]): string {
  const parts: string[] = [];
  const repeat = recurrenceLabel(match.recurrence, language);
  if (repeat) parts.push(repeat);
  if (date) {
    const [year, month, day] = date.split("-").map(Number);
    const weekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
    parts.push(language === "zh-TW"
      ? `${month}/${day}（週${"日一二三四五六"[weekday]}）`
      : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]} ${month}/${day}`);
  }
  if (match.time) parts.push(match.time);
  if (match.durationMinutes) parts.push(language === "zh-TW" ? `${match.durationMinutes} 分鐘` : `${match.durationMinutes} min`);
  return parts.join(" · ");
}

export function QuickAddModal({
  tasks,
  projects,
  templates = [],
  initialTitle = "",
  initialDate,
  initialStartTime,
  initialProjectId,
  forceDate,
  onClose,
  onSave,
  onCreateProject,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  templates?: { name: string; body: string }[];
  initialTitle?: string;
  initialDate?: string;
  initialStartTime?: string;
  /** Pre-select this project when capturing from a project window or board. */
  initialProjectId?: string | null;
  /** When true the date input is locked to `initialDate` (e.g. calendar quick add). */
  forceDate?: boolean;
  onClose: () => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  /** Inline “new project” straight from the capture dialog. */
  onCreateProject?: (name: string) => Promise<{ id: string; name: string } | null>;
}) {
  const { t, preferences } = useUiPreferences();
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  // A project created from this dialog is not in `projects` until the vault
  // rescan finishes, so keep the picked snapshot to bind the task reliably.
  const [pickedProject, setPickedProject] = useState<BrainProjectSnapshot | null>(null);
  const [ideaInbox, setIdeaInbox] = useState(false);
  const [taskDate, setTaskDate] = useState(initialDate ?? taipeiDateKey());
  const [startTime, setStartTime] = useState(initialStartTime ?? "");
  // null = no estimate; a timed task falls back to 30 minutes.
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  // undefined follows a typed phrase such as "every Monday"; null is an
  // explicit "does not repeat" picked in the field.
  const [recurrenceChoice, setRecurrenceChoice] = useState<string | null | undefined>(undefined);
  const [important, setImportant] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  // "明天下午3點開會" fills the date and time; the chip below the title shows
  // what was recognized and lets the user keep the words literal instead.
  const [naturalIgnored, setNaturalIgnored] = useState<string | null>(null);
  const parsedNatural = useMemo(() => {
    // A calendar quick add keeps its locked day, so date words stay in the title.
    const kinds: ("date" | "time" | "duration" | "recurrence")[] = forceDate
      ? ["time", "duration", "recurrence"]
      : ["date", "time", "duration", "recurrence"];
    const today = taipeiDateKey();
    const parsed = parseNaturalDate(title, today, { kinds });
    // A duration lands with a start time, or as a time estimate when a date is
    // also typed ("明天 整理對帳單 2小時"); alone ("讀書1小時") it keeps its words.
    if (parsed?.durationMinutes && !parsed.time && !startTime && !parsed.date) {
      return parseNaturalDate(title, today, { kinds: kinds.filter((kind) => kind !== "duration") });
    }
    return parsed;
  }, [title, forceDate, startTime]);
  const natural = !ideaInbox && parsedNatural && parsedNatural.matchedText !== naturalIgnored ? parsedNatural : null;
  const naturalDate = forceDate
    ? natural?.timeDayOffset && taskDate ? shiftDateKey(taskDate, natural.timeDayOffset) : undefined
    : natural?.date;
  const naturalApplies = Boolean(natural && (naturalDate || natural.time || natural.durationMinutes || natural.recurrence));
  const recurrence = recurrenceChoice === undefined ? (naturalApplies ? natural?.recurrence ?? null : null) : recurrenceChoice;
  const submit = () => {
    if (!title.trim()) return false;
    const project = projects.find((item) => item.id === projectId)
      ?? (pickedProject && projectId && pickedProject.id === projectId ? pickedProject : undefined);
    const effective = naturalApplies && natural
      ? {
        title: natural.title.trim() || title,
        taskDate: naturalDate ?? taskDate,
        startTime: natural.time ?? startTime,
        durationMinutes: natural.durationMinutes ?? durationMinutes,
      }
      : { title, taskDate, startTime, durationMinutes };
    const task = newTask(effective.title, {
      taskDate: ideaInbox ? null : effective.taskDate || null,
      startTime: ideaInbox ? null : effective.startTime || null,
      durationMinutes: effective.startTime ? (effective.durationMinutes ?? 30) : effective.durationMinutes,
      project,
    });
    task.body = body;
    if (recurrence && !ideaInbox) task.recurrence = recurrence;
    const next = [
      ...tasks,
      important ? { ...task, priority: "highest" as const } : task,
    ];
    onSave(
      important && task.id
        ? markMostImportant(next, task.id, effective.taskDate || taipeiDateKey())
        : next,
    );
    return true;
  };
  // Stray clicks and Escape never destroy a captured thought: with a title
  // present the modal saves itself first (auto-save), otherwise it just closes.
  const closeGracefully = () => {
    if (!submit()) onClose();
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeGracefully();
      }}
    >
      <section
        className="modal quick-add-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("quick.title")}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
            submit();
          if (event.key === "Escape" && !event.nativeEvent.isComposing)
            closeGracefully();
        }}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">QUICK CAPTURE</span>
            <h2>{t("quick.title")}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t("app.close")} title={t("app.close")}>
            <X aria-hidden="true" />
          </button>
        </div>
        <label>
          {t("quick.titleLabel")}
          <input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("quick.placeholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {naturalApplies && natural && (
          <div className="quick-natural-hint" role="status" aria-live="polite">
            <CalendarDays aria-hidden="true" />
            <span>{t("quick.natural.detected", { when: describeNaturalWhen(natural, naturalDate, preferences.language) })}</span>
            <button type="button" className="quick-natural-ignore" onClick={() => setNaturalIgnored(natural.matchedText)}>
              {t("quick.natural.ignore")}
            </button>
          </div>
        )}
        <div className="quick-content-field">
          <span>{t("quick.content")}</span>
          <MarkdownBlockEditor value={body} onChange={setBody} locale={preferences.language} attachmentFolder={attachmentFolderForTask(projects.find((item) => item.id === projectId)?.name)} maxAttachments={1} />
        </div>
        {templates.length > 0 && (
          <div className="quick-template-row">
            <span>{preferences.language === "zh-TW" ? "範本" : "Template"}</span>
            <select
              className="quick-template-select"
              value=""
              onChange={(event) => { const picked = templates.find((item) => item.name === event.target.value); if (picked) { setBody(picked.body); if (!title.trim()) setTitle(picked.name); } }}
            >
              <option value="">{preferences.language === "zh-TW" ? "不使用模板" : "No template"}</option>
              {templates.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </div>
        )}
        <label className="idea-toggle">
          <input
            type="checkbox"
            checked={ideaInbox}
            onChange={(event) => {
              setIdeaInbox(event.target.checked);
              if (event.target.checked) setImportant(false);
            }}
          />
          <span>
            <strong>{t("quick.idea")}</strong>
            <small>{t("quick.ideaHelp")}</small>
          </span>
        </label>
        <div className="quick-grid">
          <div className="quick-project-field">
            <span className="quick-field-label">{t("task.field.project")}</span>
            <ProjectPicker
              projects={projects}
              valueId={projectId || null}
              onSelect={(project) => {
                setProjectId(project?.id ?? "");
                setPickedProject(project);
              }}
              onCreateProject={onCreateProject}
              locale={preferences.language}
              ariaLabel={t("task.field.project")}
            />
          </div>
          <label>
            {t("task.field.date")}
            <input
              type="date"
              disabled={ideaInbox || forceDate}
              value={ideaInbox ? "" : taskDate}
              onChange={(event) => setTaskDate(event.target.value)}
            />
          </label>
          <label>
            {t("task.field.startTime")}
            <input
              type="time"
              disabled={ideaInbox}
              value={ideaInbox ? "" : startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </label>
          <label>
            {t("task.field.duration")}
            <select disabled={ideaInbox} value={durationMinutes ?? (startTime ? 30 : "")} onChange={(event) => setDurationMinutes(event.target.value ? Number(event.target.value) : null)}>
              {!startTime && <option value="">{preferences.language === "zh-TW" ? "未估" : "No estimate"}</option>}
              {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => <option key={minutes} value={minutes}>{minutes} {preferences.language === "zh-TW" ? "分鐘" : "min"}</option>)}
            </select>
          </label>
          {!ideaInbox && (
            <div className="quick-repeat-field">
              <RecurrenceSelect value={recurrence} taskDate={naturalDate ?? taskDate} today={taipeiDateKey()} locale={preferences.language} label={t("task.field.recurrence")} onChange={setRecurrenceChoice} />
            </div>
          )}
        </div>
        <label className="important-toggle">
          <input
            type="checkbox"
            disabled={ideaInbox}
            checked={important}
            onChange={(event) => setImportant(event.target.checked)}
          />
          <span>
            <strong>{t("quick.important")}</strong>
            <small>
              {ideaInbox
                ? t("quick.importantDisabled")
                : t("quick.importantHelp")}
            </small>
          </span>
        </label>
        <aside className="capture-guidance" aria-label={t("quick.guidance")}>
          <span><strong>{t("quick.guidance.taskTitle")}</strong>{t("quick.guidance.task")}</span>
          <span><strong>{t("quick.guidance.projectTitle")}</strong>{t("quick.guidance.project")}</span>
          <span><strong>{t("quick.guidance.collectionTitle")}</strong>{t("quick.guidance.collection")}</span>
        </aside>
        <div className="modal-actions">
          <span>
            {t("quick.keyboard")}
          </span>
          <button className="primary action-with-icon" disabled={!title.trim()} onClick={submit}>
            <Plus aria-hidden="true" />{t("quick.create")}
          </button>
        </div>
      </section>
    </div>
  );
}
