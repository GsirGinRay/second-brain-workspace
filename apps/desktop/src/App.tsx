import {
  DEFAULT_ARCHITECTURE_PACK_IDS,
  LEGACY_TEMPLATES_DIR,
  activeVaultLayout,
  managedTemplateDirs,
  templatePacks,
  buildOutcomeKnowledgeDraft,
  collectionToPrompt,
  completeProject,
  createDefaultRoutineTemplate,
  enforceTemplateSingleP1,
  hintsForLayoutMigration,
  knowledgeFilterCategories,
  layoutMigrationHasWork,
  parsePluginExport,
  planVaultLayoutMigration,
  promptToCollection,
  relatedKnowledgeForProject,
  renderPluginExport,
  type BrainCollectionSnapshot,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type LayoutMigrationPlan,
  type RoutineTemplate,
  type TemplatePackId,
} from "@second-brain/brain-core";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Columns3,
  FolderKanban,
  Home,
  Keyboard,
  Library,
  Menu,
  Moon,
  Plus,
  Redo2,
  Search,
  Settings2,
  Sun,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UiPreferencesContext, VIEW_KEYS, VIEW_TITLE_KEYS, describeError, newTask, taipeiDateKey, type DetailTarget, type Translate, type View } from "./app-shared";
import { APP_VERSION } from "./app-version";
import { AI_HANDOFF_PATHS, VAULT_INDEX_PATH, VAULT_INSTRUCTIONS_PATH, decodeBase64, renderIndexChange, scaffoldArchitectureChanges, writeBackUpgradeChange } from "./architecture";
import appLogo from "./assets/app-logo.png";
import { AttachmentProvider, createAttachmentApi } from "./attachment-context";
import { Board } from "./board-page";
import { Calendar } from "./calendar-page";
import { Collections } from "./collections-page";
import { CreateEntityModal } from "./create-entity-modal";
import { ActionConfirmDialog } from "./danger-confirm";
import { hasDraftContent, loadDraftWorkspace, saveDraftWorkspace } from "./draft-workspace";
import {
  ProjectDetailDialog,
  TaskDetailDialog,
  type DetailTab,
} from "./entity-detail-dialog";
import { GlobalShiftMarquee } from "./global-shift-marquee";
import { applyInboxItems } from "./inbox-relay";
import { InboxRelaySettingsCard, useInboxRelay, useTodaySnapshot } from "./inbox-relay-ui";
import {
  createNativeAdapter,
  type AppUpdateCheck,
  type DiagnosticsSnapshot,
  type NativeAdapter,
} from "./ipc";
import { Projects } from "./projects-page";
import { QuickAddModal } from "./quick-add-modal";
import { closedProjectIds, withRecurringFollowUps } from "./recurring-tasks";
import { loadReminderSettings, saveReminderSettings, type ReminderSettings } from "./reminders";
import { ReminderSettingsCard, useReminders } from "./reminders-ui";
import { SyncSettings } from "./settings-page";
import { ShortcutsDialog, isShortcutHelpKey } from "./shortcuts-help";
import "./styles.css";
import {
  isEditableElement,
  isQuickAddShortcut,
  markMostImportant,
} from "./task-actions";
import { Today } from "./today-page";
import {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_KEY,
  normalizeUiPreferences,
  translate,
  type UiPreferences,
} from "./ui-preferences";
import {
  applyRedo,
  applyUndo,
  emptyUndoState,
  recordUndo,
  type UndoState,
  type WorkspaceSnapshot,
} from "./undo-history";
import {
  applyDesiredSnapshot,
  buildCollectionCreateChange,
  buildLayoutMigrationChanges,
  buildProjectCreateChange,
  buildProjectDeleteChanges,
  withRelatedProjectWikilink,
  type LocalMarkdownFile,
  type MarkdownChange,
} from "./vault";
import { VaultLoader } from "./vault-loader";
import { emptyViewHistory, goBack, goForward, navigateTo, type ViewHistory } from "./view-history";
import { UpdateNotice, consumeUpdateNotice } from "./whats-new";
import { rebaseWorkspace } from "./workspace-rebase";
import { WorkspaceSearch } from "./workspace-search";
export { BOARD_VIEW_KEY, Board } from "./board-page";
export { Calendar } from "./calendar-page";
export { CollectionEditor, Collections } from "./collections-page";
export { CreateEntityModal } from "./create-entity-modal";
export { PROJECT_VIEW_KEY, Projects } from "./projects-page";
export { QuickAddModal } from "./quick-add-modal";
export { SyncSettings } from "./settings-page";
export { Today } from "./today-page";
export { WorkspaceSearch } from "./workspace-search";

function ViewIcon({ view }: { view: View }) {
  const className = "nav-icon";
  if (view === "today") return <Home className={className} />;
  if (view === "calendar") return <CalendarDays className={className} />;
  if (view === "board") return <Columns3 className={className} />;
  if (view === "projects") return <FolderKanban className={className} />;
  if (view === "collections") return <Library className={className} />;
  return <Settings2 className={className} />;
}

const UPDATE_DISMISSED_KEY = "second-brain.dismissedUpdateVersion";

const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

