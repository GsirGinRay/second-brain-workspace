import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Clock,
  Columns3,
  Eye,
  FolderKanban,
  Library,
  GripVertical,
  Home,
  Languages,
  List,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  applyRoutineTemplate,
  createDefaultRoutineTemplate,
  enforceTemplateSingleP1,
  getTodayTasks,
  splitTodayTasks,
  completeProject,
  projectColor,
  rankForIndex,
  TEMPLATE_PACKS,
  collectionToPrompt,
  parsePluginExport,
  promptToCollection,
  renderPluginExport,
  extractPromptVariables,
  fillPromptVariables,
  type BrainProjectSnapshot,
  type BrainCollectionSnapshot,
  type BrainTaskSnapshot,
  type RoutineTemplate,
  type RoutineTemplateItem,
  type TaskStatus,
  type TemplatePackId,
} from "@second-brain/brain-core";
import {
  addDateDays,
  buildMonthCells,
  buildWeekDates,
  getCalendarTaskEntries as buildCalendarTaskEntries,
  taipeiDateKey as dateKeyForTaipei,
  searchWorkspace,
  parseWorkspaceQuery,
  type WorkspaceSearchKind,
  type WorkspaceSearchResult,
} from "@second-brain/brain-ui";
import {
  DeviceClient,
  DEFAULT_SERVER_ORIGIN,
  PublisherHttpError,
  type ConflictChoice,
} from "./device-client";
import {
  createNativeAdapter,
  type DiagnosticsSnapshot,
  type NativeAdapter,
} from "./ipc";
import { SyncEngine, type SyncResult } from "./sync-engine";
import { deleteTaskLocalFirst } from "./task-deletion";
import {
  applyTaskPriority,
  archiveTask,
  boardLane,
  completedForDate,
  filterCompletedTasks,
  isCompleteShortcut,
  isEditableElement,
  isQuickAddShortcut,
  markMostImportant,
  moveTaskToLane,
  nextWeekPriorities,
  priorityDisplay,
  scheduleTask,
  type BoardLane,
} from "./task-actions";
import { InlineTitle } from "./inline-title";
import { CategoryInput } from "./category-input";
import { ImportanceControl, PriorityControl, PriorityBadge } from "./priority-control";
import {
  applyDesiredSnapshot,
  buildCollectionCreateChange,
  buildCollectionDeleteChange,
  buildProjectCreateChange,
  buildProjectDeleteChanges,
  type LocalMarkdownFile,
  type MarkdownChange,
} from "./vault";
import {
  DEFAULT_UI_PREFERENCES,
  normalizeUiPreferences,
  translate,
  UI_PREFERENCES_KEY,
  type UiPreferences,
} from "./ui-preferences";
import appLogo from "./assets/app-logo.png";
import { MarkdownEditor } from "./markdown-editor";
import { formatMinutesAsTime, minutesFromOffset, snapMinutes, timeFromSlotDrop } from "./day-schedule";
import { DaySchedule } from "./day-schedule-view";
import { ProjectDetailDialog, TaskDetailDialog } from "./entity-detail-dialog";
import { hasDraftContent, loadDraftWorkspace, saveDraftWorkspace } from "./draft-workspace";
import { decodeBase64, renderIndexChange, scaffoldArchitectureChanges } from "./architecture";
import "./styles.css";

type View = "today" | "calendar" | "board" | "projects" | "collections" | "sync";
// Native (Rust) errors arrive over IPC as plain strings (e.g. "Io", "UnsafePath"),
// never as Error instances, so surface whatever we actually received instead of a
// generic fallback code that hides the real cause.
function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  if (cause != null) {
    try {
      const text = JSON.stringify(cause);
      if (text && text !== "{}" && text !== "null") return text;
    } catch {
      // fall through to the fallback code below
    }
  }
  return fallback;
}
const STATUS_KEYS: Record<TaskStatus, string> = {
  todo: "task.status.todo",
  doing: "task.status.doing",
  waiting: "task.status.waiting",
  done: "task.status.done",
};
const VIEW_KEYS: Record<View, string> = {
  today: "view.today",
  calendar: "view.calendar",
  board: "view.board",
  projects: "view.projects",
  collections: "view.collections",
  sync: "view.sync",
};
const VIEW_TITLE_KEYS: Record<View, string> = {
  today: "view.today.title",
  calendar: "view.calendar.title",
  board: "view.board.title",
  projects: "view.projects.title",
  collections: "view.collections.title",
  sync: "view.sync.title",
};
type Translate = (key: string, values?: Record<string, string | number>) => string;
const UiPreferencesContext = createContext<{ preferences: UiPreferences; t: Translate }>({
  preferences: DEFAULT_UI_PREFERENCES,
  t: (key, values) => translate(DEFAULT_UI_PREFERENCES.language, key, values),
});
function useUiPreferences() {
  return useContext(UiPreferencesContext);
}
function ViewIcon({ view }: { view: View }) {
  const className = "nav-icon";
  if (view === "today") return <Home className={className} />;
  if (view === "calendar") return <CalendarDays className={className} />;
  if (view === "board") return <Columns3 className={className} />;
  if (view === "projects") return <FolderKanban className={className} />;
  if (view === "collections") return <Library className={className} />;
  return <Settings2 className={className} />;
}
const taipeiDateKey = () => dateKeyForTaipei(new Date());
const PENDING_PROJECT_DELETIONS_KEY = "second-brain.pendingProjectDeletions";
function loadUiPreferences(): UiPreferences {
  try {
    return normalizeUiPreferences(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? "null"));
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}
function pendingProjectDeletions(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_PROJECT_DELETIONS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^[0-9a-f-]{36}$/i.test(item)) : [];
  } catch {
    return [];
  }
}
function setPendingProjectDeletions(ids: string[]): void {
  localStorage.setItem(PENDING_PROJECT_DELETIONS_KEY, JSON.stringify([...new Set(ids)]));
}
const getCalendarTaskEntries = (tasks: BrainTaskSnapshot[], today: string) =>
  buildCalendarTaskEntries(
    tasks.filter(
      (task): task is BrainTaskSnapshot & { id: string } => task.id !== null,
    ).map((task) => ({
      ...task,
      taskDate: task.taskDate ?? task.plannedDate ?? task.dueDate ?? null,
    })),
    today,
  );

function taskProjectStyle(task: BrainTaskSnapshot): CSSProperties {
  const color = projectColor(task.projectId ?? task.projectName);
  return {
    "--project-accent": color.accent,
    "--project-soft": color.soft,
    "--project-text": color.text,
  } as CSSProperties;
}

export function App({ adapter: providedAdapter }: { adapter?: NativeAdapter }) {
  const initialDraft = useMemo(() => loadDraftWorkspace(), []);
  const native = useMemo(
    () => providedAdapter ?? createNativeAdapter(),
    [providedAdapter],
  );
  const [view, setView] = useState<View>("today");
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const t = useCallback<Translate>(
    (key, values) => translate(preferences.language, key, values),
    [preferences.language],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(
    () => localStorage.getItem("second-brain.showCompletedTasks") === "true",
  );
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(
    null,
  );
  const [serverOrigin, setServerOrigin] = useState(
    () =>
      localStorage.getItem("second-brain.serverOrigin") ?? DEFAULT_SERVER_ORIGIN,
  );
  const [vaultInput, setVaultInput] = useState("");
  const [tasks, setTasks] = useState<BrainTaskSnapshot[]>(initialDraft.tasks);
  const [projects, setProjects] = useState<BrainProjectSnapshot[]>(initialDraft.projects);
  const [collections, setCollections] = useState<BrainCollectionSnapshot[]>(initialDraft.collections);
  const [onboardingOpen, setOnboardingOpen] = useState(() => localStorage.getItem("second-brain.onboardingCompleted") !== "true");
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [selectedBoardProjectId, setSelectedBoardProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedProjectDetailId, setSelectedProjectDetailId] = useState<string | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [createEntity, setCreateEntity] = useState<"project" | "collection" | null>(null);
  const [promotedTask, setPromotedTask] = useState<BrainTaskSnapshot | null>(null);
  const [routineTemplate, setRoutineTemplate] = useState<RoutineTemplate>(() => createDefaultRoutineTemplate(crypto.randomUUID()));
  const [files, setFiles] = useState<LocalMarkdownFile[]>([]);
  const [status, setStatus] = useState("正在啟動…");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Extract<
    SyncResult,
    { kind: "conflict" }
  > | null>(null);
  const [choices, setChoices] = useState<Record<string, "local" | "server">>(
    {},
  );
  const [pairing, setPairing] = useState<{
    pairingId: string;
    pollingSecret: string;
    userCode: string;
    expiresAt: string;
  } | null>(null);
  const [devicePaired, setDevicePaired] = useState(false);
  const [writeApproved, setWriteApproved] = useState(
    () => localStorage.getItem("second-brain.agentWriteApproved") === "true",
  );
  const [preview, setPreview] = useState<Extract<
    SyncResult,
    { kind: "preview" }
  > | null>(null);
  const [previewDismissed, setPreviewDismissed] = useState(false);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [selectedPacks, setSelectedPacks] = useState<TemplatePackId[]>([
    "projects",
    "knowledge",
    "prompts",
    "ai",
    "templates",
  ]);
  const [importPromptsOpen, setImportPromptsOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [exportPromptsOpen, setExportPromptsOpen] = useState(false);
  const [exportText, setExportText] = useState("");
  const [exportCopied, setExportCopied] = useState(false);
  const [templates, setTemplates] = useState<{ name: string; body: string }[]>([]);
  const [pendingScaffold, setPendingScaffold] = useState<MarkdownChange[] | null>(null);
  const [scaffoldPreviewPaths, setScaffoldPreviewPaths] = useState<string[]>([]);

  const promptCollections = collections.filter((item) =>
    (item.category ?? "").trim().toLowerCase().startsWith("提示詞"),
  );
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedProjectDetail = projects.find((project) => project.id === selectedProjectDetailId) ?? null;
  const doImportPrompts = () => {
    setImportError("");
    let imported;
    try {
      imported = parsePluginExport(importText);
    } catch (cause) {
      setImportError(describeError(cause, "IMPORT_FAILED"));
      return;
    }
    const next = [
      ...collections,
      ...imported.map((prompt) => ({
        ...promptToCollection(prompt),
        id: crypto.randomUUID(),
      })),
    ];
    void persistLocal(tasks, projects, next);
    setImportPromptsOpen(false);
  };
  const syncRunningRef = useRef(false);
  const cloudEtagRef = useRef<string | null>(null);
  const routineTemplateRef = useRef(routineTemplate);
  const allowCloseRef = useRef(false);
  const lastScanRef = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (providedAdapter) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested((event) => {
        if (allowCloseRef.current || diagnostics?.selectedVault || !hasDraftContent(loadDraftWorkspace())) return;
        event.preventDefault();
        setCloseGuardOpen(true);
      }),
    ).then((value) => { unlisten = value; }).catch(() => undefined);
    return () => unlisten?.();
  }, [diagnostics?.selectedVault, providedAdapter]);

  async function leaveWithLocalDraft(): Promise<void> {
    allowCloseRef.current = true;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      setCloseGuardOpen(false);
    }
  }

  useEffect(() => {
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
    document.documentElement.lang = preferences.language;
    document.documentElement.dataset.theme = preferences.theme;
    delete document.documentElement.dataset.density;
  }, [preferences]);

  const client = useMemo(
    () => (serverOrigin ? new DeviceClient(serverOrigin, native) : null),
    [native, serverOrigin],
  );
  const engine = useMemo(
    () => (client ? new SyncEngine(native, client) : null),
    [client, native],
  );

  useEffect(() => {
    void native.loadRoutineTemplate?.().then((value) => {
      if (value) {
        // Templates stored before the single-P1 rule existed can hold several; fold them on the way in.
        const single = enforceTemplateSingleP1(value);
        routineTemplateRef.current = single;
        setRoutineTemplate(single);
      }
    }).catch(() => undefined);
  }, [native]);

  const saveRoutineTemplate = useCallback((value: RoutineTemplate) => {
    const single = enforceTemplateSingleP1(value);
    const next = { ...single, version: single.version + 1, updatedAt: new Date().toISOString() };
    routineTemplateRef.current = next;
    setRoutineTemplate(next);
    void native.saveRoutineTemplate?.(next);
  }, [native]);

  useEffect(() => {
    if (!client || !devicePaired) return;
    const timer = window.setTimeout(() => {
      void client.getRoutineTemplate().then(async (remote) => {
        const local = routineTemplateRef.current;
        if (local.updatedAt > remote.updatedAt) {
          const saved = await client.saveRoutineTemplate({ ...local, version: remote.version });
          routineTemplateRef.current = saved;
          setRoutineTemplate(saved);
          await native.saveRoutineTemplate?.(saved);
          return;
        }
        if (remote.version !== local.version || remote.updatedAt !== local.updatedAt) {
          const single = enforceTemplateSingleP1(remote);
          routineTemplateRef.current = single;
          setRoutineTemplate(single);
          await native.saveRoutineTemplate?.(single);
        }
      }).catch((cause) => {
        if (cause instanceof PublisherHttpError && cause.code === "ROUTINE_TEMPLATES_DISABLED") return;
        const message = describeError(cause, "ROUTINE_TEMPLATE_SYNC_FAILED");
        setError(`每日啟動模板同步失敗：${message}`);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [client, devicePaired, native, routineTemplate]);

  useEffect(() => {
    if (!client || !devicePaired) return;
    const pending = pendingProjectDeletions();
    if (pending.length === 0) return;
    void Promise.allSettled(pending.map(async (id) => {
      await client.deleteProjectPermanently(id);
      return id;
    })).then((results) => {
      const completed = new Set(results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
      setPendingProjectDeletions(pending.filter((id) => !completed.has(id)));
    });
  }, [client, devicePaired]);

  useEffect(() => {
    const openGlobalAction = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "/" && !isEditableElement(event.target)) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key.toLowerCase() === "n" && !isEditableElement(event.target)) {
        event.preventDefault();
        setQuickAddOpen(true);
      }
    };
    window.addEventListener("keydown", openGlobalAction);
    return () => window.removeEventListener("keydown", openGlobalAction);
  }, []);

  const refreshAiIndex = useCallback(
    async (
      local: {
        tasks: BrainTaskSnapshot[];
        projects: BrainProjectSnapshot[];
        collections: BrainCollectionSnapshot[];
      },
      enabled: boolean,
    ) => {
      if (!enabled) return;
      try {
        // Missing .ai/INDEX.md reads as an IPC error; fall back to "not created
        // yet" so the background refresh can create the initial index.
        const existingFiles = await native
          .readMarkdownFiles([".ai/INDEX.md"])
          .catch(() => []);
        const change = renderIndexChange(
          {
            today: taipeiDateKey(),
            generatedAt: new Date().toISOString(),
            tasks: local.tasks,
            projects: local.projects,
            collections: local.collections ?? [],
          },
          existingFiles[0],
        );
        if (change) await native.applyMarkdownChanges([change]);
      } catch {
        // Background index maintenance is deliberately quiet; a later reload catches up.
      }
    },
    [native],
  );

  const loadTemplates = useCallback(
    async (enabled: boolean) => {
      if (!enabled || !native.listManagedFiles) {
        setTemplates([]);
        return;
      }
      try {
        const paths = await native.listManagedFiles("90-模板");
        if (paths.length === 0) {
          setTemplates([]);
          return;
        }
        const files = await native.readMarkdownFiles(paths);
        setTemplates(
          files.map((file) => ({
            name:
              file.relativePath.split("/").pop()?.replace(/\.md$/i, "") ??
              file.relativePath,
            body: decodeBase64(file.bytesBase64),
          })),
        );
      } catch {
        // Template discovery is best-effort; the app works without it.
      }
    },
    [native],
  );

  const startArchitectureOnboarding = async () => {
    localStorage.setItem("second-brain.onboardingCompleted", "true");
    setOnboardingOpen(false);
    if (!diagnostics?.selectedVault) {
      const ok = await browseVault();
      if (!ok) return; // user cancelled folder selection; they can build later from settings
    }
    setArchitectureOpen(true);
  };

  const prepareArchitecture = async () => {
    setWorking(true);
    setError("");
    try {
      const changes = scaffoldArchitectureChanges(
        files.map((file) => file.relativePath),
        selectedPacks,
      );
      // A brand-new vault has no .ai/INDEX.md yet; treat the failed read as
      // "not created" so scaffolding (whose job is to create it) can proceed.
      const existingFiles = await native
        .readMarkdownFiles([".ai/INDEX.md"])
        .catch(() => []);
      const indexChange = renderIndexChange(
        {
          today: taipeiDateKey(),
          generatedAt: new Date().toISOString(),
          tasks,
          projects,
          collections,
        },
        existingFiles[0],
      );
      if (indexChange) changes.push(indexChange);
      if (changes.length === 0) {
        setStatus("知識架構已存在，未覆寫任何既有檔案");
        setArchitectureOpen(false);
        return;
      }
      // Human-in-the-loop: present what will be created before writing anything.
      setScaffoldPreviewPaths(changes.map((change) => change.relativePath));
      setPendingScaffold(changes);
      setArchitectureOpen(false);
    } catch (cause) {
      setError(`準備知識架構失敗：${describeError(cause, "SCAFFOLD_PREP_FAILED")}`);
    } finally {
      setWorking(false);
    }
  };

  const confirmArchitecture = async () => {
    if (!pendingScaffold || pendingScaffold.length === 0) return;
    setWorking(true);
    setError("");
    try {
      // Re-resolve the index change at confirm time: the background index
      // refresh may have (re)written .ai/INDEX.md while the review modal was
      // open, which would invalidate the hash captured during preparation and
      // fail the whole batch with HashPrecondition.
      const changes = pendingScaffold.filter(
        (change) => change.relativePath !== ".ai/INDEX.md",
      );
      const existingIndex = await native
        .readMarkdownFiles([".ai/INDEX.md"])
        .catch(() => []);
      const indexChange = renderIndexChange(
        {
          today: taipeiDateKey(),
          generatedAt: new Date().toISOString(),
          tasks,
          projects,
          collections,
        },
        existingIndex[0],
      );
      if (indexChange) changes.push(indexChange);
      if (changes.length === 0) {
        setStatus("知識架構已存在，未覆寫任何既有檔案");
        return;
      }
      await native.applyMarkdownChanges(changes);
      await reloadLocal();
      setStatus("知識架構已建立；AI 委任檔、索引與模板已就緒");
    } catch (cause) {
      setError(`建立知識架構失敗：${describeError(cause, "SCAFFOLD_FAILED")}`);
    } finally {
      setPendingScaffold(null);
      setScaffoldPreviewPaths([]);
      setWorking(false);
    }
  };

  const reloadLocal = useCallback(
    async (updateStatus = true) => {
      const nextDiagnostics = await native.getDiagnostics();
      setDiagnostics(nextDiagnostics);
      if (nextDiagnostics.publisherOrigin) {
        setServerOrigin(nextDiagnostics.publisherOrigin);
      }
      if (!nextDiagnostics.selectedVault) {
        lastScanRef.current = null;
        const draft = loadDraftWorkspace();
        setTasks(draft.tasks);
        setProjects(draft.projects);
        setCollections(draft.collections);
        if (updateStatus) setStatus(hasDraftContent(draft) ? "內容已暫存在這台裝置；關閉前請選擇 Markdown 資料夾" : "可先建立內容，關閉前再選擇 Markdown 資料夾");
        return;
      }
      if (hasDraftContent(loadDraftWorkspace())) await flushDraftsToSelectedVault();
      const loader =
        engine ??
        new SyncEngine(native, {
          async getState() {
            throw new Error("SERVER_NOT_CONFIGURED");
          },
          async createPlan() {
            throw new Error("SERVER_NOT_CONFIGURED");
          },
          async commitPlan() {
            throw new Error("SERVER_NOT_CONFIGURED");
          },
          async getPlanStatus() {
            throw new Error("SERVER_NOT_CONFIGURED");
          },
        });
      let local = await loader.loadLocal();
      // Capture warnings from the first pass: healing (below) rewrites the
      // broken markers, so a re-scan reports clean and the anomaly would
      // otherwise vanish without ever being shown.
      const scanWarnings = local.warnings;
      if (local.bootstrapChanges.length > 0) {
        await native.applyMarkdownChanges(local.bootstrapChanges);
        local = await loader.loadLocal();
      }
      if (scanWarnings.length > 0) {
        const describeIssue = (issue: string) =>
          issue === "unparsable"
            ? "標記無法解析"
            : issue === "duplicate-id"
              ? "id 與其他任務重複"
              : "標記 id 不安全";
        const shown = scanWarnings
          .slice(0, 3)
          .map((w) => `${w.relativePath} 第 ${w.line} 行（${describeIssue(w.issue)}）`)
          .join("；");
        const more = scanWarnings.length > 3 ? `，等共 ${scanWarnings.length} 處` : "";
        setError(`任務標記異常已自動修復：${shown}${more}。原文已保留，僅重建機器標記；來源可能是中斷的同步寫入或手動編輯，建議確認該行內容無誤。`);
      }
      const signatures = new Map(
        local.files.map((file) => [file.relativePath, file.sha256]),
      );
      const unchanged =
        lastScanRef.current !== null &&
        signatures.size === lastScanRef.current.size &&
        [...signatures].every(
          ([path, hash]) => lastScanRef.current!.get(path) === hash,
        );
      lastScanRef.current = signatures;
      if (unchanged && !updateStatus) return;
      setFiles(local.files);
      setTasks(local.tasks);
      setProjects(local.projects);
      setCollections(local.collections ?? []);
      if (nextDiagnostics.selectedVault) {
        void refreshAiIndex(
          {
            tasks: local.tasks,
            projects: local.projects,
            collections: local.collections ?? [],
          },
          true,
        );
        void loadTemplates(true);
      }
      if (updateStatus)
        setStatus(
          `已載入 ${local.tasks.length} 項任務 · ${local.projects.length} 個專案 · ${local.collections.length} 個收藏`,
        );
      return local;
    },
    [engine, native, refreshAiIndex, loadTemplates],
  );

  useEffect(() => {
    void reloadLocal().catch((cause) => {
      const message =
        describeError(cause, "DIAGNOSTICS_FAILED");
      setError(`App 啟動診斷失敗：${message}`);
    });
  }, [reloadLocal]);

  const runSync = useCallback(
    async ({
      forceWrite = false,
      background = false,
    }: { forceWrite?: boolean; background?: boolean } = {}) => {
      if (!engine || syncRunningRef.current || !diagnostics?.selectedVault)
        return;
      syncRunningRef.current = true;
      if (!background) {
        setWorking(true);
        setError("");
        setStatus("正在安全同步…");
      }
      try {
        const result = await engine.sync({
          previewOnly: !(writeApproved || forceWrite),
        });
        if (result.kind === "preview") {
          if (!background && !previewDismissed) setPreview(result);
          if (!background)
            setStatus("Shadow 預覽完成；尚未寫入 Markdown 或提交雲端");
        } else if (result.kind === "conflict") {
          setConflict(result);
          setChoices({});
          setStatus(
            `同步已暫停：${result.plan.conflicts.length} 筆衝突需要選擇`,
          );
        } else {
          setLastSync(new Date().toISOString());
          if (!background) setStatus("已同步到第二大腦雲端");
          await reloadLocal(!background);
        }
        const currentState = await client?.getState(null);
        if (currentState) setDevicePaired(true);
        if (currentState?.kind === "modified")
          cloudEtagRef.current = currentState.etag;
      } catch (cause) {
        const message = describeError(cause, "SYNC_FAILED");
        if (!background) {
          if (/401|DEVICE_|AUTH/i.test(message)) {
            setDevicePaired(false);
            setStatus("此裝置尚未配對，請到同步設定開始配對");
          } else setError(`同步失敗：${message}`);
        }
      } finally {
        syncRunningRef.current = false;
        if (!background) setWorking(false);
      }
    },
    [
      client,
      diagnostics?.selectedVault,
      engine,
      previewDismissed,
      reloadLocal,
      writeApproved,
    ],
  );

  const pollCloudRevision = useCallback(async () => {
    if (!client || syncRunningRef.current || !diagnostics?.selectedVault)
      return;
    try {
      const result = await client.getState(cloudEtagRef.current);
      setDevicePaired(true);
      if (result.kind === "not-modified") return;
      cloudEtagRef.current = result.etag;
      await runSync({ background: true });
    } catch {
      // Background polling is deliberately quiet; manual sync still shows actionable errors.
    }
  }, [client, diagnostics?.selectedVault, runSync]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        isQuickAddShortcut({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          editable: isEditableElement(event.target),
        })
      ) {
        event.preventDefault();
        setQuickAddOpen(true);
      }
      if (event.key === "Escape") setQuickAddOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let debounce: number | undefined;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("vault-changed", () => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => {
            if (engine) void runSync({ background: true });
            else void reloadLocal(false);
          }, 3_000);
        }),
      )
      .then((value) => {
        unlisten = value;
      });
    const cloudPoll = window.setInterval(
      () => void pollCloudRevision(),
      30_000,
    );
    const reconcile = window.setInterval(
      () => void runSync({ background: true }),
      5 * 60_000,
    );
    const onOnline = () => void pollCloudRevision();
    const onFocus = () => void pollCloudRevision();
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    void pollCloudRevision();
    return () => {
      unlisten?.();
      window.clearTimeout(debounce);
      window.clearInterval(cloudPoll);
      window.clearInterval(reconcile);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
    };
  }, [engine, pollCloudRevision, reloadLocal, runSync]);

  async function persistLocal(
    nextTasks: BrainTaskSnapshot[],
    nextProjects = projects,
    nextCollections = collections,
  ): Promise<boolean> {
    if (!diagnostics?.selectedVault) {
      saveDraftWorkspace({ tasks: nextTasks, projects: nextProjects, collections: nextCollections });
      setTasks(nextTasks);
      setProjects(nextProjects);
      setCollections(nextCollections);
      setStatus("已暫存在這台裝置；關閉前請選擇 Markdown 資料夾");
      return true;
    }
    const changes = applyDesiredSnapshot(files, {
      schemaVersion: 6,
      tasks: nextTasks,
      projects: nextProjects,
      collections: nextCollections,
      fileHashes: {},
    });
    if (changes.length === 0) {
      setTasks(nextTasks);
      setProjects(nextProjects);
      setCollections(nextCollections);
      return true;
    }
    setWorking(true);
    setError("");
    try {
      await native.applyMarkdownChanges(changes);
      setStatus("已儲存在本機 · 等待同步");
      await reloadLocal();
      if (devicePaired) {
        window.setTimeout(() => void runSync({ background: true }), 50);
      }
      return true;
    } catch (cause) {
      const message = describeError(cause, "WRITE_FAILED");
      // A concurrent writer (background sync, the web adapter, or another
      // editor) can move a file between our scan and the write. Re-scan once
      // and re-apply the diff so the user's calendar edit still lands instead
      // of being silently dropped.
      if (/changed before write|HASH_PRECONDITION/i.test(message)) {
        try {
          const fresh = await reloadLocal();
          if (fresh && fresh.files.length > 0) {
            const retryChanges = applyDesiredSnapshot(fresh.files, {
              schemaVersion: 6,
              tasks: nextTasks,
              projects: nextProjects,
              collections: nextCollections,
              fileHashes: {},
            });
            if (retryChanges.length > 0) {
              await native.applyMarkdownChanges(retryChanges);
              setStatus("已儲存在本機 · 等待同步");
              await reloadLocal();
              if (devicePaired) {
                window.setTimeout(() => void runSync({ background: true }), 50);
              }
              return true;
            }
          }
        } catch {
          // fall through and surface the original failure
        }
      }
      setError(`本機寫入失敗：${message}`);
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function createProject(
    name: string,
    area: string | null,
    priority: number | null,
    promotedTask?: BrainTaskSnapshot,
    body = "",
  ): Promise<boolean> {
    const id = crypto.randomUUID();
    if (!diagnostics?.selectedVault) {
      const project: BrainProjectSnapshot = { schemaVersion: 6, id, name: name.trim(), sourcePath: null, status: "planning", area, priority, progress: 0, focusToday: false, startDate: null, endDate: null, completedAt: null, body };
      const nextProjects = [...projects, project];
      const nextTasks = promotedTask ? tasks.map((task) => task.id === promotedTask.id ? { ...task, projectId: id, projectName: name.trim() } : task) : tasks;
      await persistLocal(nextTasks, nextProjects);
      setStatus(promotedTask ? "想法已升級為規劃中專案草稿" : "已建立規劃中專案草稿");
      return true;
    }
    const create = buildProjectCreateChange(name, area, priority, files.map((file) => file.relativePath), () => id, body);
    const nextTasks = promotedTask
      ? tasks.map((task) => task.id === promotedTask.id ? { ...task, projectId: id, projectName: name.trim() } : task)
      : tasks;
    const taskChanges = promotedTask ? applyDesiredSnapshot(files, {
      schemaVersion: 6,
      tasks: nextTasks,
      projects,
      collections,
      fileHashes: {},
    }) : [];
    setWorking(true);
    setError("");
    try {
      await native.applyMarkdownChanges([...taskChanges, create]);
      await reloadLocal();
      setStatus(promotedTask ? "想法已升級為規劃中專案" : "已建立規劃中專案");
      return true;
    } catch (cause) {
      setError(`建立專案失敗：${describeError(cause, "CREATE_PROJECT_FAILED")}`);
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function createCollection(name: string, category: string | null, importance: number | null, body = ""): Promise<boolean> {
    if (!diagnostics?.selectedVault) {
      const collection: BrainCollectionSnapshot = { schemaVersion: 6, id: crypto.randomUUID(), name: name.trim(), sourcePath: null, category, importance, body };
      await persistLocal(tasks, projects, [...collections, collection]);
      setStatus("已建立收藏草稿；關閉前請選擇 Markdown 資料夾");
      return true;
    }
    const change = buildCollectionCreateChange(name, category, importance, files.map((file) => file.relativePath), undefined, body);
    setWorking(true);
    setError("");
    try {
      await native.applyMarkdownChanges([change]);
      await reloadLocal();
      setStatus("收藏已建立；內容保留在本機 Markdown");
      return true;
    } catch (cause) {
      setError(`建立收藏失敗：${describeError(cause, "CREATE_COLLECTION_FAILED")}`);
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyDeleteProject(project: BrainProjectSnapshot): Promise<void> {
    const openCount = tasks.filter((task) => task.projectId === project.id && task.status !== "done").length;
    if (!project.id || !window.confirm(
      `永久刪除「${project.name}」？\n\n將刪除專案 Markdown，保留 ${openCount} 項未完成任務並解除專案連結。刪除前會建立可驗證備份。\n來源：${project.sourcePath ?? "未知"}`,
    )) return;
    setWorking(true);
    setError("");
    try {
      const changes = buildProjectDeleteChanges(files, {
        schemaVersion: 6,
        tasks,
        projects,
        collections,
        fileHashes: {},
      }, project.id);
      await native.applyMarkdownChanges(changes);
      await reloadLocal();
      if (devicePaired && client) {
        try {
          await client.deleteProjectPermanently(project.id);
          setPendingProjectDeletions(pendingProjectDeletions().filter((id) => id !== project.id));
        } catch (cause) {
          setPendingProjectDeletions([...pendingProjectDeletions(), project.id]);
          setError(`本機專案已刪除；遠端刪除待重試：${describeError(cause, "DELETE_FAILED")}`);
        }
      }
      setStatus("專案已刪除，關聯任務已保留並解除連結");
    } catch (cause) {
      setError(`刪除專案失敗：${describeError(cause, "DELETE_PROJECT_FAILED")}`);
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyDeleteCollection(collection: BrainCollectionSnapshot): Promise<void> {
    if (!collection.id) return;
    if (!window.confirm(
      `永久刪除收藏「${collection.name}」？\n\n這會刪除收藏 Markdown，無法在 App 內復原。${collection.sourcePath ? `\n來源：${collection.sourcePath}` : ""}`,
    )) return;
    setWorking(true);
    setError("");
    try {
      if (diagnostics?.selectedVault) {
        const changes = applyDesiredSnapshot(files, {
          schemaVersion: 6,
          tasks,
          projects,
          collections: collections.filter((item) => item.id !== collection.id),
          fileHashes: {},
        });
        if (collection.sourcePath) {
          const source = files.find((file) => file.relativePath === collection.sourcePath);
          if (source) changes.push({
            relativePath: collection.sourcePath,
            expectedSha256: source.sha256,
            operation: "delete",
            replacementBase64: "",
          });
        }
        if (changes.length > 0) {
          await native.applyMarkdownChanges(changes);
          setStatus("收藏已刪除 · 等待同步");
          await reloadLocal();
          if (devicePaired) {
            window.setTimeout(() => void runSync({ background: true }), 50);
          }
        }
      } else {
        await persistLocal(tasks, projects, collections.filter((item) => item.id !== collection.id));
      }
      if (selectedCollectionId === collection.id) setSelectedCollectionId(null);
      setStatus("收藏已刪除");
    } catch (cause) {
      setError(`刪除收藏失敗：${describeError(cause, "DELETE_COLLECTION_FAILED")}`);
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyDeleteTask(task: BrainTaskSnapshot) {
    const source = task.sourcePath ? `\n本機來源：${task.sourcePath}` : "";
    const scope = client && task.id
      ? "這會刪除雲端資料，並從本機 Markdown 移除整行"
      : "目前是本機模式，這會從本機 Markdown 移除整行";
    if (
      !window.confirm(
        `永久刪除「${task.title}」？\n\n${scope}，無法在 App 內復原。${source}`,
      )
    )
      return;
    setWorking(true);
    setError("");
    const outcome = await deleteTaskLocalFirst({
      deleteLocal: () => persistLocal(tasks.filter((item) => task.id ? item.id !== task.id : item !== task)),
      deleteRemote: client && task.id ? () => client.deleteTaskPermanently(task.id!) : undefined,
      remoteEnabled: devicePaired,
    });
    if (!outcome.localDeleted) {
      setWorking(false);
      return;
    }
    if (outcome.remoteDeleted === false) {
      setError(
        outcome.needsPairing
          ? "本機任務已刪除；Publisher 裝置授權已失效，請到「同步與設定」重新配對，遠端變更會在之後同步。"
          : `本機任務已刪除；Publisher 尚未刪除：${outcome.remoteError ?? "DELETE_FAILED"}`,
      );
      if (outcome.needsPairing) setDevicePaired(false);
      setStatus("本機 Markdown 已安全刪除 · 遠端待同步");
    } else {
      setStatus(outcome.remoteDeleted ? "任務已從雲端與本機 Markdown 永久刪除" : "任務已從本機 Markdown 永久刪除");
    }
    setWorking(false);
  }

  async function flushDraftsToSelectedVault(): Promise<void> {
    const draft = loadDraftWorkspace();
    if (!hasDraftContent(draft)) return;
    const loader = engine ?? new SyncEngine(native, {
      async getState() { throw new Error("SERVER_NOT_CONFIGURED"); },
      async createPlan() { throw new Error("SERVER_NOT_CONFIGURED"); },
      async commitPlan() { throw new Error("SERVER_NOT_CONFIGURED"); },
      async getPlanStatus() { throw new Error("SERVER_NOT_CONFIGURED"); },
    });
    const local = await loader.loadLocal();
    const usedPaths = local.files.map((file) => file.relativePath);
    const creates = [];
    for (const project of draft.projects) {
      const change = buildProjectCreateChange(project.name, project.area, project.priority, usedPaths, () => project.id ?? crypto.randomUUID(), project.body ?? "");
      usedPaths.push(change.relativePath);
      creates.push(change);
    }
    for (const collection of draft.collections) {
      const change = buildCollectionCreateChange(collection.name, collection.category, collection.importance, usedPaths, () => collection.id ?? crypto.randomUUID(), collection.body);
      usedPaths.push(change.relativePath);
      creates.push(change);
    }
    const taskChanges = draft.tasks.length ? applyDesiredSnapshot(local.files, {
      schemaVersion: 6,
      tasks: [...local.tasks, ...draft.tasks],
      projects: local.projects,
      collections: local.collections,
      fileHashes: {},
    }) : [];
    if (creates.length || taskChanges.length) await native.applyMarkdownChanges([...taskChanges, ...creates]);
    saveDraftWorkspace({ tasks: [], projects: [], collections: [] });
  }

  async function selectVault(path = vaultInput) {
    setWorking(true);
    setError("");
    try {
      await native.selectVault(path);
      await flushDraftsToSelectedVault();
      setVaultInput("");
      await reloadLocal();
    } catch (cause) {
      setError(
        `無法使用此資料夾：${describeError(cause, "VAULT_SELECTION_FAILED")}`,
      );
    } finally {
      setWorking(false);
    }
  }

  async function browseVault(): Promise<boolean> {
    setWorking(true);
    setError("");
    try {
      const path = await native.pickVaultFolder();
      if (!path) return false;
      setVaultInput(path);
      await native.selectVault(path);
      await flushDraftsToSelectedVault();
      setVaultInput("");
      await reloadLocal();
      return true;
    } catch (cause) {
      setError(
        `無法選擇資料夾：${describeError(cause, "FOLDER_PICKER_FAILED")}`,
      );
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function configureServer() {
    try {
      const normalized = new DeviceClient(diagnostics?.publisherOrigin ?? serverOrigin, native).origin;
      localStorage.setItem("second-brain.serverOrigin", normalized);
      setServerOrigin(normalized);
      setStatus("雲端同步服務已設定");
    } catch {
      setError("正式伺服器必須使用 HTTPS。");
    }
  }

  async function startPairing() {
    if (!client) return;
    setWorking(true);
    setError("");
    try {
      const result = await client.startPairing("第二大腦工作台");
      setPairing(result);
      setStatus("請在第二大腦網頁核准配對碼");
      await client.openPairingPage(result.pairingId);
    } catch (cause) {
      setError(
        `無法開始配對：${describeError(cause, "PAIR_FAILED")}`,
      );
    } finally {
      setWorking(false);
    }
  }

  function openPairingWebsite() {
    if (!client || !pairing) return;
    void client.openPairingPage(pairing.pairingId).catch((cause) => {
      setError(`無法開啟 Publisher 配對頁：${describeError(cause, "OPEN_PAIRING_FAILED")}`);
    });
  }

  useEffect(() => {
    if (!pairing || !client) return;
    const timer = window.setInterval(
      () =>
        void client
          .pairingStatus(pairing.pairingId, pairing.pollingSecret)
          .then(async (result) => {
            if (result.status === "paired") {
              window.clearInterval(timer);
              if (!result.deviceId)
                throw new Error("PAIRING_DEVICE_ID_MISSING");
              await native.completeDevicePairing(result.deviceId);
              setDevicePaired(true);
              setPairing(null);
              setStatus("裝置已配對，開始第一次同步");
              void runSync();
            }
          })
          .catch((cause) =>
            setError(
              `無法完成配對：${describeError(cause, "PAIRING_FAILED")}`,
            ),
          ),
      2_000,
    );
    return () => window.clearInterval(timer);
  }, [client, native, pairing, runSync]);

  async function resolveConflicts() {
    if (!conflict || !engine) return;
    const selections: ConflictChoice[] = [];
    for (const item of conflict.plan.conflicts)
      for (const field of item.fields) {
        const choice = choices[`${item.entity}:${item.id}:${field}`];
        if (!choice) {
          setError("請先選完每一個衝突欄位。");
          return;
        }
        selections.push({ entity: item.entity, id: item.id, field, choice });
      }
    setWorking(true);
    try {
      await engine.resolveConflict(conflict, selections);
      setConflict(null);
      setChoices({});
      setLastSync(new Date().toISOString());
      await reloadLocal();
      setStatus("衝突已解決並同步");
    } catch (cause) {
      setError(
        `衝突提交失敗：${describeError(cause, "COMMIT_FAILED")}`,
      );
    } finally {
      setWorking(false);
    }
  }

  const requestManualSync = () => {
    if (!devicePaired) {
      setView("sync");
      setError("請先完成步驟 3 的安全配對，再執行同步。");
      return;
    }
    setPreviewDismissed(false);
    void runSync();
  };
  const approveFirstWrite = async () => {
    localStorage.setItem("second-brain.agentWriteApproved", "true");
    setWriteApproved(true);
    setPreview(null);
    await runSync({ forceWrite: true });
  };
  const returnToShadowMode = () => {
    localStorage.removeItem("second-brain.agentWriteApproved");
    setWriteApproved(false);
    setStatus("已切換 Shadow 模式；同步只產生預覽，不寫入 Markdown");
  };

  const content =
    view === "today" ? (
      <Today
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onShowCompletedChange={setCompletedVisibility}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
        onOpenTask={setSelectedTaskId}
        onQuickAdd={() => setQuickAddOpen(true)}
        routineTemplate={routineTemplate}
        onRoutineTemplateChange={saveRoutineTemplate}
      />
    ) : view === "calendar" ? (
      <Calendar
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onShowCompletedChange={setCompletedVisibility}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
        onOpenTask={setSelectedTaskId}
        onPromote={(task) => {
          setPromotedTask(task);
          setCreateEntity("project");
        }}
      />
    ) : view === "board" ? (
      <Board
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onShowCompletedChange={setCompletedVisibility}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
        onOpenTask={setSelectedTaskId}
        selectedProjectId={selectedBoardProjectId}
        onProjectFilterChange={setSelectedBoardProjectId}
        onBackToProjects={() => setView("projects")}
      />
    ) : view === "projects" ? (
      <Projects
        projects={projects}
        tasks={tasks}
        onOpenProject={setSelectedProjectDetailId}
        onOpenBoard={(projectId) => {
          setSelectedBoardProjectId(projectId);
          setView("board");
        }}
        onCreate={() => setCreateEntity("project")}
      />
    ) : view === "collections" ? (
      <Collections
        collections={collections}
        selectedId={selectedCollectionId}
        onSelect={setSelectedCollectionId}
        onCreate={() => setCreateEntity("collection")}
        onSave={(collection) => void persistLocal(tasks, projects, collections.map((item) => item.id === collection.id ? collection : item))}
        onDelete={(collection) => void permanentlyDeleteCollection(collection)}
        onImportPrompts={() => { setImportText(""); setImportError(""); setImportPromptsOpen(true); }}
        onExportPrompts={() => { const json = renderPluginExport(promptCollections.map((c) => collectionToPrompt(c))); setExportText(json); setExportCopied(false); setExportPromptsOpen(true); }}
      />
    ) : (
      <SyncSettings
        diagnostics={diagnostics}
        serverOrigin={serverOrigin}
        setServerOrigin={setServerOrigin}
        vaultInput={vaultInput}
        setVaultInput={setVaultInput}
        pairing={pairing}
        devicePaired={devicePaired}
        working={working}
        writeApproved={writeApproved}
        onBrowseVault={browseVault}
        onSelectVault={() => selectVault()}
        onConfigureServer={configureServer}
        onStartPairing={startPairing}
        onOpenPairingWebsite={openPairingWebsite}
        onSync={requestManualSync}
        onShadow={returnToShadowMode}
        onOpenArchitecture={() => setArchitectureOpen(true)}
      />
    );

  return (
    <UiPreferencesContext.Provider value={{ preferences, t }}>
    <div data-theme={preferences.theme} className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src={appLogo} alt="" aria-hidden="true" />
          <div>
            <strong>{t("app.name")}</strong>
            <small>{t("app.tagline")}</small>
          </div>
        </div>
        <nav>
          {(Object.keys(VIEW_KEYS) as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
              aria-label={t(VIEW_KEYS[item])}
              title={t(VIEW_KEYS[item])}
            >
              <ViewIcon view={item} />
              <span>{t(VIEW_KEYS[item])}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${navigator.onLine ? "online" : ""}`} />
          <span>{navigator.onLine ? t("app.online") : t("app.offline")}</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="title-row">
            <button
              className="icon-button"
              aria-label={t("app.sidebar")}
              title={t("app.sidebar")}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <Menu aria-hidden="true" />
            </button>
            <div>
              <h1>{t(VIEW_TITLE_KEYS[view])}</h1>
              <p>{status}</p>
            </div>
          </div>
          <div className="top-actions">
            <button className="icon-button top-icon-action" aria-label={t("app.search")} title={`${t("app.search")} · Ctrl/Cmd+K`} onClick={() => setSearchOpen(true)}>
              <Search aria-hidden="true" />
            </button>
            <button
              className="icon-button top-icon-action"
              aria-label={t("app.quickAdd")}
              title={`${t("app.quickAdd")} · N`}
              onClick={() => setQuickAddOpen(true)}
            >
              <Plus aria-hidden="true" />
            </button>
            <button
              className="icon-button top-icon-action"
              aria-label={t("app.language")}
              title={t("app.language")}
              onClick={() => setPreferences((value) => ({ ...value, language: value.language === "zh-TW" ? "en" : "zh-TW" }))}
            >
              <Languages aria-hidden="true" />
              <small aria-hidden="true">{preferences.language === "zh-TW" ? "中" : "EN"}</small>
            </button>
            <button
              className="icon-button top-icon-action"
              aria-label={t("app.theme")}
              title={preferences.theme === "light" ? t("app.theme.dark") : t("app.theme.light")}
              onClick={() => setPreferences((value) => ({ ...value, theme: value.theme === "light" ? "dark" : "light" }))}
            >
              {preferences.theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
            <div className="sync-state">
              <span className="visually-hidden">
                {lastSync
                  ? `${preferences.language === "zh-TW" ? "已同步" : "Synced"} ${new Date(lastSync).toLocaleTimeString(preferences.language, { hour: "2-digit", minute: "2-digit" })}`
                  : devicePaired
                    ? (preferences.language === "zh-TW" ? "已配對，等待完成首次同步" : "Paired; first sync pending")
                    : (preferences.language === "zh-TW" ? "尚未配對桌面 App" : "Desktop app not paired")}
              </span>
              <button
                className="icon-button top-icon-action sync-icon-action"
                disabled={working || !engine}
                aria-label={devicePaired ? (writeApproved ? t("sync.full") : t("sync.first")) : t("sync.pairFirst")}
                title={devicePaired ? (writeApproved ? t("sync.full") : t("sync.first")) : t("sync.pairFirst")}
                onClick={requestManualSync}
              >
                <RefreshCw className={working ? "spin" : ""} aria-hidden="true" />
                {working
                  ? (preferences.language === "zh-TW" ? "處理中…" : "Working…")
                  : !devicePaired
                    ? t("sync.pairFirst")
                    : writeApproved
                      ? t("sync.full")
                      : t("sync.first")}
              </button>
            </div>
          </div>
        </header>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button onClick={() => setError("")}>×</button>
          </div>
        )}
        <div className="workspace">{content}</div>
      </main>
      <nav className="mobile-nav">
        {(Object.keys(VIEW_KEYS) as View[]).map((item) => (
          <button
            key={item}
            className={view === item ? "active" : ""}
            onClick={() => setView(item)}
            aria-label={t(VIEW_KEYS[item])}
          >
            <ViewIcon view={item} />
            {item === "sync" ? t("app.more") : t(VIEW_KEYS[item])}
          </button>
        ))}
      </nav>
      {quickAddOpen && (
        <QuickAddModal
          tasks={tasks}
          projects={projects}
          templates={templates}
          onClose={() => setQuickAddOpen(false)}
          onSave={(next) => {
            setQuickAddOpen(false);
            void persistLocal(next);
          }}
        />
      )}
      {searchOpen && (
        <WorkspaceSearch
          tasks={tasks}
          projects={projects}
          collections={collections}
          onClose={() => setSearchOpen(false)}
          onSelect={(result) => {
            setSearchOpen(false);
            if (result.kind === "project") {
              setSelectedProjectDetailId(result.id);
            } else if (result.kind === "collection") {
              setSelectedCollectionId(result.id);
              setView("collections");
            } else {
              setSelectedTaskId(result.id);
            }
          }}
          actions={[
            { label: preferences.language === "zh-TW" ? "快速新增任務" : "Quick add task", run: () => setQuickAddOpen(true) },
            { label: preferences.language === "zh-TW" ? "新增專案" : "New project", run: () => setCreateEntity("project") },
            { label: preferences.language === "zh-TW" ? "新增收藏" : "New collection", run: () => setCreateEntity("collection") },
            { label: preferences.language === "zh-TW" ? "建立知識架構" : "Build architecture", run: () => setArchitectureOpen(true) },
            { label: preferences.language === "zh-TW" ? "前往同步與設定" : "Go to sync & settings", run: () => setView("sync") },
          ]}
        />
      )}
      {selectedTask && (
        <TaskDetailDialog
          key={selectedTask.id ?? selectedTask.title}
          task={selectedTask}
          projects={projects}
          locale={preferences.language}
          t={t}
          onClose={() => setSelectedTaskId(null)}
          onSave={async (next) => {
            const prepared = { ...next, completedAt: next.status === "done" ? (next.completedAt ?? taipeiDateKey()) : null };
            const changed = tasks.map((task) => task.id === prepared.id ? prepared : task);
            return persistLocal(
              prepared.priority === "highest" && prepared.id
                ? markMostImportant(changed, prepared.id, prepared.taskDate ?? taipeiDateKey())
                : changed,
            );
          }}
          onDelete={(task) => void permanentlyDeleteTask(task)}
        />
      )}
      {selectedProjectDetail && (
        <ProjectDetailDialog
          key={selectedProjectDetail.id ?? selectedProjectDetail.name}
          project={selectedProjectDetail}
          openTasks={tasks.filter((task) => task.projectId === selectedProjectDetail.id && task.status !== "done").length}
          doingTasks={tasks.filter((task) => task.projectId === selectedProjectDetail.id && task.status === "doing").length}
          existingAreas={[...new Set(projects.map((project) => project.area).filter((area): area is string => Boolean(area)))].sort()}
          locale={preferences.language}
          t={t}
          onClose={() => setSelectedProjectDetailId(null)}
          onSave={(next) => persistLocal(tasks, projects.map((project) => {
            if (project.id === next.id) return next;
            return next.focusToday && project.focusToday ? { ...project, focusToday: false } : project;
          }))}
          onOpenBoard={() => {
            setSelectedBoardProjectId(selectedProjectDetail.id);
            setSelectedProjectDetailId(null);
            setView("board");
          }}
          onComplete={() => {
            const openCount = tasks.filter((task) => task.projectId === selectedProjectDetail.id && task.status !== "done").length;
            if (!window.confirm(`完成「${selectedProjectDetail.name}」？\n\n將同時完成 ${openCount} 項未完成任務，並保留完整歷史。`)) return;
            const completed = completeProject(selectedProjectDetail, tasks, taipeiDateKey());
            void persistLocal(completed.tasks, projects.map((project) => project.id === selectedProjectDetail.id ? completed.project : project));
          }}
          onReopen={() => void persistLocal(tasks, projects.map((project) => project.id === selectedProjectDetail.id ? { ...project, status: "active", completedAt: null, focusToday: false } : project))}
          onArchive={() => void persistLocal(tasks, projects.map((project) => project.id === selectedProjectDetail.id ? { ...project, status: "archived", focusToday: false } : project))}
          onDelete={() => void permanentlyDeleteProject(selectedProjectDetail)}
        />
      )}
      {createEntity && (
        <CreateEntityModal
          kind={createEntity}
          initialName={promotedTask?.title ?? ""}
          templates={templates}
          existingCategories={
            createEntity === "project"
              ? [...new Set(projects.map((p) => p.area).filter((a): a is string => Boolean(a)))].sort()
              : [...new Set(collections.map((c) => c.category).filter((c): c is string => Boolean(c)))].sort()
          }
          onClose={() => {
            setCreateEntity(null);
            setPromotedTask(null);
          }}
          onCreate={async (name, category, importance, body) => {
            const created = createEntity === "project"
              ? await createProject(name, category, importance, promotedTask ?? undefined, body)
              : await createCollection(name, category, importance, body);
            if (created) {
              setCreateEntity(null);
              setPromotedTask(null);
            }
          }}
        />
      )}
      {architectureOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setArchitectureOpen(false);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-label="建立知識架構">
            <div className="modal-header">
              <div>
                <span className="eyebrow">KNOWLEDGE ARCHITECTURE</span>
                <h2>建立知識架構</h2>
              </div>
              <button className="icon-button" onClick={() => setArchitectureOpen(false)} aria-label="關閉" title="關閉">
                <X aria-hidden="true" />
              </button>
            </div>
            <p>勾選你要的模板包，一起建立資料夾、AI 委任檔、範本與提示詞庫。已存在的檔案不會被覆寫。</p>
            <div className="architecture-pack-list">
              {TEMPLATE_PACKS.map((pack) => (
                <label key={pack.id} className="architecture-pack">
                  <input
                    type="checkbox"
                    checked={selectedPacks.includes(pack.id)}
                    onChange={(event) =>
                      setSelectedPacks((prev) =>
                        event.target.checked
                          ? [...prev, pack.id]
                          : prev.filter((id) => id !== pack.id),
                      )
                    }
                  />
                  <span>
                    <strong>{pack.label}</strong>
                    <small>{pack.description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setArchitectureOpen(false)}>取消</button>
              <button
                className="primary action-with-icon"
                disabled={working || selectedPacks.length === 0}
                onClick={() => void prepareArchitecture()}
              >
                <Plus aria-hidden="true" />建立架構
              </button>
            </div>
          </section>
        </div>
      )}
      {pendingScaffold && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="確認知識架構">
            <div className="modal-header"><div><span className="eyebrow">HUMAN REVIEW</span><h2>確認將建立的檔案</h2></div></div>
            <p>以下檔案會在審核後一次建立（含可驗證備份）。取消則不會寫入任何檔案。</p>
            <ul className="review-list">{scaffoldPreviewPaths.map((path) => (<li key={path}><code>{path}</code></li>))}</ul>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => { setPendingScaffold(null); setScaffoldPreviewPaths([]); }}>取消</button>
              <button className="primary" disabled={working} onClick={() => void confirmArchitecture()}>執行並建立</button>
            </div>
          </section>
        </div>
      )}
      {importPromptsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportPromptsOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-label="匯入提示詞">
            <div className="modal-header"><div><span className="eyebrow">PROMPT LIBRARY</span><h2>匯入提示詞</h2></div><button className="icon-button" onClick={() => setImportPromptsOpen(false)} aria-label="關閉" title="關閉"><X aria-hidden="true" /></button></div>
            <p>貼上「AI 提示詞 Plus」擴充匯出的 JSON（物件或純陣列）。每支提示詞會成為一筆「提示詞/…」分類的收藏。</p>
            <textarea className="prompt-json" rows={10} placeholder='{"version":"2.0.7","prompts":[{"name":"…","category":"…","content":"…"}]}' value={importText} onChange={(event) => setImportText(event.target.value)} />
            {importError && <p className="prompt-error" role="alert">{importError}</p>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setImportPromptsOpen(false)}>取消</button>
              <button className="primary" disabled={!importText.trim()} onClick={doImportPrompts}>匯入</button>
            </div>
          </section>
        </div>
      )}
      {exportPromptsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setExportPromptsOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-label="匯出提示詞">
            <div className="modal-header"><div><span className="eyebrow">PROMPT LIBRARY</span><h2>匯出提示詞</h2></div><button className="icon-button" onClick={() => setExportPromptsOpen(false)} aria-label="關閉" title="關閉"><X aria-hidden="true" /></button></div>
            <p>複製下方 JSON，在「AI 提示詞 Plus」擴充中匯入即可重複使用。</p>
            <textarea className="prompt-json" readOnly rows={12} value={exportText} />
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setExportPromptsOpen(false)}>關閉</button>
              <button className="primary" onClick={() => { void navigator.clipboard?.writeText(exportText); setExportCopied(true); }}>{exportCopied ? "已複製 ✓" : "複製"}</button>
            </div>
          </section>
        </div>
      )}
      {onboardingOpen && (
        <div className="modal-backdrop">
          <section className="modal onboarding-modal" role="dialog" aria-modal="true" aria-label={preferences.language === "zh-TW" ? "開始使用" : "Getting started"}>
            <div className="modal-header"><div><span className="eyebrow">SECOND BRAIN · LOCAL-FIRST</span><h2>{preferences.language === "zh-TW" ? "你的第二大腦，歡迎" : "Welcome to your second brain"}</h2></div></div>
            <p>{preferences.language === "zh-TW" ? "先「新建」選一套知識架構，讓 AI 一進資料夾就能讀懂你、快速開始專案與任務。" : "Start with “New” to build a knowledge architecture that any AI can read instantly."}</p>
            <div className="onboarding-cta">
              <button className="primary onboarding-primary" onClick={() => void startArchitectureOnboarding()}>
                <Plus aria-hidden="true" />{preferences.language === "zh-TW" ? "建立知識架構" : "New — build architecture"}
              </button>
              <span className="eyebrow">{preferences.language === "zh-TW" ? "可自由勾選：專案、知識庫、提示詞、AI 委任、模板" : "Pick & choose packs: projects, library, prompts, AI handoff, templates"}</span>
            </div>
            <hr className="modal-divider" />
            <button className="text-button" onClick={() => { localStorage.setItem("second-brain.onboardingCompleted", "true"); setOnboardingOpen(false); }}>
              {preferences.language === "zh-TW" ? "先記下來，稍後再建立架構" : "Capture first, build architecture later"}
            </button>
          </section>
        </div>
      )}
      {closeGuardOpen && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label={preferences.language === "zh-TW" ? "保存草稿" : "Save drafts"}>
            <h2>{preferences.language === "zh-TW" ? "關閉前保存 Markdown" : "Save Markdown before closing"}</h2>
            <p>{preferences.language === "zh-TW" ? "你建立的內容目前是這台裝置上的暫存草稿。建議現在選擇資料夾，轉成可攜、可備份的 Markdown 檔案。" : "Your content is currently a local draft. Choose a folder now to create portable Markdown files."}</p>
            <div className="modal-actions"><button className="secondary-button" onClick={() => setCloseGuardOpen(false)}>{t("app.cancel")}</button><button className="secondary-button" onClick={() => void leaveWithLocalDraft()}>{preferences.language === "zh-TW" ? "保留草稿並離開" : "Keep draft and leave"}</button><button className="primary" onClick={() => void (async () => { if (await browseVault()) await leaveWithLocalDraft(); })()}>{preferences.language === "zh-TW" ? "選擇資料夾、保存並關閉" : "Choose folder, save, and close"}</button></div>
          </section>
        </div>
      )}
      {conflict && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true">
            <h2>需要解決同步衝突</h2>
            <p>兩邊修改了相同欄位；在選完以前不會覆蓋任何一邊。</p>
            {conflict.plan.conflicts.map((item) => (
              <div className="conflict" key={`${item.entity}:${item.id}`}>
                <strong>
                  {item.entity === "task" ? "任務" : "專案"} ·{" "}
                  {item.id.slice(0, 8)}
                </strong>
                {item.fields.map((field) => (
                  <div className="conflict-row" key={field}>
                    <span>{field}</span>
                    <button
                      className={
                        choices[`${item.entity}:${item.id}:${field}`] ===
                        "local"
                          ? "chosen"
                          : ""
                      }
                      onClick={() =>
                        setChoices((value) => ({
                          ...value,
                          [`${item.entity}:${item.id}:${field}`]: "local",
                        }))
                      }
                    >
                      保留本機
                    </button>
                    <button
                      className={
                        choices[`${item.entity}:${item.id}:${field}`] ===
                        "server"
                          ? "chosen"
                          : ""
                      }
                      onClick={() =>
                        setChoices((value) => ({
                          ...value,
                          [`${item.entity}:${item.id}:${field}`]: "server",
                        }))
                      }
                    >
                      採用雲端
                    </button>
                  </div>
                ))}
              </div>
            ))}
            <button
              className="primary wide"
              disabled={working}
              onClick={() => void resolveConflicts()}
            >
              套用選擇並同步
            </button>
          </section>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true">
            <h2>第一次寫入前確認</h2>
            <div className="first-sync-warning">
              <strong>這一步尚未把資料送到網頁</strong>
              <span>確認下方結果後，按下同步按鈕才會建立備份、加入隱藏識別碼並提交雲端。</span>
            </div>
            <p>
              Shadow 預覽找到 {preview.taskCount} 項任務、{preview.projectCount}{" "}
              個專案、{preview.conflictCount} 個衝突，並有{" "}
              {preview.bootstrapFileCount}{" "}
              個檔案需要加入隱藏識別碼。確認後每次實際寫檔都會先建立並驗證備份
              ZIP。
            </p>
            <div className="form-row">
              <button
                className="secondary-button"
                onClick={() => {
                  setPreview(null);
                  setPreviewDismissed(true);
                }}
              >
                繼續 Shadow 模式
              </button>
              <button
                className="primary"
                disabled={working || preview.conflictCount > 0}
                onClick={() => void approveFirstWrite()}
              >
                確認備份並同步到網頁
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
    </UiPreferencesContext.Provider>
  );

  function setCompletedVisibility(value: boolean) {
    setShowCompleted(value);
    localStorage.setItem("second-brain.showCompletedTasks", String(value));
  }
}

function TaskEditor({
  task,
  projects,
  onSave,
}: {
  task: BrainTaskSnapshot;
  projects: BrainProjectSnapshot[];
  onSave: (task: BrainTaskSnapshot) => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [value, setValue] = useState(task);
  const chooseProject = (id: string) => {
    const project = projects.find((item) => item.id === id);
    setValue({
      ...value,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
    });
  };
  return (
    <div className="task-editor">
      <input
        aria-label={t("task.field.title")}
        value={value.title}
        onChange={(event) => setValue({ ...value, title: event.target.value })}
      />
      <MarkdownEditor value={value.body ?? ""} onChange={(body) => setValue({ ...value, body })} locale={preferences.language} />
      <div className="form-row">
        <select
          aria-label={t("task.field.status")}
          value={value.status}
          onChange={(event) =>
            setValue({
              ...value,
              status: event.target.value as TaskStatus,
              completedAt:
                event.target.value === "done" ? taipeiDateKey() : null,
            })
          }
        >
          {Object.entries(STATUS_KEYS).map(([key, labelKey]) => (
            <option key={key} value={key}>
              {t(labelKey)}
            </option>
          ))}
        </select>
        <input
          aria-label={t("task.field.date")}
          type="date"
          value={value.taskDate ?? ""}
          onChange={(event) =>
            setValue({ ...value, taskDate: event.target.value || null })
          }
        />
        <input
          aria-label={t("task.field.startTime")}
          type="time"
          value={value.startTime ?? ""}
          onChange={(event) => setValue({
            ...value,
            startTime: event.target.value || null,
            durationMinutes: event.target.value ? (value.durationMinutes ?? 30) : null,
            timeZone: "Asia/Taipei",
          })}
        />
        <select
          aria-label={t("task.field.duration")}
          disabled={!value.startTime}
          value={value.durationMinutes ?? 30}
          onChange={(event) => setValue({ ...value, durationMinutes: Number(event.target.value) })}
        >
          {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分鐘</option>)}
        </select>
        <select
          aria-label={t("task.field.priority")}
          value={value.priority}
          onChange={(event) =>
            setValue({
              ...value,
              priority: event.target.value as BrainTaskSnapshot["priority"],
            })
          }
        >
          <option value="highest">P1 · 最重要</option>
          <option value="high">P2 · 高</option>
          <option value="medium">P3 · 中</option>
          <option value="normal">P4 · 一般</option>
          <option value="low">P5 · 低</option>
        </select>
        <select
          aria-label={t("task.field.project")}
          value={value.projectId ?? ""}
          onChange={(event) => chooseProject(event.target.value)}
        >
          <option value="">{t("app.unassigned")}</option>
          {projects.map((project) => (
            <option key={project.id ?? project.name} value={project.id ?? ""}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          className="primary action-with-icon"
          disabled={!value.title.trim()}
          onClick={() => onSave({ ...value, title: value.title.trim() })}
        >
          <Save aria-hidden="true" />{t("app.save")}
        </button>
      </div>
    </div>
  );
}

function CompletedVisibilityButton({
  showCompleted,
  onChange,
}: {
  showCompleted: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useUiPreferences();
  return (
    <button
      type="button"
      className={`icon-action ${showCompleted ? "active" : ""}`}
      aria-pressed={showCompleted}
      aria-label={t(showCompleted ? "app.hideCompleted" : "app.showCompleted")}
      title={t(showCompleted ? "app.hideCompleted" : "app.showCompleted")}
      onClick={() => onChange(!showCompleted)}
    >
      <Eye aria-hidden="true" />
    </button>
  );
}

function TaskActionBar({
  task,
  important,
  onImportant,
  onComplete,
  onEdit,
  onDelete,
  showEdit = true,
}: {
  task: BrainTaskSnapshot;
  important: boolean;
  onImportant: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  showEdit?: boolean;
}) {
  const { t } = useUiPreferences();
  const done = task.status === "done";
  return (
    <div className="task-action-bar" aria-label={`${task.title} actions`}>
      <button className={`task-action-button ${important ? "active" : ""}`} aria-label={t("task.action.important")} title={t("task.action.important")} onClick={onImportant}>
        <Star aria-hidden="true" fill={important ? "currentColor" : "none"} />
      </button>
      <button className="task-action-button completion-action" aria-label={done ? t("task.action.reopen") : t("task.action.complete")} title={done ? t("task.action.reopen") : t("task.action.complete")} onClick={onComplete}>
        {done ? <RotateCcw aria-hidden="true" /> : <span className="action-checkmark" aria-hidden="true">✓</span>}
      </button>
      {showEdit && <button className="task-action-button" aria-label={t("task.action.edit")} title={t("task.action.edit")} onClick={onEdit}>
        <Pencil aria-hidden="true" />
      </button>}
      <button className="task-action-button danger" aria-label={t("task.action.delete")} title={t("task.action.delete")} onClick={() => onDelete(task)}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

export function Today({ tasks, projects, showCompleted, onShowCompletedChange, onSave, onDelete, onOpenTask, onQuickAdd, routineTemplate, onRoutineTemplateChange }: {
  tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void; onDelete: (task: BrainTaskSnapshot) => void; onOpenTask: (taskId: string) => void; onQuickAdd: () => void;
  routineTemplate: RoutineTemplate; onRoutineTemplateChange: (template: RoutineTemplate) => void;
}) {
  const { t, preferences } = useUiPreferences();
  const today = taipeiDateKey();
  const groups = splitTodayTasks(tasks, projects, today);
  const completed = completedForDate(tasks, today);
  const scheduled = [
    ...groups.today.filter((task) => task.startTime),
    ...(showCompleted ? completed.filter((task) => task.startTime) : []),
  ].sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const trayTasks = [
    ...groups.overdue,
    ...groups.today.filter((task) => !task.startTime),
  ];
  const [templateOpen, setTemplateOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const [dragHandleId, setDragHandleId] = useState<string | null>(null);
  const clock = useMemo(() => new Date(), [today]);
  const patchTask = (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => {
    const changed = tasks.map((item) => item.id === task.id ? { ...item, ...patch } : item);
    onSave(patch.priority === "highest" && task.id ? markMostImportant(changed, task.id, today) : changed);
  };
  const complete = (task: BrainTaskSnapshot) => patchTask(task, { status: task.status === "done" ? "todo" : "done", completedAt: task.status === "done" ? null : today });
  const startToday = () => {
    const result = applyRoutineTemplate(routineTemplate, tasks, today);
    if (result.created.length) onSave(result.tasks);
    setNotice(result.created.length ? `已建立 ${result.created.length} 項今日例行任務` : "今天的例行任務都已建立");
  };
  // Setting a row to P1 demotes whichever row already held it, mirroring markMostImportant: a day owns one P1.
  const updateItem = (id: string, patch: Partial<RoutineTemplateItem>) => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.map((item) => item.id === id ? { ...item, ...patch } : patch.priority === "highest" && item.priority === "highest" ? { ...item, priority: "high" as const } : item) });
  const dropItem = (targetId: string) => {
    if (!draggedItem || draggedItem === targetId) return;
    const items = [...routineTemplate.items];
    const from = items.findIndex((item) => item.id === draggedItem);
    const to = items.findIndex((item) => item.id === targetId);
    const [moved] = items.splice(from, 1);
    if (!moved) return;
    items.splice(to, 0, moved);
    onRoutineTemplateChange({ ...routineTemplate, items: items.map((item, index) => ({ ...item, rank: rankForIndex(index) })) });
    setDraggedItem(null);
  };
  const important = groups.today.find((task) => task.priority === "highest") ?? null;
  return <section className="command-center">
    <header className="command-hero"><div><span className="eyebrow">COMMAND CENTER · {today}</span><h2>{t("today.heading")}</h2><p>{t("today.description")}</p></div><div className="hero-actions"><CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} /><button className="secondary-button" onClick={() => setTemplateOpen((open) => !open)} aria-expanded={templateOpen}><Settings2 />{t(templateOpen ? "today.template.collapse" : "today.template.manage")}</button><button className="primary start-day-button" onClick={startToday}><Plus />{t("today.start")}</button></div></header>
    {notice && <div className="routine-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="關閉提示"><X /></button></div>}
    <div className="command-summary"><article className="focus-summary"><span>今日最重要</span><strong>{important?.title ?? "尚未選定"}</strong><small>{important?.projectName ?? "在今日任務按下星號選定"}</small></article><article><span>逾期</span><strong>{groups.overdue.length}</strong><small>需要重新決定日期</small></article><article><span>今天</span><strong>{groups.today.length}</strong><small>{scheduled.length} 項已排時間</small></article></div>
    {templateOpen && <section className="routine-editor"><header><div><span className="eyebrow">DAILY ROUTINE</span><input aria-label="模板名稱" value={routineTemplate.name} onChange={(event) => onRoutineTemplateChange({ ...routineTemplate, name: event.target.value })} /></div><button onClick={() => setTemplateOpen(false)} aria-label="關閉模板"><X /></button></header><div className="routine-items">{routineTemplate.items.map((item) => <article key={item.id} draggable={dragHandleId === item.id} onDragStart={() => setDraggedItem(item.id)} onDragEnd={() => setDragHandleId(null)} onMouseUp={() => setDragHandleId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropItem(item.id)}><GripVertical onMouseDown={() => setDragHandleId(item.id)} /><input type="checkbox" aria-label={`${item.title}啟用`} checked={item.enabled} onChange={(event) => updateItem(item.id, { enabled: event.target.checked })} /><input aria-label="例行任務名稱" value={item.title} onChange={(event) => updateItem(item.id, { title: event.target.value })} /><select aria-label="例行任務專案" value={item.projectId ?? ""} onChange={(event) => { const project = projects.find((value) => value.id === event.target.value); updateItem(item.id, { projectId: project?.id ?? null, projectName: project?.name ?? null }); }}><option value="">無專案</option>{projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}</select><select aria-label="例行任務優先度" value={item.priority} onChange={(event) => updateItem(item.id, { priority: event.target.value as RoutineTemplateItem["priority"] })}>{(["highest","high","medium","normal","low"] as const).map((value) => <option key={value} value={value}>{priorityDisplay(value).code}</option>)}</select><input aria-label="開始時間" type="time" value={item.startTime ?? ""} onChange={(event) => updateItem(item.id, { startTime: event.target.value || null, durationMinutes: event.target.value ? item.durationMinutes ?? 30 : null })} /><select aria-label="持續時間" disabled={!item.startTime} value={item.durationMinutes ?? 30} onChange={(event) => updateItem(item.id, { durationMinutes: Number(event.target.value) })}>{[15,30,45,60,90,120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分</option>)}</select><button className="danger-icon" aria-label={`刪除${item.title}`} onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.filter((value) => value.id !== item.id) })}><Trash2 /></button></article>)}</div><button className="secondary" onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: [...routineTemplate.items, { id: crypto.randomUUID(), title: "新的例行任務", enabled: true, projectId: null, projectName: null, priority: "normal", startTime: null, durationMinutes: null, rank: rankForIndex(routineTemplate.items.length) }] })}><Plus />新增模板項目</button></section>}
    <section className="timeline-section">
      <header>
        <div>
          <span className="eyebrow">TODAY TIMELINE</span>
          <h3>{t("today.timeline")}</h3>
        </div>
        <button className="secondary icon-action" aria-label={t("app.quickAdd")} title={t("app.quickAdd")} onClick={onQuickAdd}><Plus /></button>
      </header>
      <DaySchedule
        date={today}
        timedTasks={scheduled}
        trayTasks={trayTasks}
        showTray
        now={clock}
        labels={{
          unscheduled: t("today.unscheduled"),
          dropToSchedule: t("today.dropToSchedule"),
          addAtTime: (time) => t("today.addAtTime", { time }),
          empty: t("today.empty"),
          editTitle: t("task.hint.editTitle"),
          editPriority: t("task.hint.editPriority"),
          complete: t("task.action.complete"),
          reopen: t("task.action.reopen"),
          delete: t("task.action.delete"),
          resize: t("today.resizeDuration"),
        }}
        locale={preferences.language}
        onSchedule={(taskId, startTime) => onSave(tasks.map((item) => item.id === taskId ? scheduleTask(item, today, startTime) : item))}
        onClearTime={(taskId) => onSave(tasks.map((item) => item.id === taskId ? scheduleTask(item, item.taskDate ?? today, null) : item))}
        onCreateAt={(title, startTime) => onSave([...tasks, newTask(title, { taskDate: today, startTime, durationMinutes: 30 })])}
        onOpenTask={onOpenTask}
        onPriority={(taskId, priority) => onSave(applyTaskPriority(tasks, taskId, priority, today))}
        onDelete={onDelete}
        onComplete={(task) => complete(task)}
        onResize={(taskId, durationMinutes) => onSave(tasks.map((item) => item.id === taskId ? { ...item, durationMinutes } : item))}
      />
    </section>
    {showCompleted && completed.length > 0 && <details className="completed-section"><summary>今日已完成 · {completed.length} 項</summary><div className="focus-task-list">{completed.map((task) => <InlineTaskCard key={task.id ?? task.title} task={task} today={today} onOpen={onOpenTask} onPatch={patchTask} onComplete={complete} onDelete={onDelete} />)}</div></details>}
  </section>;
}

function InlineTaskCard({ task, today, onOpen, onPatch, onComplete, onDelete }: { task: BrainTaskSnapshot; today: string; onOpen: (taskId: string) => void; onPatch: (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => void; onComplete: (task: BrainTaskSnapshot) => void; onDelete: (task: BrainTaskSnapshot) => void }) {
  const { t, preferences } = useUiPreferences();
  const overdueDays = task.taskDate && task.taskDate < today ? Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.taskDate}T00:00:00Z`)) / 86400000)) : 0;
  return <article className={`inline-task-card ${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`} tabIndex={0} onClick={() => task.id && onOpen(task.id)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && task.id) { event.preventDefault(); onOpen(task.id); } }}><button className={`clear-check ${task.status === "done" ? "done" : ""}`} aria-label={task.status === "done" ? `${task.title}重新開啟` : `${task.title}標記完成`} title={task.status === "done" ? "重新開啟" : "完成"} onClick={(event) => { event.stopPropagation(); onComplete(task); }}>{task.status === "done" ? "✓" : ""}</button><div className="inline-task-main"><div className="inline-title-row"><PriorityControl priority={task.priority} compact locale={preferences.language} onChange={(priority) => onPatch(task, priority === "highest" ? { priority, taskDate: today } : { priority })} /><strong>{task.title}</strong></div><small>{task.projectName ?? t("app.unassigned")}{task.startTime ? ` · ${task.startTime}` : ""}</small>{overdueDays > 0 && <small className="overdue-label">逾期 {overdueDays} 天 · 原日期 {task.taskDate}</small>}</div><div className="inline-task-actions">{overdueDays > 0 && <button aria-label="移到今天" title="移到今天" onClick={(event) => { event.stopPropagation(); onPatch(task, { taskDate: today }); }}><CalendarDays /></button>}<button className="danger-icon" aria-label="永久刪除" title="永久刪除" onClick={(event) => { event.stopPropagation(); onDelete(task); }}><Trash2 /></button></div></article>;
}

function TaskDateInput({
  value,
  ariaLabel,
  className,
  onCommit,
}: {
  value: string | null;
  ariaLabel: string;
  className?: string;
  onCommit: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(value ?? "");
    setInvalid(false);
  }, [value]);
  const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setInvalid(false);
      if ((value ?? null) !== null) onCommit(null);
      return;
    }
    if (!DATE_RE.test(trimmed)) {
      setInvalid(true);
      return;
    }
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    const normalized = parsed.toISOString().slice(0, 10);
    if (normalized !== trimmed || Number.isNaN(parsed.getTime())) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (normalized !== (value ?? null)) onCommit(normalized);
  };
  return (
    <input
      className={className}
      aria-label={ariaLabel}
      type="text"
      inputMode="numeric"
      placeholder="YYYY-MM-DD"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (invalid) setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          setDraft(value ?? "");
          setInvalid(false);
        }
      }}
      style={invalid ? { outline: "2px solid #e5484d" } : undefined}
    />
  );
}

function AgendaInlineTitle({ task, onSave }: { task: BrainTaskSnapshot; onSave: (title: string) => void }) {
  const { t } = useUiPreferences();
  return (
    <InlineTitle
      value={task.title}
      onSave={onSave}
      prefix={task.status === "done" ? "✓ " : ""}
      className="agenda-inline-title"
      inputClassName="agenda-inline-title-input"
      ariaLabel={t("task.field.title")}
      hint={t("task.hint.editTitle")}
    />
  );
}

function LegacyToday({
  tasks,
  projects,
  showCompleted,
  onSave,
  onDelete,
  onQuickAdd,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  onQuickAdd: () => void;
}) {
  const today = taipeiDateKey();
  const visible = getTodayTasks(tasks, projects, today);
  const completed = completedForDate(tasks, today);
  const nextPriorities = nextWeekPriorities(tasks, today);
  const focusProject = projects.find((project) => project.focusToday);
  const openCount = tasks.filter((task) => task.status !== "done").length;
  const todayPriority =
    visible.find((task) => task.priority === "highest") ?? visible[0] ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const toggleDone = (task: BrainTaskSnapshot) =>
    onSave(
      tasks.map((item) =>
        item.id === task.id
          ? {
              ...item,
              status: item.status === "done" ? "todo" : "done",
              completedAt: item.status === "done" ? null : today,
            }
          : item,
      ),
    );
  return (
    <section>
      <div className="hero-card">
        <div>
          <span className="eyebrow">{today}</span>
          <h2>今天，只推進最重要的事</h2>
          <p>
            紅色任務是今日唯一最重要任務。點選任務後按 Space 或 Enter
            可快速完成。
          </p>
        </div>
        <div className="metric">
          <strong>{visible.length}</strong>
          <span>今日任務</span>
        </div>
      </div>
      <div className="planning-overview">
        <article className="overview-card primary-focus">
          <span>今天最優先</span>
          <strong>{todayPriority?.title ?? "尚未選定"}</strong>
          <small>
            {todayPriority
              ? `${priorityDisplay(todayPriority.priority).code} · ${todayPriority.projectName ?? "無專案"}`
              : "從今日任務選一件最重要的事"}
          </small>
        </article>
        <article className="overview-card">
          <span>未來 7 天重點</span>
          <strong>{nextPriorities.length} 項</strong>
          <small>
            {nextPriorities
              .slice(0, 2)
              .map((task) => task.title)
              .join("、") || "目前沒有 P1／P2 重點"}
          </small>
        </article>
        <article className="overview-card">
          <span>焦點專案進度</span>
          <strong>
            {focusProject ? `${focusProject.progress ?? 0}%` : "未設定"}
          </strong>
          <small>{focusProject?.name ?? "到專案頁設定今日焦點"}</small>
        </article>
        <article className="overview-card">
          <span>全部未完成</span>
          <strong>{openCount} 項</strong>
          <small>
            {tasks.filter((task) => boardLane(task) === "idea").length}{" "}
            項仍在想法匣
          </small>
        </article>
      </div>
      <button className="add-task-panel" onClick={onQuickAdd}>
        <span><Plus aria-hidden="true" /></span>
        <div>
          <strong>新增一個任務</strong>
          <small>快速輸入想法、選擇專案與日期</small>
        </div>
        <kbd>N</kbd>
      </button>
      <div className="task-list">
        {visible.length === 0 ? (
          <Empty text="今天沒有需要處理的任務。按 N 快速新增。" />
        ) : (
          visible.map((task) => {
            const important =
              task.priority === "highest" && task.taskDate === today;
            return (
              <article
                className={`task-card ${important ? "most-important" : ""}`}
                key={task.id ?? task.title}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (
                    isCompleteShortcut({
                      key: event.key,
                      editable: isEditableElement(event.target),
                    })
                  ) {
                    event.preventDefault();
                    toggleDone(task);
                  }
                }}
              >
                <button
                  className={`check ${task.status === "done" ? "done" : ""}`}
                  aria-label={`${task.title}標記完成`}
                  onClick={() => toggleDone(task)}
                >
                  {task.status === "done" ? "✓" : ""}
                </button>
                <div className="task-body">
                  <div className="task-title-row">
                    <PriorityBadge priority={task.priority} />
                    <strong>{task.title}</strong>
                    {important && (
                      <span className="important-badge">今日最重要</span>
                    )}
                  </div>
                  <small>
                    {task.projectName ?? "無專案"} ·{" "}
                    {task.taskDate ? `⏳ ${task.taskDate}` : "想法匣"}
                  </small>
                  {editing === task.id && (
                    <TaskEditor
                      task={task}
                      projects={projects}
                      onSave={(next) => {
                        setEditing(null);
                        const changed = tasks.map((item) =>
                          item.id === task.id ? next : item,
                        );
                        void onSave(
                          next.priority === "highest" && next.id
                            ? markMostImportant(
                                changed,
                                next.id,
                                next.taskDate ?? today,
                              )
                            : changed,
                        );
                      }}
                    />
                  )}
                </div>
                <TaskActionBar
                  task={task}
                  important={important}
                  onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, today))}
                  onComplete={() => toggleDone(task)}
                  onEdit={() => setEditing(editing === task.id ? null : task.id)}
                  onDelete={onDelete}
                />
              </article>
            );
          })
        )}
      </div>
      {showCompleted && completed.length > 0 && (
        <section className="completed-section">
          <header>
            <h3>今日已完成</h3>
            <span>{completed.length} 項</span>
          </header>
          <div className="task-list">
            {completed.map((task) => (
              <article
                className="task-card completed-task"
                key={task.id ?? task.title}
              >
                <button
                  className="check done"
                  aria-label={`${task.title}重新開啟`}
                  onClick={() => toggleDone(task)}
                >
                  ✓
                </button>
                <div className="task-body">
                  <div className="task-title-row">
                    <PriorityBadge priority={task.priority} />
                    <strong>{task.title}</strong>
                  </div>
                  <small>
                    {task.projectName ?? "無專案"} · 完成於 {task.completedAt}
                  </small>
                </div>
                <TaskActionBar
                  task={task}
                  important={task.priority === "highest"}
                  onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, task.taskDate ?? today))}
                  onComplete={() => toggleDone(task)}
                  onEdit={() => setEditing(editing === task.id ? null : task.id)}
                  onDelete={onDelete}
                />
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function QuickAddModal({
  tasks,
  projects,
  templates = [],
  onClose,
  onSave,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  templates?: { name: string; body: string }[];
  onClose: () => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState("");
  const [ideaInbox, setIdeaInbox] = useState(true);
  const [taskDate, setTaskDate] = useState(taipeiDateKey());
  const [startTime, setStartTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [important, setImportant] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  const submit = () => {
    if (!title.trim()) return;
    const project = projects.find((item) => item.id === projectId);
    const task = newTask(title, {
      taskDate: ideaInbox ? null : taskDate || null,
      startTime: ideaInbox ? null : startTime || null,
      durationMinutes: startTime ? durationMinutes : null,
      project,
    });
    task.body = body;
    const next = [
      ...tasks,
      important ? { ...task, priority: "highest" as const } : task,
    ];
    onSave(
      important && task.id
        ? markMostImportant(next, task.id, taskDate || taipeiDateKey())
        : next,
    );
  };
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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
          {t("quick.content")}
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
        {templates.length > 0 && (
          <label>{preferences.language === "zh-TW" ? "套用模板" : "Apply template"}<select value="" onChange={(event) => { const picked = templates.find((item) => item.name === event.target.value); if (picked) { setBody(picked.body); if (!title.trim()) setTitle(picked.name); } }}><option value="">{preferences.language === "zh-TW" ? "不使用模板" : "No template"}</option>{templates.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        )}
        <MarkdownEditor value={body} onChange={setBody} locale={preferences.language} minRows={7} />
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
          <label>
            {t("task.field.project")}
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">{t("app.unassigned")}</option>
              {projects.map((project) => (
                <option
                  key={project.id ?? project.name}
                  value={project.id ?? ""}
                >
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("task.field.date")}
            <input
              type="date"
              disabled={ideaInbox}
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
            <select disabled={ideaInbox || !startTime} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}>
              {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分鐘</option>)}
            </select>
          </label>
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

function newTask(
  title: string,
  options: {
    taskDate?: string | null;
    startTime?: string | null;
    durationMinutes?: number | null;
    project?: BrainProjectSnapshot;
  } = {},
): BrainTaskSnapshot {
  return {
    schemaVersion: 5,
    id: crypto.randomUUID(),
    title: title.trim(),
    status: "todo",
    taskDate:
      options.taskDate === undefined ? taipeiDateKey() : options.taskDate,
    priority: "normal",
    projectId: options.project?.id ?? null,
    projectName: options.project?.name ?? null,
    rank: rankForIndex(Date.now() % 100000),
    sourcePath: null,
    sourceHeading: null,
    completedAt: null,
    startTime: options.startTime ?? null,
    durationMinutes: options.startTime ? (options.durationMinutes ?? 30) : null,
    timeZone: "Asia/Taipei",
  };
}

function Board({
  tasks,
  projects,
  showCompleted,
  onShowCompletedChange,
  onSave,
  onDelete,
  onOpenTask,
  selectedProjectId,
  onProjectFilterChange,
  onBackToProjects,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  selectedProjectId: string | null;
  onProjectFilterChange: (projectId: string | null) => void;
  onBackToProjects: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [drag, setDrag] = useState<string | null>(null);
  const boardDrag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const today = taipeiDateKey();
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const lanes: Array<{ id: BoardLane; label: string; hint: string }> = [
    { id: "idea", label: t("task.status.idea"), hint: t("task.status.ideaHelp") },
    { id: "todo", label: t("task.status.todo"), hint: t("task.status.todoHelp") },
    { id: "doing", label: t("task.status.doing"), hint: t("task.status.doingHelp") },
    { id: "waiting", label: t("task.status.waiting"), hint: t("task.status.waitingHelp") },
    { id: "done", label: t("task.status.done"), hint: t("task.status.doneHelp") },
  ];
  const filtered = tasks.filter(
    (task) => !selectedProjectId || task.projectId === selectedProjectId,
  );
  const moveToLane = (id: string | null, lane: BoardLane) => {
    if (id)
      void onSave(
        tasks.map((task) =>
          task.id === id ? moveTaskToLane(task, lane, today) : task,
        ),
      );
  };
  const finishBoardPointer = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const origin = boardDrag.current;
    boardDrag.current = null;
    setDrag(null);
    if (!origin?.moved) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const lane = target?.closest<HTMLElement>("[data-board-lane]")?.dataset.boardLane as BoardLane | undefined;
    if (lane) moveToLane(taskId, lane);
  };
  const moveWithinColumn = (id: string | null, delta: -1 | 1) => {
    if (!id) return;
    const active = tasks.find((task) => task.id === id);
    if (!active) return;
    const ordered = tasks
      .filter((task) => boardLane(task) === boardLane(active))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    const from = ordered.findIndex((task) => task.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    const ranks = new Map(
      ordered.map((task, index) => [task.id, rankForIndex(index)]),
    );
    void onSave(
      tasks.map((task) =>
        ranks.has(task.id) ? { ...task, rank: ranks.get(task.id)! } : task,
      ),
    );
  };
  return (
    <section>
      <div className="board-toolbar">
        <div>
          <h2>{selectedProject ? t("board.filteredTitle", { name: selectedProject.name }) : t("board.title")}</h2>
          <p>{selectedProject ? t("board.filteredDescription") : t("board.description")}</p>
        </div>
        <div>
          {selectedProject && <button className="secondary-button" onClick={onBackToProjects}>{t("board.back")}</button>}
          <select
            aria-label={t("board.projectFilter")}
            value={selectedProjectId ?? "all"}
            onChange={(event) => onProjectFilterChange(event.target.value === "all" ? null : event.target.value)}
          >
            <option value="all">{t("board.allProjects")}</option>
            {projects.filter((project) => project.id).sort((a, b) => a.name.localeCompare(b.name)).map((project) => (
              <option key={project.id!} value={project.id!}>
                {project.name}
              </option>
            ))}
          </select>
          <CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} />
        </div>
      </div>
      <div className="board five-lanes">
        {lanes
          .filter((lane) => lane.id !== "done" || showCompleted)
          .map((lane) => {
            const laneTasks = filtered
              .filter((task) => boardLane(task) === lane.id)
              .sort((a, b) => a.rank.localeCompare(b.rank));
            return (
              <section
                className={`board-column lane-${lane.id} ${drag ? "drag-active" : ""}`}
                key={lane.id}
                data-board-lane={lane.id}
              >
                <header>
                  <span className={`dot ${lane.id}`} />
                  <div>
                    <strong>{lane.label}</strong>
                    <em>{lane.hint}</em>
                  </div>
                  <small>{laneTasks.length}</small>
                </header>
                {laneTasks.length === 0 && (
                  <div className="lane-empty">{t("board.dropHere")}</div>
                )}
                {laneTasks.map((task) => (
                  <article
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !task.id || !(event.target as HTMLElement).closest("[data-drag-handle]")) return;
                      boardDrag.current = { id: task.id, x: event.clientX, y: event.clientY, moved: false };
                      setDrag(task.id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (!boardDrag.current) return;
                      if (Math.abs(event.clientX - boardDrag.current.x) > 4 || Math.abs(event.clientY - boardDrag.current.y) > 4) {
                        boardDrag.current = { ...boardDrag.current, moved: true };
                      }
                    }}
                    onPointerUp={(event) => finishBoardPointer(event, task.id)}
                    onPointerCancel={() => { boardDrag.current = null; setDrag(null); }}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button,input,select,textarea,a") && task.id) onOpenTask(task.id);
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && !event.altKey && task.id) {
                        event.preventDefault();
                        onOpenTask(task.id);
                        return;
                      }
                      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
                      event.preventDefault();
                      const index = lanes.findIndex((item) => item.id === boardLane(task));
                      const next = lanes[index + (event.key === "ArrowRight" ? 1 : -1)];
                      if (next) moveToLane(task.id, next.id);
                    }}
                    style={taskProjectStyle(task)}
                    className={`board-card ${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                    key={task.id ?? task.title}
                    tabIndex={0}
                  >
                    <div className="task-title-row">
                      <button type="button" className="board-drag-handle" data-drag-handle aria-label={`拖曳 ${task.title}`} onClick={(event) => event.stopPropagation()}>
                        <GripVertical aria-hidden="true" />
                      </button>
                      <PriorityControl
                        priority={task.priority}
                        compact
                        locale={preferences.language}
                        onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, task.taskDate ?? today))}
                      />
                      <strong className="board-inline-title">{task.status === "done" ? "✓ " : ""}{task.title}</strong>
                    </div>
                    <small>{task.projectName ?? t("app.unassigned")}</small>
                    <label className="board-date-field" onPointerDown={(event) => event.stopPropagation()}>
                      <CalendarDays aria-hidden="true" />
                      <TaskDateInput
                        className="board-date-input"
                        ariaLabel={`修改 ${task.title} 日期`}
                        value={task.taskDate ?? null}
                        onCommit={(next) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, taskDate: next } : item))}
                      />
                    </label>
                    <div className="board-actions">
                      <select
                        aria-label={`移動 ${task.title} 到其他狀態`}
                        value={boardLane(task)}
                        onChange={(event) =>
                          moveToLane(task.id, event.target.value as BoardLane)
                        }
                      >
                        {lanes.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <button
                        aria-label={t("board.moveUp")}
                        title={t("board.moveUp")}
                        onClick={() => moveWithinColumn(task.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={t("board.moveDown")}
                        title={t("board.moveDown")}
                        onClick={() => moveWithinColumn(task.id, 1)}
                      >
                        ↓
                      </button>
                      <TaskActionBar
                        task={task}
                        important={task.priority === "highest"}
                        onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, task.taskDate ?? today))}
                        onComplete={() => moveToLane(task.id, task.status === "done" ? "todo" : "done")}
                        onEdit={() => task.id && onOpenTask(task.id)}
                        onDelete={onDelete}
                      />
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
      </div>
    </section>
  );
}

export function Calendar({
  tasks,
  projects,
  showCompleted,
  onShowCompletedChange,
  onSave,
  onDelete,
  onOpenTask,
  onPromote,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
  onOpenTask: (taskId: string) => void;
  onPromote: (task: BrainTaskSnapshot) => void;
}) {
  const { preferences, t } = useUiPreferences();
  const today = taipeiDateKey();
  const [mode, setMode] = useState<"month" | "week" | "schedule">("month");
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [sideOpen, setSideOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOriginDate, setDragOriginDate] = useState<string | null>(null);
  const [dropTargetDate, setDropTargetDate] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [ideasExpanded, setIdeasExpanded] = useState(false);
  const [ideaContextMenu, setIdeaContextMenu] = useState<{
    task: BrainTaskSnapshot;
    x: number;
    y: number;
  } | null>(null);
  const calendarDragMoved = useRef(false);
  const calendarDragOrigin = useRef<{ x: number; y: number } | null>(null);
  const calendarDragCandidate = useRef<{ id: string; originDate: string | null } | null>(null);
  const suppressCalendarClick = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const clock = useMemo(() => new Date(), [today]);
  const flashNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(
      () => setNotice((current) => (current === message ? null : current)),
      5000,
    );
  };
  const month = anchor.slice(0, 7);
  const cells = buildMonthCells(month);
  const weekDates = buildWeekDates(anchor);
  const visibleTasks = filterCompletedTasks(tasks, showCompleted);
  const entries = getCalendarTaskEntries(visibleTasks, today);
  const byDate = new Map<string, typeof entries>();
  for (const entry of entries)
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  const selectedTasks = byDate.get(selected) ?? [];
  const ideas = visibleTasks
    .filter((task) => boardLane(task) === "idea")
    .sort((a, b) => a.rank.localeCompare(b.rank));
  const visibleIdeas = ideasExpanded ? ideas : ideas.slice(0, 8);
  useEffect(() => {
    if (!ideaContextMenu) return;
    const close = () => setIdeaContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [ideaContextMenu]);
  const beginDrag = (id: string | null, originDate: string | null, x: number, y: number) => {
    calendarDragMoved.current = false;
    calendarDragOrigin.current = { x, y };
    calendarDragCandidate.current = id ? { id, originDate } : null;
    setDragTaskId(null);
    setDragOriginDate(null);
    setDropTargetDate(null);
    setActiveTaskId(id);
  };
  const resetDrag = () => {
    calendarDragOrigin.current = null;
    calendarDragCandidate.current = null;
    calendarDragMoved.current = false;
    setDragTaskId(null);
    setDragOriginDate(null);
    setDropTargetDate(null);
  };
  const openTask = (id: string | null) => {
    if (!id) return;
    if (suppressCalendarClick.current) {
      suppressCalendarClick.current = false;
      return;
    }
    setActiveTaskId(id);
    onOpenTask(id);
  };
  const trackCalendarDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const origin = calendarDragOrigin.current;
    if (origin && !calendarDragMoved.current && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) {
      calendarDragMoved.current = true;
      setDragTaskId(calendarDragCandidate.current?.id ?? null);
      setDragOriginDate(calendarDragCandidate.current?.originDate ?? null);
    }
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const date = target?.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate;
    setDropTargetDate(date ?? null);
  };
  function shift(delta: number) {
    if (mode === "week") {
      const next = addDateDays(anchor, delta * 7);
      setAnchor(next);
      setSelected(next);
      return;
    }
    if (mode === "schedule") {
      const next = addDateDays(selected, delta);
      setAnchor(next);
      setSelected(next);
      return;
    }
    const [y, m] = month.split("-").map(Number);
    const date = new Date(y!, m! - 1 + delta, 1);
    const next = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
    setAnchor(next);
    setSelected(next);
  }
  const openSchedule = (date: string) => {
    setAnchor(date);
    setSelected(date);
    setMode("schedule");
    setSideOpen(false);
  };
  const schedule = (id: string | null, date: string, startTime?: string | null) => {
    if (!id) return;
    const target = tasks.find((task) => task.id === id);
    flashNotice(target
      ? (startTime ? `「${target.title}」已排到 ${date} ${startTime}` : `「${target.title}」已排到 ${date}`)
      : `任務已排到 ${date}`);
    void onSave(
      tasks.map((task) => (task.id === id ? scheduleTask(task, date, startTime) : task)),
    );
  };
  const unschedule = (id: string | null) => {
    if (!id) return;
    const target = tasks.find((task) => task.id === id);
    flashNotice(target ? `「${target.title}」已移回想法匣` : "任務已移回想法匣");
    void onSave(
      tasks.map((task) =>
        task.id === id
          ? { ...task, status: "todo", taskDate: null, completedAt: null, startTime: null, durationMinutes: null }
          : task,
      ),
    );
  };
  const complete = (id: string | null) =>
    onSave(
      tasks.map((task) =>
        task.id === id
          ? task.status === "done"
            ? { ...task, status: "todo", completedAt: null }
            : archiveTask(task, today)
          : task,
      ),
    );
  const remove = onDelete;
  const finishPointerDrag = (event: ReactPointerEvent<HTMLElement>, taskId: string | null) => {
    if (!taskId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const releasedOnSelf = Boolean(target && event.currentTarget.contains(target));
    const didMove = calendarDragMoved.current || !releasedOnSelf;
    suppressCalendarClick.current = didMove;
    if (didMove) window.setTimeout(() => { suppressCalendarClick.current = false; }, 0);
    if (!didMove) {
      resetDrag();
      return;
    }
    const slot = target?.closest<HTMLElement>("[data-schedule-minutes]");
    const grid = target?.closest<HTMLElement>("[data-day-schedule-grid]");
    const date = target?.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate
      ?? grid?.dataset.scheduleDate;
    if (target?.closest("[data-schedule-all-day], [data-unscheduled-tray]")) {
      schedule(taskId, date ?? selected, null);
    } else if (slot) {
      const rect = slot.getBoundingClientRect();
      const time = rect.height > 0
        ? timeFromSlotDrop(
            Number(slot.dataset.scheduleMinutes),
            event.clientY,
            rect.top,
            rect.height,
          )
        : formatMinutesAsTime(snapMinutes(Number(slot.dataset.scheduleMinutes)));
      schedule(taskId, date ?? selected, time);
    } else if (grid) {
      const rect = grid.getBoundingClientRect();
      schedule(
        taskId,
        date ?? selected,
        formatMinutesAsTime(minutesFromOffset(event.clientY - rect.top + grid.scrollTop)),
      );
    } else if (date) schedule(taskId, date);
    else if (target?.closest("[data-idea-drawer]")) unschedule(taskId);
    resetDrag();
  };
  const dateLabel = (date: string) =>
    new Intl.DateTimeFormat(preferences.language, {
      month: "numeric",
      day: "numeric",
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
  return (
    <div
      className={`calendar-layout ${sideOpen ? "" : "side-closed"} ${fullscreen ? "fullscreen" : ""}`}
    >
      <section className="calendar-card">
        <header className="calendar-toolbar">
          <div>
            <button onClick={() => shift(-1)} aria-label={t("calendar.previous")} title={t("calendar.previous")}>‹</button>
            <button
              className="today-button"
              onClick={() => {
                setAnchor(today);
                setSelected(today);
              }}
            >
              {t("calendar.today")}
            </button>
            <button onClick={() => shift(1)} aria-label={t("calendar.next")} title={t("calendar.next")}>›</button>
          </div>
          <h2>
            {mode === "month"
              ? new Intl.DateTimeFormat(preferences.language, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))
              : mode === "schedule"
                ? dateLabel(selected)
                : `${dateLabel(weekDates[0]!)}－${dateLabel(weekDates[6]!)}`}
          </h2>
          <div>
            <div className="view-switch">
              <button
                className={mode === "month" ? "active" : ""}
                onClick={() => setMode("month")}
              >
                {t("calendar.month")}
              </button>
              <button
                className={mode === "week" ? "active" : ""}
                onClick={() => setMode("week")}
              >
                {t("calendar.week")}
              </button>
              <button
                className={mode === "schedule" ? "active" : ""}
                onClick={() => openSchedule(selected)}
              >
                {t("calendar.schedule")}
              </button>
            </div>
            <CompletedVisibilityButton showCompleted={showCompleted} onChange={onShowCompletedChange} />
            <button
              className="icon-action"
              aria-label={t("calendar.sidebar")}
              title={t("calendar.sidebar")}
              onClick={() => setSideOpen((value) => !value)}
            >
              <Columns3 aria-hidden="true" />
            </button>
            <button
              className="icon-action"
              aria-label={t(fullscreen ? "calendar.exitFullscreen" : "calendar.fullscreen")}
              title={t(fullscreen ? "calendar.exitFullscreen" : "calendar.fullscreen")}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
          </div>
        </header>
        {notice && (
          <div className="calendar-notice" role="status">
            {notice}
            <button onClick={() => setNotice(null)} aria-label="關閉提示">×</button>
          </div>
        )}
        <div className="calendar-stage">
        {mode === "schedule" ? (
          <DaySchedule
            date={selected}
            timedTasks={selectedTasks.filter(({ task }) => task.startTime).map(({ task }) => task)}
            allDayTasks={selectedTasks.filter(({ task }) => !task.startTime).map(({ task }) => task)}
            showTray={false}
            now={selected === today ? clock : undefined}
            labels={{
              unscheduled: t("today.unscheduled"),
              dropToSchedule: t("today.dropToSchedule"),
              addAtTime: (time) => t("today.addAtTime", { time }),
              empty: t("today.empty"),
              editTitle: t("task.hint.editTitle"),
              editPriority: t("task.hint.editPriority"),
              complete: t("task.action.complete"),
              reopen: t("task.action.reopen"),
              delete: t("task.action.delete"),
              resize: t("today.resizeDuration"),
            }}
            locale={preferences.language}
            onSchedule={(taskId, startTime) => schedule(taskId, selected, startTime)}
            onClearTime={(taskId) => schedule(taskId, selected, null)}
            onCreateAt={(title, startTime) => void onSave([...tasks, newTask(title, { taskDate: selected, startTime, durationMinutes: 30 })])}
            onOpenTask={openTask}
            onPriority={(taskId, priority) => void onSave(applyTaskPriority(tasks, taskId, priority, selected))}
            onDelete={remove}
            onComplete={(task) => complete(task.id)}
            onResize={(taskId, durationMinutes) => void onSave(tasks.map((item) => item.id === taskId ? { ...item, durationMinutes } : item))}
          />
        ) : mode === "month" ? (
          <>
            <div className="weekdays">
              {Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(preferences.language, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 2 + day)))).map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="month-grid">
              {cells.map((cell) => {
                const dayEntries = byDate.get(cell.date) ?? [];
                return (
                  <section
                    key={cell.date}
                    className={`calendar-day ${cell.currentMonth ? "" : "muted"} ${selected === cell.date ? "selected" : ""} ${cell.date === today ? "today" : ""} ${dragTaskId && dragOriginDate === cell.date ? "drag-origin" : ""} ${dragTaskId && dropTargetDate === cell.date && dragOriginDate !== cell.date ? "drop-target" : ""}`}
                    data-calendar-date={cell.date}
                    onClick={() => {
                      setSelected(cell.date);
                      setSideOpen(true);
                    }}
                    onDoubleClick={() => openSchedule(cell.date)}
                  >
                    <span className="day-number">
                      {Number(cell.date.slice(8))}
                    </span>
                    <div className="calendar-task-list">
                      {dayEntries.slice(0, 4).map((entry) => (
                        <span
                          onPointerDown={(event) => {
                            if (event.button === 0 && entry.task.id && !(event.target as HTMLElement).closest("button,input")) {
                              beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                              event.currentTarget.setPointerCapture(event.pointerId);
                            }
                          }}
                          onPointerMove={(event) => {
                            trackCalendarDrag(event);
                          }}
                          onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                          onPointerCancel={resetDrag}
                          onLostPointerCapture={() => {
                            if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            openTask(entry.task.id);
                          }}
                          style={taskProjectStyle(entry.task)}
                          key={`${entry.task.id}:${entry.date}`}
                          className={`calendar-task-title ${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragTaskId === entry.task.id ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        >
                          <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                          <button type="button" className={`calendar-quick-check ${entry.task.status === "done" ? "done" : ""}`} aria-label={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")} title={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); complete(entry.task.id); }}>{entry.task.status === "done" ? "✓" : ""}</button>
                          {entry.task.status === "done" && <span className="task-done-check">✓</span>}
                          <span className="calendar-task-text">{entry.task.title}</span>
                        </span>
                      ))}
                      {dayEntries.length > 4 && (
                        <small>＋{dayEntries.length - 4} 項</small>
                      )}
                    </div>
                    {dragTaskId && <i className="drop-hint">拖到這一天排程</i>}
                  </section>
                );
              })}
            </div>
          </>
        ) : (
          <div className="week-grid">
            {weekDates.map((date) => {
              const dayEntries = byDate.get(date) ?? [];
              return (
                <section
                  key={date}
                  data-calendar-date={date}
                  className={`week-day ${date === today ? "today" : ""} ${date === selected ? "selected" : ""} ${dragTaskId && dragOriginDate === date ? "drag-origin" : ""} ${dragTaskId && dropTargetDate === date && dragOriginDate !== date ? "drop-target" : ""}`}
                >
                  <div className="week-date">
                    <button
                      onClick={() => {
                        setSelected(date);
                        setSideOpen(true);
                      }}
                    >
                      <span>{dateLabel(date)}</span>
                      <small>
                        {
                          dayEntries.filter(
                            (entry) => entry.task.status !== "done",
                          ).length
                        }{" "}
                        項待辦
                      </small>
                    </button>
                    <button
                      type="button"
                      className="week-plan-button"
                      aria-label={t("calendar.planTimes")}
                      title={t("calendar.planTimes")}
                      onClick={() => openSchedule(date)}
                    >
                      <Clock aria-hidden="true" />
                    </button>
                  </div>
                  <div className="week-task-list">
                    {dayEntries.map((entry) => (
                      <article
                        onPointerDown={(event) => {
                          if (event.button === 0 && entry.task.id && !(event.target as HTMLElement).closest("button,input,select")) {
                            beginDrag(entry.task.id, entry.date, event.clientX, event.clientY);
                            event.currentTarget.setPointerCapture(event.pointerId);
                          }
                        }}
                        onPointerMove={(event) => {
                          trackCalendarDrag(event);
                        }}
                        onPointerUp={(event) => finishPointerDrag(event, entry.task.id)}
                        onPointerCancel={resetDrag}
                        onLostPointerCapture={() => {
                          if (calendarDragCandidate.current?.id === entry.task.id || dragTaskId === entry.task.id) resetDrag();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                           openTask(entry.task.id);
                        }}
                        style={taskProjectStyle(entry.task)}
                        className={`${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragTaskId === entry.task.id ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        key={`${entry.task.id}:${entry.date}`}
                      >
                        <div className="task-title-row">
                          <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                          <strong>
                            {entry.task.status === "done" ? "✓ " : ""}
                            {entry.task.title}
                          </strong>
                        </div>
                        <small>
                          {entry.task.projectName ?? "無專案"}
                        </small>
                        <div className="week-task-actions"><button type="button" aria-label={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")} title={entry.task.status === "done" ? t("task.action.reopen") : t("task.action.complete")} onClick={(event) => { event.stopPropagation(); complete(entry.task.id); }}><CheckCircle2 aria-hidden="true" /></button><button type="button" className="danger" aria-label={t("task.action.delete")} title={t("task.action.delete")} onClick={(event) => { event.stopPropagation(); remove(entry.task); }}><Trash2 aria-hidden="true" /></button></div>
                      </article>
                    ))}
                  </div>
                  {dragTaskId && (
                    <div className="week-drop">拖到這一天排程</div>
                  )}
                </section>
              );
            })}
          </div>
        )}
        </div>
        <section
          className={`idea-drawer ${dragTaskId ? "drag-active" : ""}`}
          data-idea-drawer
        >
          <header>
            <div>
              <h3>{t("calendar.ideaTitle")}</h3>
              <p>{t("calendar.ideaHelp")}</p>
            </div>
            <button
              type="button"
              className="idea-count-button"
              onClick={() => setIdeasExpanded((value) => !value)}
              aria-expanded={ideasExpanded}
            >
              {ideasExpanded ? t("calendar.collapse") : t("calendar.items", { count: ideas.length })}
            </button>
          </header>
          <div className="idea-grid">
            {ideas.length === 0 ? (
              <small>{t("calendar.noIdeas")}</small>
            ) : (
              visibleIdeas.map((task) => (
                <article
                  onClick={() => openTask(task.id)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && task.id) {
                      event.preventDefault();
                      openTask(task.id);
                    }
                  }}
                  tabIndex={0}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveTaskId(task.id);
                    setIdeaContextMenu({
                      task,
                      x: Math.min(event.clientX, window.innerWidth - 220),
                      y: Math.min(event.clientY, window.innerHeight - 200),
                    });
                  }}
                  style={taskProjectStyle(task)}
                  className={`${activeTaskId === task.id ? "selected-task" : ""} ${dragTaskId === task.id ? "dragging" : ""}`}
                  key={task.id ?? task.title}
                >
                  <button
                    type="button"
                    className="idea-drag-handle"
                    data-drag-handle
                    aria-label={`拖曳 ${task.title}`}
                    title="拖曳到日期"
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !task.id) return;
                      beginDrag(task.id, null, event.clientX, event.clientY);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      trackCalendarDrag(event);
                    }}
                    onPointerUp={(event) => finishPointerDrag(event, task.id)}
                    onPointerCancel={resetDrag}
                    onLostPointerCapture={() => {
                      if (calendarDragCandidate.current?.id === task.id || dragTaskId === task.id) resetDrag();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      suppressCalendarClick.current = false;
                    }}
                  >
                    <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                  </button>
                  <div className="idea-card-body">
                    <strong>{task.title}</strong>
                    <span>
                      <PriorityControl
                        priority={task.priority}
                        compact
                        locale={preferences.language}
                        onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, today))}
                      />
                      <small>{task.projectName ?? t("app.unassigned")}</small>
                    </span>
                    <button
                      type="button"
                      className="idea-promote-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onPromote(task);
                      }}
                    >
                      {t("task.action.promote")}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="idea-delete-button"
                    aria-label={`永久刪除想法「${task.title}」`}
                    title="永久刪除"
                    draggable={false}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(task);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </article>
              ))
            )}
          </div>
          {ideas.length > 8 && (
            <button
              type="button"
              className="idea-expand-button"
              onClick={() => setIdeasExpanded((value) => !value)}
            >
              {ideasExpanded ? "收合想法" : `顯示其餘 ${ideas.length - 8} 項想法`}
            </button>
          )}
        </section>
        {ideaContextMenu && (
          <div
            className="idea-context-menu"
            role="menu"
            aria-label={`${ideaContextMenu.task.title}的操作`}
            style={{ left: ideaContextMenu.x, top: ideaContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                    if (task.id) openTask(task.id);
              }}
            >
              <Pencil aria-hidden="true" />
              {t("task.action.rename")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                if (task.id) void onSave(applyTaskPriority(tasks, task.id, "highest", today));
              }}
            >
              <Star aria-hidden="true" />
              {t("task.action.important")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                if (task.id) schedule(task.id, today);
              }}
            >
              <CalendarDays aria-hidden="true" />
              {t("task.action.scheduleToday")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                const task = ideaContextMenu.task;
                setIdeaContextMenu(null);
                void remove(task);
              }}
            >
              <Trash2 aria-hidden="true" />
              永久刪除想法
            </button>
          </div>
        )}
      </section>
      {sideOpen && (
        <aside className="agenda">
          <div className="agenda-header">
            <div>
              <span className="eyebrow">DAY PLAN</span>
              <h3>{selected}</h3>
              <small>
                {
                  selectedTasks.filter(({ task }) => task.status !== "done")
                    .length
                }{" "}
                項待完成
              </small>
            </div>
            <div>
              <button
                className="secondary-button"
                onClick={() => openSchedule(selected)}
              >
                <Clock aria-hidden="true" />
                {t("calendar.planTimes")}
              </button>
              <button className="icon-button" onClick={() => setSideOpen(false)} aria-label="關閉側面板">
                <X aria-hidden="true" />
              </button>
            </div>
          </div>
          {selectedTasks.length === 0 ? (
            <Empty text="這天沒有任務。" />
          ) : (
            selectedTasks.map(({ task, date }) => (
              <article
                style={taskProjectStyle(task)}
                className={`${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}
                key={`${task.id}:${date}`}
              >
                <button
                  className="agenda-drag-handle"
                  aria-label={`拖曳 ${task.title}`}
                  title="拖曳到其他日期"
                  onPointerDown={(event) => {
                    if (event.button === 0) {
                      beginDrag(task.id, date, event.clientX, event.clientY);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }
                  }}
                  onPointerMove={trackCalendarDrag}
                  onPointerUp={(event) => finishPointerDrag(event, task.id)}
                  onPointerCancel={resetDrag}
                  onLostPointerCapture={() => {
                    if (dragTaskId === task.id) resetDrag();
                  }}
                  onClick={(event) => event.stopPropagation()}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <div>
                  <div className="task-title-row">
                    <PriorityControl
                      priority={task.priority}
                      compact
                      locale={preferences.language}
                      onChange={(priority) => task.id && void onSave(applyTaskPriority(tasks, task.id, priority, selected))}
                    />
                    <button type="button" className="agenda-task-title" onClick={() => openTask(task.id)}>{task.title}</button>
                  </div>
                  <select
                    className="agenda-project-select"
                    aria-label={`${task.title} 所屬專案`}
                    value={task.projectId ?? ""}
                    onChange={(event) => {
                      const project = projects.find((item) => item.id === event.target.value);
                      void onSave(tasks.map((item) => item.id === task.id ? { ...item, projectId: project?.id ?? null, projectName: project?.name ?? null } : item));
                    }}
                  >
                    <option value="">無專案</option>
                    {projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}
                  </select>
                </div>
                <TaskDateInput
                  ariaLabel={`${task.title}規劃日`}
                  value={task.taskDate ?? null}
                  onCommit={(nextDate) => {
                    if (nextDate) {
                      setSelected(nextDate);
                      flashNotice(`「${task.title}」已排到 ${nextDate}`);
                    } else {
                      flashNotice(`「${task.title}」已移回想法匣`);
                    }
                    void onSave(
                      tasks.map((item) =>
                        item.id === task.id
                          ? { ...item, taskDate: nextDate }
                          : item,
                      ),
                    );
                  }}
                />
                <div className="agenda-actions">
                  <TaskActionBar
                    task={task}
                    important={task.priority === "highest"}
                    onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, selected))}
                    onComplete={() => complete(task.id)}
                    onEdit={() => task.id && openTask(task.id)}
                    onDelete={remove}
                  />
                </div>
              </article>
            ))
          )}
        </aside>
      )}
    </div>
  );
}

function ProjectEditor({
  project,
  openTasks,
  doingTasks,
  existingAreas = [],
  onSave,
  onFocus,
  onComplete,
  onReopen,
  onArchive,
  onOpen,
  onDelete,
}: {
  project: BrainProjectSnapshot;
  openTasks: number;
  doingTasks: number;
  existingAreas?: string[];
  onSave: (value: BrainProjectSnapshot) => void;
  onFocus: (enabled: boolean) => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [value, setValue] = useState(project);
  useEffect(() => setValue(project), [project]);
  return (
    <article
      className="project-card"
      tabIndex={0}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button,input,select,textarea,label,a")) onOpen();
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) onOpen();
      }}
    >
      <div className="project-head">
        <div>
          <span className="eyebrow">{value.area ?? t("app.uncategorized")}</span>
          <h3>{value.name}</h3>
          <ImportanceControl
            value={value.priority}
            locale={preferences.language}
            onChange={(priority) => {
              const next = { ...value, priority };
              setValue(next);
              onSave(next);
            }}
          />
        </div>
        <label className="focus">
          <input
            type="checkbox"
            checked={value.focusToday}
            onChange={(event) => onFocus(event.target.checked)}
          />
          {t("project.focusToday")}
        </label>
      </div>
      <div className="progress">
        <i style={{ width: `${value.progress ?? 0}%` }} />
      </div>
      <div className="project-meta">
        <span>{value.progress ?? 0}%</span>
        <span>{t("task.count.open", { count: openTasks })}</span>
        <span>{t("task.count.doing", { count: doingTasks })}</span>
        <span>{value.startDate || value.endDate ? `${value.startDate ?? t("project.date.undecided")} — ${value.endDate ?? t("project.date.undecided")}` : t("project.period.none")}</span>
      </div>
      <div className="project-editor-grid">
        <label>
          {t("project.field.status")}
          <select
            value={value.status}
            onChange={(event) =>
              setValue({ ...value, status: event.target.value })
            }
          >
            <option value="planning">{t("project.status.planning")}</option>
            <option value="active">{t("project.status.active")}</option>
            <option value="paused">{t("project.status.paused")}</option>
            {value.status === "done" && <option value="done">{t("project.status.done")}</option>}
            {value.status === "archived" && <option value="archived">{t("project.status.archived")}</option>}
          </select>
        </label>
        <label>
          {t("project.field.category")}
          <CategoryInput
            value={value.area ?? ""}
            existingCategories={existingAreas}
            listId={`project-area-list-${project.id ?? "new"}`}
            ariaLabel={t("project.field.category")}
            onChange={(area) =>
              setValue({ ...value, area: area || null })
            }
          />
        </label>
        <label>
          {t("project.field.importance")}
          <select
            value={value.priority ?? ""}
            onChange={(event) =>
              setValue({
                ...value,
                  priority: event.target.value === "" ? null : Number(event.target.value),
                })
              }
          >
            <option value="">{t("project.importance.unset")}</option>
            <option value="1">{t("project.importance.high")}</option>
            <option value="2">{t("project.importance.medium")}</option>
            <option value="3">{t("project.importance.low")}</option>
          </select>
        </label>
        <label>
          {t("project.field.startDate")}
          <input
            type="date"
            value={value.startDate ?? ""}
            onChange={(event) =>
              setValue({ ...value, startDate: event.target.value || null })
            }
          />
        </label>
        <label>
          {t("project.field.endDate")}
          <input
            type="date"
            value={value.endDate ?? ""}
            onChange={(event) =>
              setValue({ ...value, endDate: event.target.value || null })
            }
          />
        </label>
        <label className="project-progress">
          {t("project.field.progress", { value: value.progress ?? 0 })}
          <input
            type="range"
            min="0"
            max="100"
            value={value.progress ?? 0}
            onChange={(event) =>
              setValue({ ...value, progress: Number(event.target.value) })
            }
          />
        </label>
        <div className="project-actions project-icon-actions">
          <button className="primary icon-action" aria-label={t("project.action.save")} title={t("project.action.save")} onClick={() => onSave(value)}><Save aria-hidden="true" /></button>
          {value.status === "done" || value.status === "archived" ? (
            <button className="secondary-button icon-action" aria-label={t("project.action.reopen")} title={t("project.action.reopen")} onClick={onReopen}><RotateCcw aria-hidden="true" /></button>
          ) : (
            <button className="secondary-button icon-action" aria-label={t("project.action.complete")} title={t("project.action.complete")} onClick={onComplete}><CheckCircle2 aria-hidden="true" /></button>
          )}
          {value.status !== "archived" && <button className="archive-button icon-action" aria-label={t("project.action.archive")} title={t("project.action.archive")} onClick={onArchive}><Archive aria-hidden="true" /></button>}
          <button className="danger icon-action" aria-label={t("project.action.delete")} title={t("project.action.delete")} onClick={onDelete}><Trash2 aria-hidden="true" /></button>
        </div>
      </div>
      <MarkdownEditor value={value.body ?? ""} onChange={(body) => setValue({ ...value, body })} locale={preferences.language} minRows={8} />
    </article>
  );
}
function Projects({
  projects,
  tasks,
  onOpenProject,
  onOpenBoard,
  onCreate,
}: {
  projects: BrainProjectSnapshot[];
  tasks: BrainTaskSnapshot[];
  onOpenProject: (projectId: string) => void;
  onOpenBoard: (projectId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useUiPreferences();
  const [tab, setTab] = useState<"current" | "completed" | "archived">("current");
  const [mode, setMode] = useState<"list" | "status">(() => localStorage.getItem("second-brain.projectView") === "status" ? "status" : "list");
  const [statusFilter, setStatusFilter] = useState(() => localStorage.getItem("second-brain.projectStatusFilter") ?? "all");
  const [priorityFilter, setPriorityFilter] = useState(() => localStorage.getItem("second-brain.projectPriorityFilter") ?? "all");
  const [areaFilter, setAreaFilter] = useState(() => localStorage.getItem("second-brain.projectAreaFilter") ?? "all");
  const [sort, setSort] = useState<"priority" | "status" | "name" | "endDate">(() => {
    const saved = localStorage.getItem("second-brain.projectSort");
    return saved === "status" || saved === "name" || saved === "endDate" ? saved : "priority";
  });
  const groups = {
    current: projects.filter((project) => project.status !== "done" && project.status !== "archived"),
    completed: projects.filter((project) => project.status === "done"),
    archived: projects.filter((project) => project.status === "archived"),
  };
  const areas = [...new Set(projects.map((project) => project.area).filter((area): area is string => Boolean(area)))].sort();
  const statusRank = new Map([["planning", 0], ["active", 1], ["paused", 2], ["done", 3], ["archived", 4]]);
  const visibleProjects = groups[tab]
    .filter((project) => statusFilter === "all" || project.status === statusFilter)
    .filter((project) => priorityFilter === "all" || String(project.priority ?? "unset") === priorityFilter)
    .filter((project) => areaFilter === "all" || project.area === areaFilter)
    .sort((left, right) => {
      if (sort === "priority") return (left.priority ?? 99) - (right.priority ?? 99) || left.name.localeCompare(right.name);
      if (sort === "status") return (statusRank.get(left.status) ?? 99) - (statusRank.get(right.status) ?? 99) || left.name.localeCompare(right.name);
      if (sort === "endDate") return (left.endDate ?? "9999-12-31").localeCompare(right.endDate ?? "9999-12-31") || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name);
    });
  const renderProject = (project: BrainProjectSnapshot) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    const openTasks = projectTasks.filter((task) => task.status !== "done").length;
    const doingTasks = projectTasks.filter((task) => task.status === "doing").length;
    return <article key={project.id ?? project.name} className="project-card project-summary-card" tabIndex={0} onClick={() => project.id && onOpenProject(project.id)} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && project.id) { event.preventDefault(); onOpenProject(project.id); } }}>
      <div className="project-head"><div><span className="eyebrow">{project.area ?? t("app.uncategorized")}</span><h3>{project.name}</h3></div>{project.focusToday && <span className="focus">{t("project.focusToday")}</span>}</div>
      <div className="project-summary-status"><span>{t(`project.status.${project.status}`)}</span><span>{project.priority ? `${project.priority} · ${project.priority === 1 ? t("project.importance.high") : project.priority === 2 ? t("project.importance.medium") : t("project.importance.low")}` : t("project.importance.unset")}</span></div>
      <div className="progress"><i style={{ width: `${project.progress ?? 0}%` }} /></div>
      <div className="project-meta"><span>{project.progress ?? 0}%</span><span>{t("task.count.open", { count: openTasks })}</span><span>{t("task.count.doing", { count: doingTasks })}</span><span>{project.startDate || project.endDate ? `${project.startDate ?? t("project.date.undecided")} → ${project.endDate ?? t("project.date.undecided")}` : t("project.period.none")}</span></div>
      <button type="button" className="secondary-button action-with-icon project-board-button" onClick={(event) => { event.stopPropagation(); if (project.id) onOpenBoard(project.id); }}><FolderKanban aria-hidden="true" />{t("project.action.open")}</button>
    </article>;
  };
  return (
    <section className="projects-workspace">
      <header className="project-workspace-header">
        <div className="project-tabs" role="tablist" aria-label={t("project.field.status")}>
          {([["current", "project.tab.current"], ["completed", "project.tab.completed"], ["archived", "project.tab.archived"]] as const).map(([id, labelKey]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => { setTab(id); setStatusFilter("all"); localStorage.setItem("second-brain.projectStatusFilter", "all"); }}>{t(labelKey)}<span>{groups[id].length}</span></button>
          ))}
        </div>
        <button className="primary icon-action" aria-label={t("project.action.add")} title={t("project.action.add")} onClick={onCreate}><Plus aria-hidden="true" /></button>
      </header>
      <div className="project-filters">
        <div className="segmented-control icon-segmented-control" aria-label={t("project.view.board")}>
          <button className={mode === "list" ? "active" : ""} aria-label={t("project.view.list")} title={t("project.view.list")} onClick={() => { setMode("list"); localStorage.setItem("second-brain.projectView", "list"); }}><List aria-hidden="true" /></button>
          <button className={mode === "status" ? "active" : ""} aria-label={t("project.view.board")} title={t("project.view.board")} onClick={() => { setMode("status"); localStorage.setItem("second-brain.projectView", "status"); }}><Columns3 aria-hidden="true" /></button>
        </div>
        <select aria-label={t("project.filter.status")} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); localStorage.setItem("second-brain.projectStatusFilter", event.target.value); }}><option value="all">{t("project.filter.allStatuses")}</option><option value="planning">{t("project.status.planning")}</option><option value="active">{t("project.status.active")}</option><option value="paused">{t("project.status.paused")}</option></select>
        <select aria-label={t("project.filter.importance")} value={priorityFilter} onChange={(event) => { setPriorityFilter(event.target.value); localStorage.setItem("second-brain.projectPriorityFilter", event.target.value); }}><option value="all">{t("project.filter.allImportance")}</option><option value="1">{t("project.importance.high")}</option><option value="2">{t("project.importance.medium")}</option><option value="3">{t("project.importance.low")}</option><option value="unset">{t("project.importance.unset")}</option></select>
        <select aria-label={t("project.filter.category")} value={areaFilter} onChange={(event) => { setAreaFilter(event.target.value); localStorage.setItem("second-brain.projectAreaFilter", event.target.value); }}><option value="all">{t("project.filter.allCategories")}</option>{areas.map((area) => <option key={area}>{area}</option>)}</select>
        <select aria-label={t("project.sort")} value={sort} onChange={(event) => { const value = event.target.value as typeof sort; setSort(value); localStorage.setItem("second-brain.projectSort", value); }}><option value="priority">{t("project.sort.importance")}</option><option value="status">{t("project.sort.status")}</option><option value="name">{t("project.sort.name")}</option><option value="endDate">{t("project.sort.endDate")}</option></select>
      </div>
      {visibleProjects.length === 0 ? <Empty text={t("project.empty")} hint={t("project.emptyHelp")} actionLabel={t("project.action.add")} onAction={onCreate} /> : mode === "status" && tab === "current" ? (
        <div className="project-status-board">
          {(["planning", "active", "paused"] as const).map((status) => <section key={status}><header><strong>{t(`project.status.${status}`)}</strong><span>{visibleProjects.filter((project) => project.status === status).length}</span></header>{visibleProjects.filter((project) => project.status === status).map(renderProject)}</section>)}
        </div>
      ) : <div className={mode === "list" ? "project-list" : "project-grid"}>{visibleProjects.map(renderProject)}</div>}
    </section>
  );
}