function loadUiPreferences(): UiPreferences {
  try {
    return normalizeUiPreferences(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) ?? "null"));
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function App({ adapter: providedAdapter }: { adapter?: NativeAdapter }) {
  const initialDraft = useMemo(() => loadDraftWorkspace(), []);
  const native = useMemo(
    () => providedAdapter ?? createNativeAdapter(),
    [providedAdapter],
  );
  const attachmentApi = useMemo(() => createAttachmentApi(native), [native]);
  const [viewHistory, setViewHistory] = useState<ViewHistory<View>>(() => emptyViewHistory<View>("today"));
  const view = viewHistory.current;
  const setView = useCallback((next: View) => setViewHistory((history) => navigateTo(history, next)), []);
  const goBackView = useCallback(() => setViewHistory(goBack), []);
  const goForwardView = useCallback(() => setViewHistory(goForward), []);
  const previousView = viewHistory.back.at(-1) ?? null;
  const nextView = viewHistory.forward[0] ?? null;
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const t = useCallback<Translate>(
    (key, values) => translate(preferences.language, key, values),
    [preferences.language],
  );
  // An empty vault gets folders named in the interface language.
  const languageRef = useRef(preferences.language);
  languageRef.current = preferences.language;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(
    () => localStorage.getItem("second-brain.showCompletedTasks") === "true",
  );
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(
    null,
  );
  const [vaultInput, setVaultInput] = useState("");
  const [tasks, setTasks] = useState<BrainTaskSnapshot[]>(initialDraft.tasks);
  const [projects, setProjects] = useState<BrainProjectSnapshot[]>(initialDraft.projects);
  const [collections, setCollections] = useState<BrainCollectionSnapshot[]>(initialDraft.collections);
  const [onboardingOpen, setOnboardingOpen] = useState(() => localStorage.getItem("second-brain.onboardingCompleted") !== "true");
  // Read before onboarding writes its flag, so only real updates are announced.
  const [updateNoticeOpen, setUpdateNoticeOpen] = useState(() => !providedAdapter && consumeUpdateNotice(localStorage, APP_VERSION));
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [reminderSettings, setReminderSettings] = useState(() => loadReminderSettings(localStorage));
  const changeReminderSettings = useCallback((next: ReminderSettings) => {
    setReminderSettings(next);
    saveReminderSettings(localStorage, next);
  }, []);
  const [selectedBoardProjectId, setSelectedBoardProjectId] = useState<string | null>(null);
  const [pendingCompleteProjectId, setPendingCompleteProjectId] = useState<string | null>(null);
  const [revealProjectList, setRevealProjectList] = useState<{ tab: "current" | "completed" | "archived"; token: number }>({
    tab: "current",
    token: 0,
  });
  const [detailTargets, setDetailTargets] = useState<DetailTarget[]>([]);
  const [activeDetailKey, setActiveDetailKey] = useState<string | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [createEntity, setCreateEntity] = useState<"project" | "collection" | null>(null);
  const [promotedTask, setPromotedTask] = useState<BrainTaskSnapshot | null>(null);
  const [knowledgeSeed, setKnowledgeSeed] = useState<{
    name: string;
    body: string;
    projectId: string | null;
    category: string;
  } | null>(null);
  const [routineTemplate, setRoutineTemplate] = useState<RoutineTemplate>(() => createDefaultRoutineTemplate(crypto.randomUUID()));
  const [files, setFiles] = useState<LocalMarkdownFile[]>([]);
  const [status, setStatus] = useState("正在啟動…");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [selectedPacks, setSelectedPacks] = useState<TemplatePackId[]>([
    ...DEFAULT_ARCHITECTURE_PACK_IDS,
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
  const [pendingLayoutPlan, setPendingLayoutPlan] = useState<LayoutMigrationPlan | null>(null);
  const [pendingLayoutFiles, setPendingLayoutFiles] = useState<LocalMarkdownFile[] | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheck | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);

  const promptCollections = collections.filter((item) =>
    (item.category ?? "").trim().toLowerCase().startsWith("提示詞"),
  );
  const activeDetail = detailTargets.find((target) => target.key === activeDetailKey) ?? null;
  const selectedTask = activeDetail?.kind === "task" ? tasks.find((task) => task.id === activeDetail.id) ?? null : null;
  const selectedProjectDetail = activeDetail?.kind === "project" ? projects.find((project) => project.id === activeDetail.id) ?? null : null;
  const pendingCompleteProject = pendingCompleteProjectId
    ? projects.find((project) => project.id === pendingCompleteProjectId) ?? null
    : null;
  const pendingCompleteOpenCount = pendingCompleteProject
    ? tasks.filter((task) => task.projectId === pendingCompleteProject.id && task.status !== "done").length
    : 0;
  const detailTabs: DetailTab[] = detailTargets.flatMap((target) => {
    const title = target.kind === "task"
      ? tasks.find((task) => task.id === target.id)?.title
      : projects.find((project) => project.id === target.id)?.name;
    return title ? [{ key: target.key, kind: target.kind, title }] : [];
  });
  const openDetail = (kind: DetailTarget["kind"], id: string) => {
    const key = `${kind}:${id}`;
    setDetailTargets((current) => current.some((target) => target.key === key) ? current : [...current, { key, kind, id }]);
    setActiveDetailKey(key);
  };
  const closeDetail = (key: string) => {
    const index = detailTargets.findIndex((target) => target.key === key);
    const next = detailTargets.filter((target) => target.key !== key);
    setDetailTargets(next);
    if (activeDetailKey === key) setActiveDetailKey(next[Math.min(Math.max(index, 0), next.length - 1)]?.key ?? null);
  };
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
  // Serialize every local write. A multi-task drag followed quickly by
  // another drag (or any other onSave) would otherwise dispatch two writes
  // against the same stale `files` snapshot, where the second one trips
  // HashPrecondition because the first has already moved the file. The
  // promise chain makes the second call wait for the first to finish, then
  // re-reads `files` and `tasks` against the freshest state.
  const pendingPersistRef = useRef<Promise<boolean> | null>(null);
  // Saves queued or running. The screen shows their result before it is on
  // disk, so a reload must not put the older disk state back meanwhile.
  const pendingWritesRef = useRef(0);
  // Bumped whenever one of those saves finishes. A reload that started
  // before then may have scanned the disk before that write.
  const writeGenerationRef = useRef(0);
  // The last disk state put on screen, to fall back on when a failed save
  // cannot re-read the disk.
  const lastAppliedRef = useRef<WorkspaceSnapshot | null>(null);
  const reloadLocalRef = useRef<((updateStatus?: boolean) => Promise<unknown>) | null>(null);
  // `files` is a React state, which means a second onSave chained on the
  // first still reads the *pre-first-write* array. Mirror the latest scan
  // into a ref so chained writes always see the freshest file hashes without
  // waiting for a React re-render between them.
  const latestFilesRef = useRef<LocalMarkdownFile[]>([]);
  useEffect(() => { latestFilesRef.current = files; }, [files]);
  const notifyReminder = useMemo(
    () => native.showReminder ? (title: string, body: string) => native.showReminder!(title, body) : undefined,
    [native],
  );
  const remindersFailing = useReminders({ tasks, settings: reminderSettings, language: preferences.language, notify: notifyReminder });
  useEffect(() => {
    if (remindersFailing) setError(t("reminders.failing"));
  }, [remindersFailing]);
  // Phone items land in the inbox only once a vault is open; until then they
  // wait on the native side (and on the relay) without being acknowledged.
  useInboxRelay({
    api: native.inboxRelay,
    ready: Boolean(diagnostics?.selectedVault),
    write: (items) => persistLocal(applyInboxItems(tasks, items, taipeiDateKey(), projects)),
    onReceived: (items) => {
      const completed = items.filter((item) => item.action === "complete").length;
      const changed = items.filter((item) => item.action === "reschedule" || item.action === "focus").length;
      const added = items.length - completed - changed;
      const body = [
        added > 0 ? t("inboxRelay.received", { count: added }) : "",
        completed > 0 ? t("inboxRelay.completed", { count: completed }) : "",
        changed > 0 ? t("inboxRelay.changed", { count: changed }) : "",
      ].filter(Boolean).join("\n");
      void notifyReminder?.(t("inboxRelay.title"), body).catch(() => undefined);
    },
  });
  // Paid members also get today's list on the phone, refreshed as tasks change.
  useTodaySnapshot({
    api: native.inboxRelay,
    ready: Boolean(diagnostics?.selectedVault),
    tasks,
    projects,
    todayKey: taipeiDateKey,
  });
  const checkAppUpdate = useCallback(async (promptIfAvailable = false, showBusy = false) => {
    if (!native.checkAppUpdate) return;
    if (showBusy) setUpdateBusy(true);
    try {
      const status = await native.checkAppUpdate();
      setAppUpdate(status);
      if (promptIfAvailable && status.available) {
        const dismissed = localStorage.getItem(UPDATE_DISMISSED_KEY);
        if (dismissed !== status.latestVersion) setUpdatePromptOpen(true);
      }
    } catch {
      setAppUpdate((current) => current
        ? { ...current, available: false, checked: false }
        : current);
    } finally {
      if (showBusy) setUpdateBusy(false);
    }
  }, [native]);
  // Check at launch and again every few hours: the app often stays open for days.
  useEffect(() => {
    void checkAppUpdate(true);
    const timer = window.setInterval(() => void checkAppUpdate(true), UPDATE_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [checkAppUpdate]);
  const installAppUpdate = useCallback(async () => {
    if (!appUpdate?.available) return;
    setUpdateBusy(true);
    setError("");
    try {
      // Installing exits the app, so close detail views (their unmount flushes
      // pending autosaves) and wait for every queued Markdown write first.
      setDetailTargets([]);
      setActiveDetailKey(null);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      await (pendingPersistRef.current ?? Promise.resolve(true));
      // Native code downloads, verifies the signature, installs and restarts.
      await native.installAppUpdate?.();
    } catch (cause) {
      setError(`${t("update.failed")}：${describeError(cause, "UPDATE_FAILED")}`);
    } finally {
      setUpdateBusy(false);
    }
  }, [appUpdate, native, t]);
  const dismissAppUpdate = useCallback(() => {
    if (appUpdate?.latestVersion) localStorage.setItem(UPDATE_DISMISSED_KEY, appUpdate.latestVersion);
    setUpdatePromptOpen(false);
  }, [appUpdate?.latestVersion]);
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
      allowCloseRef.current = false;
      setCloseGuardOpen(false);
    }
  }

  useEffect(() => {
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(preferences));
    document.documentElement.lang = preferences.language;
    document.documentElement.dataset.theme = preferences.theme;
    delete document.documentElement.dataset.density;
  }, [preferences]);

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
      } else if (isShortcutHelpKey(event, isEditableElement(event.target), Boolean(document.querySelector("[aria-modal='true']")))) {
        event.preventDefault();
        setShortcutsOpen(true);
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
        existingPaths?: readonly string[];
      },
      enabled: boolean,
    ) => {
      if (!enabled) return;
      try {
        // Missing .ai/INDEX.md reads as an IPC error; fall back to "not created
        // yet" so the background refresh can create the initial index.
        const existingFiles = await native
          .readMarkdownFiles([VAULT_INDEX_PATH])
          .catch(() => []);
        const change = renderIndexChange(
          {
            today: taipeiDateKey(),
            generatedAt: new Date().toISOString(),
            tasks: local.tasks,
            projects: local.projects,
            collections: local.collections ?? [],
            existingPaths: local.existingPaths ?? [],
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
        const paths: string[] = [];
        for (const folder of managedTemplateDirs()) {
          try {
            paths.push(...(await native.listManagedFiles(folder)));
          } catch {
            // New or legacy template folder may be absent.
          }
        }
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

  const finishOnboarding = () => {
    localStorage.setItem("second-brain.onboardingCompleted", "true");
    setOnboardingOpen(false);
  };

  const prepareArchitecture = async (
    loaded?: {
      files: LocalMarkdownFile[];
      tasks: BrainTaskSnapshot[];
      projects: BrainProjectSnapshot[];
      collections: BrainCollectionSnapshot[];
    },
    options: { samples?: boolean; packs?: readonly TemplatePackId[] } = {},
  ) => {
    setWorking(true);
    setError("");
    try {
      const existingFiles = loaded?.files ?? files;
      const existingTasks = loaded?.tasks ?? tasks;
      const existingProjects = loaded?.projects ?? projects;
      const existingCollections = loaded?.collections ?? collections;
      const packs = options.packs ?? selectedPacks;
      // The scan skips .ai/ and the root entry files; read them so existing
      // ones are kept and an older INSTRUCTIONS.md only gets the write-back rules.
      const handoffFiles: LocalMarkdownFile[] = [];
      for (const path of AI_HANDOFF_PATHS) {
        const found = await native.readMarkdownFiles([path]).catch(() => []);
        handoffFiles.push(...found);
      }
      const changes = scaffoldArchitectureChanges(
        [...existingFiles, ...handoffFiles].map((file) => file.relativePath),
        packs,
        { today: taipeiDateKey(), samples: options.samples === true },
      );
      if (packs.includes("ai")) {
        const upgrade = writeBackUpgradeChange(
          handoffFiles.find((file) => file.relativePath.replace(/\\/g, "/") === VAULT_INSTRUCTIONS_PATH),
        );
        if (upgrade) changes.push(upgrade);
      }
      // A brand-new vault has no .ai/INDEX.md yet; treat the failed read as
      // "not created" so scaffolding (whose job is to create it) can proceed.
      const existingPaths = existingFiles.map((file) => file.relativePath);
      const existingIndex = await native
        .readMarkdownFiles([VAULT_INDEX_PATH])
        .catch(() => []);
      const indexChange = renderIndexChange(
        {
          today: taipeiDateKey(),
          generatedAt: new Date().toISOString(),
          tasks: existingTasks,
          projects: existingProjects,
          collections: existingCollections,
          existingPaths,
        },
        existingIndex[0],
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
        (change) => change.relativePath !== VAULT_INDEX_PATH,
      );
      const existingIndex = await native
        .readMarkdownFiles([VAULT_INDEX_PATH])
        .catch(() => []);
      const indexChange = renderIndexChange(
        {
          today: taipeiDateKey(),
          generatedAt: new Date().toISOString(),
          tasks,
          projects,
          collections,
          existingPaths: files.map((file) => file.relativePath),
        },
        existingIndex[0],
      );
      if (indexChange) changes.push(indexChange);
      if (changes.length === 0) {
        setStatus("知識架構已存在，未覆寫任何既有檔案");
        return;
      }
      const teachFirstRun = pendingScaffold.some((change) =>
        /開始使用|待辦收件匣|Getting Started/.test(change.relativePath),
      );
      await native.applyMarkdownChanges(changes);
      await reloadLocal();
      setStatus(teachFirstRun ? "示範內容已建立，可直接改名或刪除" : "知識架構已建立");
    } catch (cause) {
      setError(`建立知識架構失敗：${describeError(cause, "SCAFFOLD_FAILED")}`);
    } finally {
      setPendingScaffold(null);
      setScaffoldPreviewPaths([]);
      setWorking(false);
    }
  };

  const prepareLayoutMigration = async () => {
    if (!diagnostics?.selectedVault) {
      setError(t("layout.needFolder"));
      return;
    }
    // The legacy migrator targets the Chinese layout; English vaults are
    // created in their final layout and their Projects/ is not legacy.
    if (activeVaultLayout().locale === "en") {
      setStatus(t("layout.empty"));
      return;
    }
    setWorking(true);
    setError("");
    try {
      const extraFiles: LocalMarkdownFile[] = [];
      if (native.listManagedFiles) {
        try {
          const listed = await native.listManagedFiles(LEGACY_TEMPLATES_DIR);
          const known = new Set(files.map((file) => file.relativePath.replace(/\\/g, "/").toLocaleLowerCase()));
          const unread = listed.filter((path) => !known.has(path.replace(/\\/g, "/").toLocaleLowerCase()));
          if (unread.length) extraFiles.push(...await native.readMarkdownFiles(unread));
        } catch {
          // Legacy template folder may be absent.
        }
      }
      const allFiles = [...files, ...extraFiles];
      const plan = planVaultLayoutMigration(
        hintsForLayoutMigration(
          allFiles.map((file) => file.relativePath),
          projects,
          collections,
        ),
      );
      if (!layoutMigrationHasWork(plan)) {
        setStatus(t("layout.empty"));
        return;
      }
      setPendingLayoutFiles(allFiles);
      setPendingLayoutPlan(plan);
    } catch (cause) {
      setError(`準備整理失敗：${describeError(cause, "LAYOUT_PREP_FAILED")}`);
    } finally {
      setWorking(false);
    }
  };

  const confirmLayoutMigration = async () => {
    if (!pendingLayoutPlan || !pendingLayoutFiles) return;
    setWorking(true);
    setError("");
    try {
      const changes = buildLayoutMigrationChanges(pendingLayoutFiles, pendingLayoutPlan);
      if (changes.length === 0) {
        setStatus(t("layout.none"));
        return;
      }
      await native.applyMarkdownChanges(changes);
      await reloadLocal();
      setStatus(t("layout.done"));
    } catch (cause) {
      setError(`整理資料夾失敗：${describeError(cause, "LAYOUT_FAILED")}`);
    } finally {
      setPendingLayoutPlan(null);
      setPendingLayoutFiles(null);
      setWorking(false);
    }
  };

  const reloadLocal = useCallback(
    async (updateStatus = true, applyState = true, ownWrite = false) => {
      const generation = writeGenerationRef.current;
      const nextDiagnostics = await native.getDiagnostics();
      setDiagnostics(nextDiagnostics);
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
      const loader = new VaultLoader(native, languageRef.current);
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
      if (!applyState) return local;
      // The save that just wrote may apply what it wrote; any other queued
      // save would have its edit blink away until its own write lands. The
      // last save to finish applies the disk state.
      const queuedSaves = pendingWritesRef.current > (ownWrite ? 1 : 0);
      if (queuedSaves || (!ownWrite && generation !== writeGenerationRef.current)) {
        lastScanRef.current = null;
        // Held only because a save finished mid-read: nothing queued will
        // apply the disk later (a sync write may be in it), so read again.
        if (!queuedSaves && pendingWritesRef.current === 0) {
          queueMicrotask(() => void reloadLocalRef.current?.(false).catch(() => undefined));
        }
        return local;
      }
      if (unchanged && !updateStatus) return local;
      setFiles(local.files);
      setTasks(local.tasks);
      setProjects(local.projects);
      setCollections(local.collections ?? []);
      lastAppliedRef.current = { tasks: local.tasks, projects: local.projects, collections: local.collections ?? [] };
      if (nextDiagnostics.selectedVault) {
        void refreshAiIndex(
          {
            tasks: local.tasks,
            projects: local.projects,
            collections: local.collections ?? [],
            existingPaths: local.files.map((file) => file.relativePath),
          },
          true,
        );
        void loadTemplates(true);
      }
      if (updateStatus)
        setStatus(
          `已載入 ${local.tasks.length} 項任務 · ${local.projects.length} 個專案 · ${local.collections.length} 篇知識`,
        );
      return local;
    },
    [native, refreshAiIndex, loadTemplates],
  );
  reloadLocalRef.current = reloadLocal;

  const startWithFolder = async () => {
    const ok = await browseVault();
    if (!ok) return;
    finishOnboarding();
    const local = await reloadLocal();
    if (local) await prepareArchitecture(local, { samples: true, packs: [] });
  };

  useEffect(() => {
    void reloadLocal().catch((cause) => {
      const message =
        describeError(cause, "DIAGNOSTICS_FAILED");
      setError(`App 啟動診斷失敗：${message}`);
    });
  }, [reloadLocal]);

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

  // Ctrl+Alt+N from any program: the native side brings the window forward
  // and asks for the quick-add window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("quick-capture", () => {
        // One capture window at a time (the calendar has its own).
        if (document.querySelector(".quick-add-modal")) return;
        // Detail views sit above the capture window; closing them flushes
        // their autosave first, as installing an update does.
        setDetailTargets([]);
        setActiveDetailKey(null);
        setQuickAddOpen(true);
      }))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Alt+←/→ and the mouse side buttons step through visited views, like a browser.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Board cards use Alt+←/→ to move between lanes and mark the event handled.
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      // Leaving a view unmounts its open capture form, so never navigate while typing or in a dialog.
      if (isEditableElement(event.target) || document.querySelector("[aria-modal='true']")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goBackView();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goForwardView();
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if ((event.button === 3 || event.button === 4) && document.querySelector("[aria-modal='true']")) return;
      if (event.button === 3) {
        event.preventDefault();
        goBackView();
      } else if (event.button === 4) {
        event.preventDefault();
        goForwardView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [goBackView, goForwardView]);

  useEffect(() => {
    let debounce: number | undefined;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("vault-changed", () => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(() => void reloadLocal(false), 3_000);
        }),
      )
      .then((value) => {
        unlisten = value;
      });
    return () => {
      unlisten?.();
      window.clearTimeout(debounce);
    };
  }, [reloadLocal]);

  // Every mutation that reaches Markdown funnels through persistLocal, so recording
  // the pre-change workspace here gives one undo history that covers schedule drags,
  // calendar date drops, board lane moves, inline edits and deletions alike.
  const undoRef = useRef<UndoState>(emptyUndoState());
  const [undoCounts, setUndoCounts] = useState({ undo: 0, redo: 0 });
  const syncUndoCounts = () =>
    setUndoCounts({ undo: undoRef.current.past.length, redo: undoRef.current.future.length });

  async function applyPersistLocal(
    requestedTasks: BrainTaskSnapshot[],
    requestedProjects = projects,
    requestedCollections = collections,
    /** What the caller's arrays were derived from; rebases them onto the vault as it is now. */
    callerBase?: WorkspaceSnapshot,
    onLatest?: (latest: WorkspaceSnapshot) => void,
  ): Promise<boolean> {
    let nextTasks = requestedTasks;
    let nextProjects = requestedProjects;
    let nextCollections = requestedCollections;
    // Writes are chained, but each caller computed its arrays from the render it
    // ran in. Re-derive them from the latest scan so a write prepared before an
    // earlier one landed (autosave, quick add, list stars) cannot revert it.
    const rebaseOnto = (latest: WorkspaceSnapshot) => {
      if (!callerBase) return;
      const rebased = rebaseWorkspace(
        callerBase,
        { tasks: requestedTasks, projects: requestedProjects, collections: requestedCollections },
        latest,
      );
      nextTasks = rebased.tasks;
      nextProjects = rebased.projects;
      nextCollections = rebased.collections;
    };
    // Every completion path saves through here, so repeating tasks get their
    // next occurrence whichever view completed them. "Was it open before?" is
    // judged against the vault as it is now, so two saves prepared from the
    // same stale render cannot each add a copy.
    const addFollowUps = (before: readonly BrainTaskSnapshot[]) => {
      nextTasks = withRecurringFollowUps(before, nextTasks, taipeiDateKey(), {
        closedProjectIds: closedProjectIds(nextProjects),
      });
    };
    if (!diagnostics?.selectedVault) {
      addFollowUps(callerBase?.tasks ?? tasks);
      saveDraftWorkspace({ tasks: nextTasks, projects: nextProjects, collections: nextCollections });
      setTasks(nextTasks);
      setProjects(nextProjects);
      setCollections(nextCollections);
      setStatus("已暫存在這台裝置；關閉前請選擇 Markdown 資料夾");
      return true;
    }
    // Always re-read the file snapshot right before computing the diff so
    // chained writes (e.g. dragging multiple groups in quick succession)
    // never trip HashPrecondition on a file a previous batch has already
    // touched but `files` has not yet picked up. We mirror the latest scan
    // into a ref so a quick second drag reads the post-first-write hashes
    // even before React has had a chance to re-render.
    const snapshot = await reloadLocal(false, false);
    if (snapshot?.files) latestFilesRef.current = snapshot.files;
    // The scan of currentFiles, so the diff can skip records it already matches.
    let scannedBase: { tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; collections: BrainCollectionSnapshot[] } | undefined;
    if (snapshot) {
      const latest = { tasks: snapshot.tasks, projects: snapshot.projects, collections: snapshot.collections ?? [] };
      scannedBase = latest;
      onLatest?.(latest);
      rebaseOnto(latest);
      addFollowUps(latest.tasks);
    } else {
      addFollowUps(callerBase?.tasks ?? tasks);
    }
    const currentFiles = snapshot?.files ?? latestFilesRef.current;
    const changes = applyDesiredSnapshot(currentFiles, {
      schemaVersion: 6,
      tasks: nextTasks,
      projects: nextProjects,
      collections: nextCollections,
      fileHashes: {},
    }, scannedBase);
    if (changes.length === 0) {
      setTasks(nextTasks);
      setProjects(nextProjects);
      setCollections(nextCollections);
      // An earlier save held back its reload for this one; apply it now so
      // the file list and AI index catch up too.
      if (lastScanRef.current === null) await reloadLocal(false, true, true).catch(() => undefined);
      return true;
    }
    setWorking(true);
    setError("");
    try {
      await native.applyMarkdownChanges(changes);
      setStatus("已寫入本機 Markdown 資料夾");
      await reloadLocal(true, true, true);
      return true;
    } catch (cause) {
      const message = describeError(cause, "WRITE_FAILED");
      // A concurrent writer (the web adapter or another editor) can move a file between our scan and the write. Re-scan once
      // and re-apply the diff so the user's calendar edit still lands instead
      // of being silently dropped.
      if (/changed before write|HASH_PRECONDITION/i.test(message)) {
        try {
          const fresh = await reloadLocal(true, true, true);
          if (fresh && fresh.files.length > 0) {
            rebaseOnto({ tasks: fresh.tasks, projects: fresh.projects, collections: fresh.collections ?? [] });
            addFollowUps(fresh.tasks);
            const retryChanges = applyDesiredSnapshot(fresh.files, {
              schemaVersion: 6,
              tasks: nextTasks,
              projects: nextProjects,
              collections: nextCollections,
              fileHashes: {},
            }, { tasks: fresh.tasks, projects: fresh.projects, collections: fresh.collections ?? [] });
            if (retryChanges.length > 0) {
              await native.applyMarkdownChanges(retryChanges);
              setStatus("已寫入本機 Markdown 資料夾");
              await reloadLocal(true, true, true);
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

  async function persistLocal(
    nextTasks: BrainTaskSnapshot[],
    nextProjects = projects,
    nextCollections = collections,
  ): Promise<boolean> {
    const callerBase: WorkspaceSnapshot = { tasks, projects, collections };
    // Undo returns to what was really on disk before this write, not to the
    // possibly stale render the caller started from.
    let previous = callerBase;
    // Chain on the previous write so two rapid drags don't race on the same
    // pre-write `files` snapshot. The later call sees the freshly persisted
    // state by the time it actually runs.
    // Show the edit now and write it in the background: on a large vault the
    // write and re-read take a moment, and the screen should not wait on it.
    if (diagnostics?.selectedVault) {
      setTasks(nextTasks);
      setProjects(nextProjects);
      setCollections(nextCollections);
    }
    pendingWritesRef.current += 1;
    const tail = pendingPersistRef.current ?? Promise.resolve(true);
    const next = tail.catch(() => true).then(() => applyPersistLocal(
      nextTasks,
      nextProjects,
      nextCollections,
      callerBase,
      (latest) => { previous = latest; },
    )).finally(() => {
      pendingWritesRef.current -= 1;
      writeGenerationRef.current += 1;
    });
    pendingPersistRef.current = next;
    let ok = false;
    try {
      ok = await next;
    } catch (cause) {
      // The scan before the write can fail too (a file removed mid-read, a
      // copied project file); the edit is already on screen, so say so.
      setError(`本機寫入失敗：${describeError(cause, "WRITE_FAILED")}`);
    }
    if (!ok) {
      // The edit is on screen but not on disk: show the disk again, or at
      // least the state before this edit if the disk cannot be read.
      lastScanRef.current = null;
      void reloadLocal(false).catch(() => {
        if (pendingWritesRef.current > 0) return;
        // `previous` may hold an earlier save that failed the same way.
        const fallback = lastAppliedRef.current ?? previous;
        setTasks(fallback.tasks);
        setProjects(fallback.projects);
        setCollections(fallback.collections);
      });
      return false;
    }
    if (ok) {
      undoRef.current = recordUndo(undoRef.current, previous);
      syncUndoCounts();
    }
    return ok;
  }

  // Writes that build their own Markdown changes (create/delete) queue behind
  // pending saves and compute those changes from the vault as it is after
  // them, never from a render that an autosave has already overtaken.
  async function queuedVaultWrite(
    build: (current: WorkspaceSnapshot & { files: LocalMarkdownFile[] }) => MarkdownChange[],
  ): Promise<void> {
    const tail = pendingPersistRef.current ?? Promise.resolve(true);
    const run = tail.catch(() => true).then(async () => {
      const scan = await reloadLocal(false, false);
      if (scan?.files) latestFilesRef.current = scan.files;
      const current = scan
        ? { files: scan.files, tasks: scan.tasks, projects: scan.projects, collections: scan.collections ?? [] }
        : { files: latestFilesRef.current, tasks, projects, collections };
      const changes = build(current);
      if (changes.length > 0) {
        await native.applyMarkdownChanges(changes);
        await reloadLocal();
      }
      return true;
    });
    pendingPersistRef.current = run;
    await run;
  }

  function requestCompleteProject(projectId: string) {
    setPendingCompleteProjectId(projectId);
  }

  function revealProjectListTab(tab: "current" | "completed" | "archived") {
    setRevealProjectList((current) => ({ tab, token: current.token + 1 }));
  }

  async function finishCompleteProject(project: BrainProjectSnapshot): Promise<void> {
    const completed = completeProject(project, tasks, taipeiDateKey());
    const ok = await persistLocal(
      completed.tasks,
      projects.map((item) => item.id === project.id ? completed.project : item),
    );
    if (!ok) return;
    setPendingCompleteProjectId(null);
    if (project.id) closeDetail(`project:${project.id}`);
    if (view === "board" && selectedBoardProjectId === project.id) {
      setSelectedBoardProjectId(null);
      setView("projects");
      revealProjectListTab("completed");
    } else if (view === "projects") {
      revealProjectListTab("completed");
    }
    setStatus(t("project.complete.done", { name: project.name }));
  }

  async function finishReopenProject(project: BrainProjectSnapshot): Promise<void> {
    const ok = await persistLocal(
      tasks,
      projects.map((item) => item.id === project.id
        ? { ...item, status: "active", completedAt: null, focusToday: false }
        : item),
    );
    if (!ok) return;
    if (view === "projects") revealProjectListTab("current");
  }

  async function finishArchiveProject(project: BrainProjectSnapshot): Promise<void> {
    const ok = await persistLocal(
      tasks,
      projects.map((item) => item.id === project.id
        ? { ...item, status: "archived", focusToday: false }
        : item),
    );
    if (!ok) return;
    if (view === "projects") revealProjectListTab("archived");
  }

  // Plain functions (not memoised): applyPersistLocal closes over the latest vault
  // scan/files each render, so restoring must always call the current instance.
  function restoreWorkspace(snapshot: WorkspaceSnapshot, message: string): void {
    // Queue behind pending saves and revert only what this undo step changed:
    // the current render is the base, so edits that landed since are kept.
    const callerBase: WorkspaceSnapshot = { tasks, projects, collections };
    pendingWritesRef.current += 1;
    const tail = pendingPersistRef.current ?? Promise.resolve(true);
    const run = tail.catch(() => true).then(() =>
      applyPersistLocal(snapshot.tasks, snapshot.projects, snapshot.collections, callerBase))
      .finally(() => {
        pendingWritesRef.current -= 1;
        writeGenerationRef.current += 1;
      });
    pendingPersistRef.current = run;
    void run.then((ok) => {
      if (ok) setStatus(message);
    });
  }

  // The screen already shows saves that are still being written, but they
  // join the undo history only once written. Undoing in between would revert
  // them too and drop the redo step, so it waits for them instead.
  function savesStillWriting(): boolean {
    if (pendingWritesRef.current === 0) return false;
    setStatus(preferences.language === "zh-TW" ? "正在儲存，存好後再按一次即可復原" : "Still saving; try again in a moment");
    return true;
  }

  function performUndo() {
    if (savesStillWriting()) return;
    const result = applyUndo(undoRef.current, { tasks, projects, collections });
    if (!result.snapshot) return;
    undoRef.current = result.next;
    syncUndoCounts();
    restoreWorkspace(result.snapshot, preferences.language === "zh-TW" ? "已復原上一個變更（Ctrl+Shift+Z 可重做）" : "Undone (Ctrl+Shift+Z to redo)");
  }

  function performRedo() {
    if (savesStillWriting()) return;
    const result = applyRedo(undoRef.current, { tasks, projects, collections });
    if (!result.snapshot) return;
    undoRef.current = result.next;
    syncUndoCounts();
    restoreWorkspace(result.snapshot, preferences.language === "zh-TW" ? "已重做變更" : "Change reapplied");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      if (event.defaultPrevented || isEditableElement(event.target)) return;
      event.preventDefault();
      if (event.shiftKey) performRedo();
      else performUndo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function createProject(
    name: string,
    area: string | null,
    priority: number | null,
    promotedTask?: BrainTaskSnapshot,
    body = "",
  ): Promise<{ id: string; name: string } | null> {
    const id = crypto.randomUUID();
    if (!diagnostics?.selectedVault) {
      const project: BrainProjectSnapshot = { schemaVersion: 6, id, name: name.trim(), sourcePath: null, status: "planning", area, priority, progress: 0, focusToday: false, startDate: null, endDate: null, completedAt: null, body };
      const nextProjects = [...projects, project];
      const nextTasks = promotedTask ? tasks.map((task) => task.id === promotedTask.id ? { ...task, projectId: id, projectName: name.trim() } : task) : tasks;
      await persistLocal(nextTasks, nextProjects);
      setStatus(promotedTask ? "想法已升級為規劃中專案草稿" : "已建立規劃中專案草稿");
      return { id, name: name.trim() };
    }
    setWorking(true);
    setError("");
    try {
      await queuedVaultWrite((current) => {
        const create = buildProjectCreateChange(name, area, priority, current.files.map((file) => file.relativePath), () => id, body);
        if (!promotedTask) return [create];
        const nextTasks = current.tasks.map((task) => task.id === promotedTask.id ? { ...task, projectId: id, projectName: name.trim() } : task);
        const nextProjects: BrainProjectSnapshot[] = [...current.projects, {
          schemaVersion: 6, id, name: name.trim(), sourcePath: create.relativePath, status: "planning",
          area, priority, progress: 0, focusToday: false, startDate: null, endDate: null, completedAt: null, body,
        }];
        const filesForWrite = [...current.files, { relativePath: create.relativePath, sha256: create.expectedSha256, bytesBase64: create.replacementBase64 }];
        const taskChanges = applyDesiredSnapshot(filesForWrite, {
          schemaVersion: 6,
          tasks: nextTasks,
          projects: nextProjects,
          collections: current.collections,
          fileHashes: {},
        });
        const projectWrite = taskChanges.find((change) => change.relativePath === create.relativePath);
        const otherChanges = taskChanges.filter((change) => change.relativePath !== create.relativePath);
        const projectChange = projectWrite && projectWrite.operation !== "delete" && projectWrite.replacementBase64
          ? { ...create, replacementBase64: projectWrite.replacementBase64 }
          : create;
        return [...otherChanges, projectChange];
      });
      setStatus(promotedTask ? "想法已升級為規劃中專案" : "已建立規劃中專案");
      return { id, name: name.trim() };
    } catch (cause) {
      setError(`建立專案失敗：${describeError(cause, "CREATE_PROJECT_FAILED")}`);
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function createCollection(name: string, category: string | null, importance: number | null, body = ""): Promise<boolean> {
    if (!diagnostics?.selectedVault) {
      const collection: BrainCollectionSnapshot = { schemaVersion: 6, id: crypto.randomUUID(), name: name.trim(), sourcePath: null, category, importance, body };
      await persistLocal(tasks, projects, [...collections, collection]);
      setStatus("已建立知識草稿；關閉前請選擇 Markdown 資料夾");
      return true;
    }
    setWorking(true);
    setError("");
    try {
      await queuedVaultWrite((current) => [
        buildCollectionCreateChange(name, category, importance, current.files.map((file) => file.relativePath), undefined, body),
      ]);
      setStatus("知識已建立；內容保留在本機 Markdown");
      return true;
    } catch (cause) {
      setError(`建立知識失敗：${describeError(cause, "CREATE_COLLECTION_FAILED")}`);
      return false;
    } finally {
      setWorking(false);
    }
  }

  function openSaveAsKnowledge(input: {
    title: string;
    content: string;
    sourceDate: string | null;
    projectId: string | null;
    projectName: string | null;
    attachmentSource?: string;
  }): void {
    const draft = buildOutcomeKnowledgeDraft({
      title: input.title,
      content: input.content,
      sourceDate: input.sourceDate,
      attachmentSource: input.attachmentSource,
    });
    const body = input.projectId
      ? draft.body
      : withRelatedProjectWikilink(draft.body, input.projectName);
    setPromotedTask(null);
    setKnowledgeSeed({
      name: draft.name,
      body,
      projectId: input.projectId,
      category: "",
    });
    setCreateEntity("collection");
  }

  async function permanentlyDeleteProject(project: BrainProjectSnapshot): Promise<void> {
    // The delete control that invoked this already confirmed in a dialog.
    if (!project.id) return;
    setWorking(true);
    setError("");
    try {
      const projectId = project.id;
      await queuedVaultWrite((current) => buildProjectDeleteChanges(current.files, {
        schemaVersion: 6,
        tasks: current.tasks,
        projects: current.projects,
        collections: current.collections,
        fileHashes: {},
      }, projectId));
      setStatus("專案已刪除，關聯任務已保留並解除連結");
    } catch (cause) {
      setError(`刪除專案失敗：${describeError(cause, "DELETE_PROJECT_FAILED")}`);
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyDeleteCollection(collection: BrainCollectionSnapshot): Promise<boolean> {
    if (!collection.id) return false;
    setWorking(true);
    setError("");
    try {
      if (diagnostics?.selectedVault) {
        await queuedVaultWrite((current) => {
          const target = current.collections.find((item) => item.id === collection.id);
          const changes = applyDesiredSnapshot(current.files, {
            schemaVersion: 6,
            tasks: current.tasks,
            projects: current.projects,
            collections: current.collections.filter((item) => item.id !== collection.id),
            fileHashes: {},
          });
          const sourcePath = target?.sourcePath ?? collection.sourcePath;
          if (sourcePath) {
            const source = current.files.find((file) => file.relativePath === sourcePath);
            if (source) changes.push({
              relativePath: sourcePath,
              expectedSha256: source.sha256,
              operation: "delete",
              replacementBase64: "",
            });
          }
          return changes;
        });
      } else {
        const ok = await persistLocal(tasks, projects, collections.filter((item) => item.id !== collection.id));
        if (!ok) return false;
      }
      if (selectedCollectionId === collection.id) setSelectedCollectionId(null);
      setStatus("知識已刪除");
      return true;
    } catch (cause) {
      setError(`刪除知識失敗：${describeError(cause, "DELETE_COLLECTION_FAILED")}`);
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function permanentlyDeleteTask(task: BrainTaskSnapshot) {
    // The delete control that invoked this already confirmed in a dialog.
    // Ctrl+Z still restores the task locally.
    setWorking(true);
    setError("");
    const deleted = await persistLocal(tasks.filter((item) => task.id ? item.id !== task.id : item !== task));
    if (deleted) setStatus("任務已從本機 Markdown 永久刪除");
    setWorking(false);
  }

  async function flushDraftsToSelectedVault(): Promise<void> {
    const draft = loadDraftWorkspace();
    if (!hasDraftContent(draft)) return;
    const loader = new VaultLoader(native, languageRef.current);
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

  const content =
    view === "today" ? (
      <Today
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onShowCompletedChange={setCompletedVisibility}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
        onOpenTask={(id) => openDetail("task", id)}
        onQuickAdd={() => setQuickAddOpen(true)}
        onCreateProject={(name) => createProject(name, null, null)}
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
        onOpenTask={(id) => openDetail("task", id)}
        onCreateProject={(name) => createProject(name, null, null)}
        onPromote={(task) => {
          setKnowledgeSeed(null);
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
        onOpenTask={(id) => openDetail("task", id)}
        selectedProjectId={selectedBoardProjectId}
        onProjectFilterChange={setSelectedBoardProjectId}
        onBackToProjects={() => setView("projects")}
        onQuickAdd={() => setQuickAddOpen(true)}
        onCompleteProject={selectedBoardProjectId ? () => requestCompleteProject(selectedBoardProjectId) : undefined}
        onReopenProject={selectedBoardProjectId ? () => {
          const project = projects.find((item) => item.id === selectedBoardProjectId);
          if (project) void finishReopenProject(project);
        } : undefined}
      />
    ) : view === "projects" ? (
      <Projects
        projects={projects}
        tasks={tasks}
        revealTab={revealProjectList.tab}
        revealTabToken={revealProjectList.token}
        onOpenProject={(id) => openDetail("project", id)}
        onOpenBoard={(projectId) => {
          setSelectedBoardProjectId(projectId);
          setView("board");
        }}
        onCompleteProject={requestCompleteProject}
        onReopenProject={(projectId) => {
          const project = projects.find((item) => item.id === projectId);
          if (project) void finishReopenProject(project);
        }}
        onSave={(next) => void persistLocal(tasks, projects.map((project) => {
          if (project.id === next.id) return next;
          return next.focusToday && project.focusToday ? { ...project, focusToday: false } : project;
        }))}
        onArchive={(project) => void finishArchiveProject(project)}
        onDelete={(project) => void permanentlyDeleteProject(project)}
        onCreate={() => { setKnowledgeSeed(null); setCreateEntity("project"); }}
      />
    ) : view === "collections" ? (
      <Collections
        collections={collections}
        selectedId={selectedCollectionId}
        onSelect={setSelectedCollectionId}
        onCreate={() => { setKnowledgeSeed(null); setCreateEntity("collection"); }}
        onSave={(collection) => persistLocal(tasks, projects, collections.map((item) => item.id === collection.id ? collection : item))}
        onDelete={(collection) => permanentlyDeleteCollection(collection)}
        onImportPrompts={() => { setImportText(""); setImportError(""); setImportPromptsOpen(true); }}
        onExportPrompts={() => { const json = renderPluginExport(promptCollections.map((c) => collectionToPrompt(c))); setExportText(json); setExportCopied(false); setExportPromptsOpen(true); }}
      />
    ) : (
      <SyncSettings
        diagnostics={diagnostics}
        vaultInput={vaultInput}
        setVaultInput={setVaultInput}
        working={working}
        onBrowseVault={browseVault}
        onSelectVault={() => selectVault()}
        onOpenArchitecture={() => setArchitectureOpen(true)}
        onPreviewLayout={() => void prepareLayoutMigration()}
        appUpdate={appUpdate}
        updateBusy={updateBusy}
        onCheckUpdate={() => void checkAppUpdate(true, true)}
        onInstallUpdate={() => void installAppUpdate()}
        reminderCard={(
          <ReminderSettingsCard
            settings={reminderSettings}
            failing={remindersFailing}
            t={t}
            onChange={changeReminderSettings}
            onTest={notifyReminder ? () => void notifyReminder(t("reminders.test.title"), t("reminders.test.body")).catch((cause) => setError(describeError(cause, "NOTIFICATION_FAILED"))) : undefined}
          />
        )}
        inboxRelayCard={native.inboxRelay && (
          <InboxRelaySettingsCard api={native.inboxRelay} t={t} onError={setError} />
        )}
      />
    );

  return (
    <UiPreferencesContext.Provider value={{ preferences, setPreferences, t }}>
    <AttachmentProvider value={attachmentApi}>
    <div data-theme={preferences.theme} className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <GlobalShiftMarquee />
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
          <span className="app-version" title={t("update.current", { version: APP_VERSION })}>v{APP_VERSION}</span>
          <button type="button" className="icon-button shortcuts-button" aria-label={t("shortcuts.open")} title={t("shortcuts.open")} onClick={() => setShortcutsOpen(true)}>
            <Keyboard aria-hidden="true" />
          </button>
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
            <div className="view-history-nav">
              <button
                className="icon-button"
                disabled={!previousView}
                aria-label={previousView ? t("app.back", { view: t(VIEW_KEYS[previousView]) }) : t("app.backDisabled")}
                title={previousView ? `${t("app.back", { view: t(VIEW_KEYS[previousView]) })} · Alt+←` : t("app.backDisabled")}
                onClick={goBackView}
              >
                <ArrowLeft aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                disabled={!nextView}
                aria-label={nextView ? t("app.forward", { view: t(VIEW_KEYS[nextView]) }) : t("app.forwardDisabled")}
                title={nextView ? `${t("app.forward", { view: t(VIEW_KEYS[nextView]) })} · Alt+→` : t("app.forwardDisabled")}
                onClick={goForwardView}
              >
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
            <div>
              <h1>{t(VIEW_TITLE_KEYS[view])}</h1>
              <p>{status}</p>
            </div>
          </div>
          <div className="top-actions">
            <button
              className="icon-button top-icon-action"
              disabled={undoCounts.undo === 0 || working}
              aria-label={t("app.undo")}
              title={`${t("app.undo")} · Ctrl/Cmd+Z`}
              onClick={performUndo}
            >
              <Undo2 aria-hidden="true" />
            </button>
            <button
              className="icon-button top-icon-action"
              disabled={undoCounts.redo === 0 || working}
              aria-label={t("app.redo")}
              title={`${t("app.redo")} · Ctrl/Cmd+Shift+Z`}
              onClick={performRedo}
            >
              <Redo2 aria-hidden="true" />
            </button>
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
              aria-label={t("app.theme")}
              title={preferences.theme === "light" ? t("app.theme.dark") : t("app.theme.light")}
              onClick={() => setPreferences((value) => ({ ...value, theme: value.theme === "light" ? "dark" : "light" }))}
            >
              {preferences.theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
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
          initialProjectId={selectedProjectDetail?.id ?? (view === "board" ? selectedBoardProjectId : null)}
          onClose={() => setQuickAddOpen(false)}
          onCreateProject={(name) => createProject(name, null, null)}
          onSave={(next) => {
            setQuickAddOpen(false);
            void persistLocal(next);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog t={t} onClose={() => setShortcutsOpen(false)} />}
      {updateNoticeOpen && <UpdateNotice version={APP_VERSION} t={t} onClose={() => setUpdateNoticeOpen(false)} />}
      {searchOpen && (
        <WorkspaceSearch
          tasks={tasks}
          projects={projects}
          collections={collections}
          onClose={() => setSearchOpen(false)}
          onSelect={(result) => {
            setSearchOpen(false);
            if (result.kind === "project") {
              setView("projects");
              openDetail("project", result.id);
            } else if (result.kind === "collection") {
              setSelectedCollectionId(result.id);
              setView("collections");
            } else {
              openDetail("task", result.id);
            }
          }}
          actions={[
            { label: preferences.language === "zh-TW" ? "快速新增任務" : "Quick add task", run: () => setQuickAddOpen(true) },
            { label: preferences.language === "zh-TW" ? "新增專案" : "New project", run: () => { setKnowledgeSeed(null); setCreateEntity("project"); } },
            { label: preferences.language === "zh-TW" ? "新增知識" : "New knowledge", run: () => { setKnowledgeSeed(null); setCreateEntity("collection"); } },
            { label: preferences.language === "zh-TW" ? "建立知識架構" : "Build architecture", run: () => setArchitectureOpen(true) },
            { label: t("search.goSettings"), run: () => setView("sync") },
          ]}
        />
      )}
      {selectedTask && (
        <TaskDetailDialog
          key={selectedTask.id ?? selectedTask.title}
          task={selectedTask}
          projects={projects}
          locale={preferences.language}
          surface={preferences.detailSurface}
          tabs={detailTabs}
          activeTabKey={activeDetailKey ?? undefined}
          onSelectTab={setActiveDetailKey}
          onCloseTab={closeDetail}
          t={t}
          onClose={() => { if (activeDetailKey) closeDetail(activeDetailKey); }}
          onCreateProject={(name) => createProject(name, null, null)}
          onSave={async (next) => {
            const prepared = { ...next, completedAt: next.status === "done" ? (next.completedAt ?? taipeiDateKey()) : null };
            const changed = tasks.map((task) => task.id === prepared.id ? prepared : task);
            return persistLocal(
              prepared.priority === "highest" && prepared.id
                ? markMostImportant(changed, prepared.id, prepared.taskDate ?? taipeiDateKey())
                : changed,
            );
          }}
          onDelete={(task) => { void permanentlyDeleteTask(task); if (activeDetailKey) closeDetail(activeDetailKey); }}
          onSaveAsKnowledge={(task) => openSaveAsKnowledge({
            title: task.title,
            content: task.body ?? "",
            sourceDate: task.taskDate ?? taipeiDateKey(),
            projectId: task.projectId,
            projectName: task.projectName,
          })}
        />
      )}
      {selectedProjectDetail && (
        <ProjectDetailDialog
          key={selectedProjectDetail.id ?? selectedProjectDetail.name}
          project={selectedProjectDetail}
          openTasks={tasks.filter((task) => task.projectId === selectedProjectDetail.id && task.status !== "done").length}
          doingTasks={tasks.filter((task) => task.projectId === selectedProjectDetail.id && task.status === "doing").length}
          existingAreas={[...new Set(projects.map((project) => project.area).filter((area): area is string => Boolean(area)))].sort()}
          projectTasks={tasks
            .filter((task) => task.projectId === selectedProjectDetail.id && task.status !== "done")
            .sort((a, b) => a.rank.localeCompare(b.rank))}
          locale={preferences.language}
          surface={preferences.detailSurface}
          tabs={detailTabs}
          activeTabKey={activeDetailKey ?? undefined}
          onSelectTab={setActiveDetailKey}
          onCloseTab={closeDetail}
          t={t}
          onClose={() => { if (activeDetailKey) closeDetail(activeDetailKey); }}
          onAddProjectTask={(title) => {
            const bound = newTask(title, {
              taskDate: null,
              project: selectedProjectDetail,
            });
            void persistLocal([...tasks, bound]);
          }}
          onToggleProjectTask={(task) => void persistLocal(tasks.map((item) => item.id === task.id
            ? { ...item, status: item.status === "done" ? "todo" as const : "done" as const, completedAt: item.status === "done" ? null : taipeiDateKey() }
            : item))}
          onOpenProjectTask={(taskId) => openDetail("task", taskId)}
          onDeleteProjectTask={(task) => void permanentlyDeleteTask(task)}
          onSave={(next) => persistLocal(tasks, projects.map((project) => {
            if (project.id === next.id) return next;
            return next.focusToday && project.focusToday ? { ...project, focusToday: false } : project;
          }))}
          onOpenBoard={() => {
            setSelectedBoardProjectId(selectedProjectDetail.id);
            if (activeDetailKey) closeDetail(activeDetailKey);
            setView("board");
          }}
          onComplete={() => {
            if (selectedProjectDetail.id) requestCompleteProject(selectedProjectDetail.id);
          }}
          onReopen={() => void finishReopenProject(selectedProjectDetail)}
          onArchive={() => void finishArchiveProject(selectedProjectDetail)}
          onDelete={() => { void permanentlyDeleteProject(selectedProjectDetail); if (activeDetailKey) closeDetail(activeDetailKey); }}
          relatedKnowledge={relatedKnowledgeForProject(collections, selectedProjectDetail.name)
            .flatMap((item) => item.id ? [{ id: item.id, name: item.name, category: item.category }] : [])}
          onOpenKnowledge={(id) => {
            if (activeDetailKey) closeDetail(activeDetailKey);
            setSelectedCollectionId(id);
            setView("collections");
          }}
        />
      )}
      <ActionConfirmDialog
        open={updatePromptOpen && Boolean(appUpdate?.available)}
        title={t("update.promptTitle")}
        message={appUpdate
          ? t("update.promptMessage", { current: appUpdate.currentVersion, latest: appUpdate.latestVersion })
          : ""}
        confirmLabel={updateBusy ? t("update.installing") : t("update.install")}
        cancelLabel={t("update.later")}
        tone="primary"
        busy={updateBusy}
        onCancel={dismissAppUpdate}
        onConfirm={() => { void installAppUpdate(); }}
      />
      <ActionConfirmDialog
        open={Boolean(pendingCompleteProject)}
        title={t("project.complete.title")}
        message={pendingCompleteProject
          ? (pendingCompleteOpenCount > 0
            ? t("project.complete.message", { name: pendingCompleteProject.name, count: pendingCompleteOpenCount })
            : t("project.complete.messageNone", { name: pendingCompleteProject.name }))
          : ""}
        confirmLabel={t("project.complete.confirm")}
        cancelLabel={t("app.cancel")}
        tone="primary"
        busy={working}
        onCancel={() => setPendingCompleteProjectId(null)}
        onConfirm={() => { if (pendingCompleteProject) void finishCompleteProject(pendingCompleteProject); }}
      />
      {createEntity && (
        <CreateEntityModal
          kind={createEntity}
          mode={knowledgeSeed ? "save-outcome" : "create"}
          initialName={knowledgeSeed?.name ?? promotedTask?.title ?? ""}
          initialBody={knowledgeSeed?.body ?? ""}
          initialCategory={knowledgeSeed?.category ?? ""}
          initialProjectId={knowledgeSeed?.projectId ?? null}
          templates={templates}
          projects={projects}
          existingCategories={
            createEntity === "project"
              ? [...new Set(projects.map((p) => p.area).filter((a): a is string => Boolean(a)))].sort()
              : knowledgeFilterCategories(collections.map((c) => c.category))
          }
          onCreateProject={(name) => createProject(name, null, null)}
          onClose={() => {
            setCreateEntity(null);
            setPromotedTask(null);
            setKnowledgeSeed(null);
          }}
          onCreate={async (name, category, importance, body) => {
            const created = createEntity === "project"
              ? await createProject(name, category, importance, promotedTask ?? undefined, body)
              : await createCollection(name, category, importance, body);
            if (created) {
              setCreateEntity(null);
              setPromotedTask(null);
              setKnowledgeSeed(null);
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
            <p>預設只勾專案管理與個人知識庫。提示詞庫、模板套件與 AI 委任之後需要再加。已存在的檔案不會被覆寫。</p>
            <div className="architecture-pack-list">
              {templatePacks(preferences.language).map((pack) => (
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
      {pendingLayoutPlan && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label={t("layout.confirmTitle")}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">LAYOUT</span>
                <h2>{t("layout.confirmTitle")}</h2>
              </div>
              <button className="icon-button" onClick={() => { setPendingLayoutPlan(null); setPendingLayoutFiles(null); }} aria-label={t("app.close")} title={t("app.close")}>
                <X aria-hidden="true" />
              </button>
            </div>
            <p>{t("layout.confirmHelp")}</p>
            {pendingLayoutPlan.moves.length > 0 && (
              <>
                <h3 className="layout-review-heading">{t("layout.moves")}</h3>
                <ul className="review-list">
                  {pendingLayoutPlan.moves.map((item) => (
                    <li key={item.from}><code>{item.from}</code> → <code>{item.to}</code></li>
                  ))}
                </ul>
              </>
            )}
            {pendingLayoutPlan.duplicates.length > 0 && (
              <>
                <h3 className="layout-review-heading">{t("layout.duplicates")}</h3>
                <ul className="review-list">
                  {pendingLayoutPlan.duplicates.map((item) => (
                    <li key={item.from}><code>{item.from}</code> → <code>{item.to}</code></li>
                  ))}
                </ul>
              </>
            )}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => { setPendingLayoutPlan(null); setPendingLayoutFiles(null); }}>{t("app.cancel")}</button>
              <button className="primary" disabled={working || pendingLayoutPlan.moves.length === 0} onClick={() => void confirmLayoutMigration()}>{t("layout.apply")}</button>
            </div>
          </section>
        </div>
      )}
      {importPromptsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportPromptsOpen(false); }}>
          <section className="modal" role="dialog" aria-modal="true" aria-label="匯入提示詞">
            <div className="modal-header"><div><span className="eyebrow">PROMPT LIBRARY</span><h2>匯入提示詞</h2></div><button className="icon-button" onClick={() => setImportPromptsOpen(false)} aria-label="關閉" title="關閉"><X aria-hidden="true" /></button></div>
            <p>貼上「AI 提示詞 Plus」擴充匯出的 JSON（物件或純陣列）。每支提示詞會成為一筆「提示詞/…」分類的知識。</p>
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
          <section className="modal onboarding-modal" role="dialog" aria-modal="true" aria-label={t("onboarding.title")}>
            <div className="modal-header"><div><span className="eyebrow">{t("app.name")}</span><h2>{t("onboarding.title")}</h2></div></div>
            <p>{t("onboarding.body")}</p>
            <ul className="onboarding-kinds">
              <li>{t("onboarding.task")}</li>
              <li>{t("onboarding.project")}</li>
              <li>{t("onboarding.collection")}</li>
            </ul>
            <div className="onboarding-cta">
              <button className="primary onboarding-primary" onClick={() => void startWithFolder()}>
                {t("onboarding.chooseFolder")}
              </button>
              <p className="eyebrow">{t("onboarding.architecture")}</p>
            </div>
            <hr className="modal-divider" />
            <button className="text-button" onClick={finishOnboarding}>
              {t("onboarding.skip")}
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
    </div>
    </AttachmentProvider>
    </UiPreferencesContext.Provider>
  );

  function setCompletedVisibility(value: boolean) {
    setShowCompleted(value);
    localStorage.setItem("second-brain.showCompletedTasks", String(value));
  }
}