function Collections({
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
  onSave: (collection: BrainCollectionSnapshot) => void;
  onDelete: (collection: BrainCollectionSnapshot) => void;
  onImportPrompts: () => void;
  onExportPrompts: () => void;
}) {
  const { t, preferences } = useUiPreferences();
  const [category, setCategory] = useState("all");
  const [importance, setImportance] = useState("all");
  const categories = [...new Set(collections.map((item) => item.category).filter((item): item is string => Boolean(item)))].sort();
  const promptCount = collections.filter((item) => (item.category ?? "").trim().toLowerCase().startsWith("提示詞")).length;
  const visible = collections
    .filter((item) => category === "all" || item.category === category)
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
                onChange={(importance) => onSave({ ...item, importance })}
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

function CollectionEditor({
  collection,
  locale,
  existingCategories = [],
  onSave,
  onDelete,
}: {
  collection: BrainCollectionSnapshot;
  locale: UiPreferences["language"];
  existingCategories?: string[];
  onSave: (collection: BrainCollectionSnapshot) => void;
  onDelete: (collection: BrainCollectionSnapshot) => void;
}) {
  const { t } = useUiPreferences();
  const [value, setValue] = useState(collection);
  useEffect(() => {
    setValue((current) => ({ ...current, importance: collection.importance }));
  }, [collection.importance]);
  const [mode, setMode] = useState<"write" | "preview">("preview");
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
    onSave({ ...value, name: value.name.trim() });
    setMode("preview");
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
    <MarkdownEditor value={value.body} onChange={(body) => setValue({ ...value, body })} mode={mode} onModeChange={setMode} iconToggle locale={locale} />
    <div className="project-actions">
      {isPrompt && variables.length > 0 && (
        <button className="secondary-button action-with-icon" onClick={openFill}>◆ {t("collection.fillCopy")}</button>
      )}
      <button className="primary action-with-icon" disabled={!value.name.trim()} onClick={save}><Save aria-hidden="true" />{t("app.save")}</button>
      <button className="danger icon-action" aria-label={t("collection.action.delete")} title={t("collection.action.delete")} onClick={() => onDelete(value)}><Trash2 aria-hidden="true" /></button>
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

function CreateEntityModal({
  kind,
  initialName,
  templates = [],
  existingCategories = [],
  onClose,
  onCreate,
}: {
  kind: "project" | "collection";
  initialName: string;
  templates?: { name: string; body: string }[];
  existingCategories?: string[];
  onClose: () => void;
  onCreate: (name: string, category: string | null, importance: number | null, body: string) => Promise<void>;
}) {
  const { t, preferences } = useUiPreferences();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState("");
  const [importance, setImportance] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (!name.trim() || name.trim().length > 200 || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(name.trim(), category.trim() || null, importance ? Number(importance) : null, kind === "project" ? "" : body);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal entity-modal" role="dialog" aria-modal="true" aria-label={t(kind === "project" ? "entity.project.title" : "entity.collection.title")}>
        <div className="modal-header"><div><span className="eyebrow">{kind === "project" ? "OUTCOME" : "REFERENCE"}</span><h2>{t(kind === "project" ? "entity.project.title" : "entity.collection.title")}</h2></div><button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose}><X aria-hidden="true" /></button></div>
        <p className="entity-guidance">{t(kind === "project" ? "entity.project.help" : "entity.collection.help")}</p>
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
        {kind === "collection" && templates.length > 0 && (
          <label>{preferences.language === "zh-TW" ? "套用模板" : "Apply template"}<select value="" onChange={(event) => { const picked = templates.find((item) => item.name === event.target.value); if (picked) { setBody(picked.body); if (!name.trim()) setName(picked.name); } }}><option value="">{preferences.language === "zh-TW" ? "不使用模板" : "No template"}</option>{templates.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        )}
        {kind === "collection" && <MarkdownEditor value={body} onChange={setBody} locale={preferences.language} minRows={8} />}
        <div className="modal-actions"><button className="secondary-button" onClick={onClose}>{t("app.cancel")}</button><button className="primary" disabled={!name.trim() || submitting} onClick={() => void submit()}>{t(submitting ? "app.creating" : "app.create")}</button></div>
      </section>
    </div>
  );
}

function SyncSettings({
  diagnostics,
  serverOrigin,
  setServerOrigin,
  vaultInput,
  setVaultInput,
  pairing,
  devicePaired,
  working,
  writeApproved,
  onBrowseVault,
  onSelectVault,
  onConfigureServer,
  onStartPairing,
  onOpenPairingWebsite,
  onSync,
  onShadow,
  onOpenArchitecture,
}: {
  diagnostics: DiagnosticsSnapshot | null;
  serverOrigin: string;
  setServerOrigin: (v: string) => void;
  vaultInput: string;
  setVaultInput: (v: string) => void;
  pairing: { pairingId: string; userCode: string; expiresAt: string } | null;
  devicePaired: boolean;
  working: boolean;
  writeApproved: boolean;
  onBrowseVault: () => void;
  onSelectVault: () => void;
  onConfigureServer: () => void;
  onStartPairing: () => void;
  onOpenPairingWebsite: () => void;
  onSync: () => void;
  onShadow: () => void;
  onOpenArchitecture: () => void;
}) {
  const { preferences, t } = useUiPreferences();
  return (
    <div className="settings-grid">
      <section className="settings-card">
        <span className="step">★</span>
        <h2>建立知識架構</h2>
        <p>產生 .ai 委任檔、自動索引、範本與提示詞庫，讓任何 AI 一進入資料夾就能快速讀懂你的第二大腦。可自由勾選需要的模板包。</p>
        <button className="primary wide" onClick={onOpenArchitecture}>
          新建架構模板
        </button>
      </section>
      <section className="settings-card">
        <span className="step">1</span>
        <h2>{t("sync.folder")}</h2>
        <p>{t("sync.folderHelp")}</p>
        <code>{diagnostics?.selectedVault ?? t("sync.notSelected")}</code>
        <button
          className="browse-button wide"
          disabled={working}
          onClick={onBrowseVault}
        >
          {t("sync.browse")}
        </button>
        <details>
          <summary>{t("sync.manualPath")}</summary>
          <div className="input-action">
            <input
              placeholder="C:\Users\name\Documents\SecondBrain"
              value={vaultInput}
              onChange={(event) => setVaultInput(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={working || !vaultInput.trim()}
              onClick={onSelectVault}
            >
              {t("sync.useFolder")}
            </button>
          </div>
        </details>
      </section>
      <section className="settings-card">
        <span className="step">2</span>
        <h2>{t("sync.cloud")}</h2>
        <p>{t("sync.cloudHelp")}</p>
        <div className="input-action">
          <input
            value={serverOrigin}
            onChange={(event) => setServerOrigin(event.target.value)}
            readOnly={diagnostics?.syncEnabled === true}
            placeholder="選用：localhost 開發伺服器"
          />
          <button className="primary" disabled={diagnostics?.syncEnabled === true} onClick={onConfigureServer}>
            {t("sync.save")}
          </button>
        </div>
        {diagnostics?.syncEnabled && (
          <div className="paired-ok">
            <strong>Publisher 同步已啟用</strong>
            <small>私人 build 已鎖定允許的 Publisher origin</small>
          </div>
        )}
      </section>
      <section className="settings-card">
        <span className="step">3</span>
        <h2>{t("sync.pairing")}</h2>
        <p>{t("sync.pairingHelp")}</p>
        {devicePaired ? (
          <div className="paired-ok">
            <strong>✓ {t("sync.paired")}</strong>
            <small>{t("sync.pairedHelp")}</small>
          </div>
        ) : pairing ? (
          <div className="pair-code">
            <small>{t("sync.enterCode")}</small>
            <strong>{pairing.userCode}</strong>
            <span>
              {new Date(pairing.expiresAt).toLocaleTimeString(preferences.language)}
            </span>
            <button className="primary wide" onClick={onOpenPairingWebsite}>
              {t("sync.openPairing")}
            </button>
          </div>
        ) : (
          <button
            className="primary wide"
            disabled={working || !serverOrigin}
            onClick={onStartPairing}
          >
            {t("sync.startPairing")}
          </button>
        )}
      </section>
      <section className="settings-card">
        <span className="step">4</span>
        <h2>{t("sync.recovery")}</h2>
        <p>{t("sync.recoveryHelp")}</p>
        {!writeApproved && devicePaired && (
          <div className="first-sync-hint">
            <strong>{t("sync.firstConfirm")}</strong>
            <span>{t("sync.firstConfirmHelp")}</span>
          </div>
        )}
        <div className="diagnostic-list">
          <span>
            模式 <b>{writeApproved ? "Write Alpha" : "Shadow 預覽"}</b>
          </span>
          <span>
            Watcher <b>{diagnostics?.watcherStatus ?? "stopped"}</b>
          </span>
          <span>
            Recovery <b>{diagnostics?.recoveryStatus ?? "none"}</b>
          </span>
          <span>
            Key <b>{diagnostics?.keyBackend ?? "—"}</b>
          </span>
        </div>
        <button
          className="primary wide"
          disabled={working || !devicePaired}
          onClick={onSync}
        >
          {!devicePaired
            ? t("sync.pairFirst")
            : writeApproved
              ? t("sync.full")
              : t("sync.first")}
        </button>
        {writeApproved && (
          <button className="secondary-button wide" onClick={onShadow}>
            {t("sync.shadow")}
          </button>
        )}
      </section>
    </div>
  );
}

function WorkspaceSearch({
  tasks,
  projects,
  collections,
  onClose,
  onSelect,
  actions,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
  onClose: () => void;
  onSelect: (result: WorkspaceSearchResult) => void;
  actions?: Array<{ label: string; run: () => void }>;
}) {
  const { t } = useUiPreferences();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "completed">("all");
  const [kindFilter, setKindFilter] = useState<"all" | WorkspaceSearchKind>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const results = useMemo(() => searchWorkspace(
    tasks.filter((task): task is BrainTaskSnapshot & { id: string } => Boolean(task.id)).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      taskDate: task.taskDate ?? null,
      completedAt: task.completedAt,
      projectName: task.projectName,
      sourcePath: task.sourcePath,
      sourceHeading: task.sourceHeading,
    })),
    projects.filter((project): project is BrainProjectSnapshot & { id: string } => Boolean(project.id)).map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      area: project.area,
      endDate: project.endDate ?? null,
      completedAt: project.completedAt ?? null,
    })),
    collections.filter((collection): collection is BrainCollectionSnapshot & { id: string } => Boolean(collection.id)).map((collection) => ({
      id: collection.id,
      name: collection.name,
      category: collection.category,
      importance: collection.importance,
      sourcePath: collection.sourcePath,
      body: collection.body,
    })),
    { query, sort, status: statusFilter, kinds: kindFilter === "all" ? undefined : [kindFilter], today: taipeiDateKey() },
  ), [collections, kindFilter, projects, query, sort, statusFilter, tasks]);
  const queryError = parseWorkspaceQuery(query).error;
  useEffect(() => setActiveIndex(0), [query, sort, statusFilter, kindFilter]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="modal workspace-search"
        role="dialog"
        aria-modal="true"
        aria-label={t("search.dialog")}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => Math.min(value + 1, results.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)); }
          if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); onSelect(results[activeIndex]); }
        }}
      >
        <div className="search-input-row">
          <Search aria-hidden="true" />
          <input ref={inputRef} aria-label={t("search.keyword")} aria-invalid={Boolean(queryError)} placeholder={t("search.placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <div className="search-toolbar">
          <div className="segmented-control" aria-label={t("search.sort")}>
            <button className={sort === "relevance" ? "active" : ""} onClick={() => setSort("relevance")}>{t("search.relevance")}</button>
            <button className={sort === "date" ? "active" : ""} onClick={() => setSort("date")}>{t("search.date")}</button>
          </div>
          <select aria-label={t("search.filter.status")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">{t("search.allStatuses")}</option>
            <option value="open">{t("search.open")}</option>
            <option value="completed">{t("search.completed")}</option>
          </select>
          <select aria-label={t("search.filter.kind")} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as typeof kindFilter)}><option value="all">{t("search.allKinds")}</option><option value="task">{t("search.kind.task")}</option><option value="project">{t("search.kind.project")}</option><option value="collection">{t("search.kind.collection")}</option></select>
          <span>{t("search.results", { count: results.length })}</span>
        </div>
        {queryError && <div className="search-error" role="status">{queryError}</div>}
        {actions && actions.length > 0 && !query && (
          <div className="search-commands" aria-label="快速動作">
            {actions.map((command) => (
              <button
                key={command.label}
                onClick={() => { onClose(); command.run(); }}
              >
                <span className="result-kind">CMD</span>
                <span><strong>{command.label}</strong></span>
              </button>
            ))}
          </div>
        )}
        <div className="search-results" role="listbox">
          {results.length === 0 ? <Empty text={t("search.empty")} /> : results.map((result, index) => {
            const isTask = result.kind === "task";
            const title = isTask ? result.value.title : result.value.name;
            const meta = result.kind === "task"
              ? [result.value.projectName, result.value.taskDate, result.value.sourcePath].filter(Boolean).join(" · ")
              : result.kind === "project"
                ? [result.value.area, result.value.status, result.value.endDate].filter(Boolean).join(" · ")
                : [result.value.category, result.value.sourcePath].filter(Boolean).join(" · ");
            return (
              <button
                key={`${result.kind}:${result.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(result)}
              >
                <span className="result-kind">{t(`search.kind.${result.kind}`)}</span>
                <span><strong>{title}</strong><small>{meta || t("app.uncategorized")}</small></span>
                {result.date && <time>{result.date}</time>}
              </button>
            );
          })}
        </div>
        <footer>{t("search.help")}</footer>
      </section>
    </div>
  );
}

function Empty({ text, hint, actionLabel, onAction }: { text: string; hint?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="empty">
      <span>{text}</span>
      {hint && <small className="empty-hint">{hint}</small>}
      {actionLabel && onAction && (
        <button className="secondary-button empty-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}
