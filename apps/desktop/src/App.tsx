import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Columns3,
  Eye,
  FolderKanban,
  GripVertical,
  Home,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  applyRoutineTemplate,
  createDefaultRoutineTemplate,
  getTodayTasks,
  splitTodayTasks,
  completeProject,
  projectColor,
  rankForIndex,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type RoutineTemplate,
  type RoutineTemplateItem,
  type TaskStatus,
} from "@second-brain/brain-core";
import {
  addDateDays,
  buildMonthCells,
  buildWeekDates,
  getCalendarTaskEntries as buildCalendarTaskEntries,
  taipeiDateKey as dateKeyForTaipei,
  searchWorkspace,
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
import { applyDesiredSnapshot, type LocalMarkdownFile } from "./vault";
import "./styles.css";

type View = "today" | "calendar" | "board" | "projects" | "sync";
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "待辦",
  doing: "執行中",
  waiting: "等待中",
  done: "完成",
};
const VIEW_LABELS: Record<View, string> = {
  today: "今日",
  calendar: "日曆",
  board: "看板",
  projects: "專案",
  sync: "同步與設定",
};
const VIEW_TITLES: Record<View, string> = {
  today: "今日焦點",
  calendar: "任務日曆",
  board: "工作看板",
  projects: "專案總覽",
  sync: "同步中心",
};
function ViewIcon({ view }: { view: View }) {
  const className = "nav-icon";
  if (view === "today") return <Home className={className} />;
  if (view === "calendar") return <CalendarDays className={className} />;
  if (view === "board") return <Columns3 className={className} />;
  if (view === "projects") return <FolderKanban className={className} />;
  return <Settings2 className={className} />;
}
const taipeiDateKey = () => dateKeyForTaipei(new Date());
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
  const native = useMemo(
    () => providedAdapter ?? createNativeAdapter(),
    [providedAdapter],
  );
  const [view, setView] = useState<View>("today");
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
  const [tasks, setTasks] = useState<BrainTaskSnapshot[]>([]);
  const [projects, setProjects] = useState<BrainProjectSnapshot[]>([]);
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
  const syncRunningRef = useRef(false);
  const cloudEtagRef = useRef<string | null>(null);
  const routineTemplateRef = useRef(routineTemplate);

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
        routineTemplateRef.current = value;
        setRoutineTemplate(value);
      }
    }).catch(() => undefined);
  }, [native]);

  const saveRoutineTemplate = useCallback((value: RoutineTemplate) => {
    const next = { ...value, version: value.version + 1, updatedAt: new Date().toISOString() };
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
          routineTemplateRef.current = remote;
          setRoutineTemplate(remote);
          await native.saveRoutineTemplate?.(remote);
        }
      }).catch((cause) => {
        if (cause instanceof PublisherHttpError && cause.code === "ROUTINE_TEMPLATES_DISABLED") return;
        const message = cause instanceof Error ? cause.message : "ROUTINE_TEMPLATE_SYNC_FAILED";
        setError(`每日啟動模板同步失敗：${message}`);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [client, devicePaired, native, routineTemplate]);

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

  const reloadLocal = useCallback(
    async (updateStatus = true) => {
      const nextDiagnostics = await native.getDiagnostics();
      setDiagnostics(nextDiagnostics);
      if (nextDiagnostics.publisherOrigin) {
        setServerOrigin(nextDiagnostics.publisherOrigin);
      }
      if (!nextDiagnostics.selectedVault) {
        if (updateStatus) setStatus("請先選擇 Markdown 資料夾");
        return;
      }
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
      const local = await loader.loadLocal();
      setFiles(local.files);
      setTasks(local.tasks);
      setProjects(local.projects);
      if (updateStatus)
        setStatus(
          `已載入 ${local.tasks.length} 項任務 · ${local.projects.length} 個專案`,
        );
    },
    [engine, native],
  );

  useEffect(() => {
    void reloadLocal().catch((cause) => {
      const message =
        cause instanceof Error ? cause.message : "DIAGNOSTICS_FAILED";
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
        const message = cause instanceof Error ? cause.message : "SYNC_FAILED";
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
    if (!engine) return;
    let debounce: number | undefined;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("vault-changed", () => {
          window.clearTimeout(debounce);
          debounce = window.setTimeout(
            () => void runSync({ background: true }),
            3_000,
          );
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
  }, [engine, pollCloudRevision, runSync]);

  async function persistLocal(
    nextTasks: BrainTaskSnapshot[],
    nextProjects = projects,
  ): Promise<boolean> {
    const changes = applyDesiredSnapshot(files, {
      schemaVersion: 5,
      tasks: nextTasks,
      projects: nextProjects,
      fileHashes: {},
    });
    if (changes.length === 0) {
      setTasks(nextTasks);
      setProjects(nextProjects);
      return true;
    }
    setWorking(true);
    setError("");
    try {
      await native.applyMarkdownChanges(changes);
      setStatus("已儲存在本機 · 等待同步");
      await reloadLocal();
      window.setTimeout(() => void runSync({ background: true }), 50);
      return true;
    } catch (cause) {
      setError(
        `本機寫入失敗：${cause instanceof Error ? cause.message : "WRITE_FAILED"}`,
      );
      return false;
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

  async function selectVault(path = vaultInput) {
    setWorking(true);
    setError("");
    try {
      await native.selectVault(path);
      setVaultInput("");
      await reloadLocal();
    } catch (cause) {
      setError(
        `無法使用此資料夾：${cause instanceof Error ? cause.message : "VAULT_SELECTION_FAILED"}`,
      );
    } finally {
      setWorking(false);
    }
  }

  async function browseVault() {
    setWorking(true);
    setError("");
    try {
      const path = await native.pickVaultFolder();
      if (!path) return;
      setVaultInput(path);
      await native.selectVault(path);
      setVaultInput("");
      await reloadLocal();
    } catch (cause) {
      setError(
        `無法選擇資料夾：${cause instanceof Error ? cause.message : "FOLDER_PICKER_FAILED"}`,
      );
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
        `無法開始配對：${cause instanceof Error ? cause.message : "PAIR_FAILED"}`,
      );
    } finally {
      setWorking(false);
    }
  }

  function openPairingWebsite() {
    if (!client || !pairing) return;
    void client.openPairingPage(pairing.pairingId).catch((cause) => {
      setError(`無法開啟 Publisher 配對頁：${cause instanceof Error ? cause.message : "OPEN_PAIRING_FAILED"}`);
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
              `無法完成配對：${cause instanceof Error ? cause.message : "PAIRING_FAILED"}`,
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
        `衝突提交失敗：${cause instanceof Error ? cause.message : "COMMIT_FAILED"}`,
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
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
        onQuickAdd={() => setQuickAddOpen(true)}
        routineTemplate={routineTemplate}
        onRoutineTemplateChange={saveRoutineTemplate}
      />
    ) : view === "calendar" ? (
      <Calendar
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
      />
    ) : view === "board" ? (
      <Board
        tasks={tasks}
        projects={projects}
        showCompleted={showCompleted}
        onShowCompletedChange={setCompletedVisibility}
        onSave={persistLocal}
        onDelete={permanentlyDeleteTask}
      />
    ) : view === "projects" ? (
      <Projects
        projects={projects}
        tasks={tasks}
        onSave={(nextProjects, nextTasks) => persistLocal(nextTasks, nextProjects)}
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
      />
    );

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">腦</span>
          <div>
            <strong>第二大腦工作台</strong>
            <small>任務與專案中心</small>
          </div>
        </div>
        <nav>
          {(Object.keys(VIEW_LABELS) as View[]).map((item) => (
            <button
              key={item}
              className={view === item ? "active" : ""}
              onClick={() => setView(item)}
            >
              <ViewIcon view={item} />
              <span>{VIEW_LABELS[item]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${navigator.onLine ? "online" : ""}`} />
          <span>{navigator.onLine ? "網路已連線" : "離線模式"}</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="title-row">
            <button
              className="icon-button"
              aria-label="切換側面板"
              title="側面板"
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              <Menu aria-hidden="true" />
            </button>
            <div>
              <h1>{VIEW_TITLES[view]}</h1>
              <p>{status}</p>
            </div>
          </div>
          <div className="top-actions">
            <button className="search-button" onClick={() => setSearchOpen(true)}>
              <Search aria-hidden="true" />搜尋任務與專案 <kbd>Ctrl/Cmd+K</kbd>
            </button>
            <label className="completed-visibility-toggle">
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(event) => setCompletedVisibility(event.target.checked)}
              />
              <Eye aria-hidden="true" />
              顯示已完成
            </label>
            <button
              className="quick-add-button"
              onClick={() => setQuickAddOpen(true)}
            >
              <Plus aria-hidden="true" />快速新增任務 <kbd>N</kbd>
            </button>
            <div className="sync-state">
              <span>
                {lastSync
                  ? `已同步 ${new Date(lastSync).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}`
                  : devicePaired
                    ? "已配對，等待完成首次同步"
                    : "尚未配對桌面 App"}
              </span>
              <button disabled={working || !engine} onClick={requestManualSync}>
                <RefreshCw className={working ? "spin" : ""} aria-hidden="true" />
                {working
                  ? "處理中…"
                  : !devicePaired
                    ? "先完成配對"
                    : writeApproved
                      ? "立即同步"
                      : "完成首次同步"}
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
        {(Object.keys(VIEW_LABELS) as View[]).map((item) => (
          <button
            key={item}
            className={view === item ? "active" : ""}
            onClick={() => setView(item)}
          >
            <ViewIcon view={item} />
            {item === "sync" ? "更多" : VIEW_LABELS[item]}
          </button>
        ))}
      </nav>
      {quickAddOpen && (
        <QuickAddModal
          tasks={tasks}
          projects={projects}
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
          onClose={() => setSearchOpen(false)}
          onSelect={(result) => {
            setSearchOpen(false);
            setView(result.kind === "project" ? "projects" : result.value.taskDate ? "calendar" : "today");
          }}
        />
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
        aria-label="任務名稱"
        value={value.title}
        onChange={(event) => setValue({ ...value, title: event.target.value })}
      />
      <div className="form-row">
        <select
          aria-label="狀態"
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
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <input
          aria-label="規劃日"
          type="date"
          value={value.taskDate ?? ""}
          onChange={(event) =>
            setValue({ ...value, taskDate: event.target.value || null })
          }
        />
        <input
          aria-label="開始時間"
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
          aria-label="持續時間"
          disabled={!value.startTime}
          value={value.durationMinutes ?? 30}
          onChange={(event) => setValue({ ...value, durationMinutes: Number(event.target.value) })}
        >
          {[15, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分鐘</option>)}
        </select>
        <select
          aria-label="優先度"
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
          aria-label="關聯專案"
          value={value.projectId ?? ""}
          onChange={(event) => chooseProject(event.target.value)}
        >
          <option value="">無專案</option>
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
          <Save aria-hidden="true" />儲存變更
        </button>
      </div>
    </div>
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
  const done = task.status === "done";
  return (
    <div className="task-action-bar" aria-label={`${task.title}的操作`}>
      <button className={`task-action-button ${important ? "active" : ""}`} aria-label="設為最重要" title="設為最重要" onClick={onImportant}>
        <Star aria-hidden="true" fill={important ? "currentColor" : "none"} />
      </button>
      <button className="task-action-button completion-action" aria-label={done ? "重新開啟" : "標記完成"} title={done ? "重新開啟" : "標記完成"} onClick={onComplete}>
        {done ? <RotateCcw aria-hidden="true" /> : <span className="action-checkmark" aria-hidden="true">✓</span>}
      </button>
      {showEdit && <button className="task-action-button" aria-label="編輯任務" title="編輯任務" onClick={onEdit}>
        <Pencil aria-hidden="true" />
      </button>}
      <button className="task-action-button danger" aria-label="永久刪除" title="永久刪除雲端與本機 Markdown" onClick={() => onDelete(task)}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>
  );
}

function PriorityBadge({
  priority,
}: {
  priority: BrainTaskSnapshot["priority"];
}) {
  const item = priorityDisplay(priority);
  return (
    <span
      className={`priority-badge priority-${priority}`}
      title={`優先序 ${item.code}：${item.label}`}
    >
      {item.code}
      <small>{item.label}</small>
    </span>
  );
}

function Today({ tasks, projects, showCompleted, onSave, onDelete, onQuickAdd, routineTemplate, onRoutineTemplateChange }: {
  tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; showCompleted: boolean;
  onSave: (tasks: BrainTaskSnapshot[]) => void; onDelete: (task: BrainTaskSnapshot) => void; onQuickAdd: () => void;
  routineTemplate: RoutineTemplate; onRoutineTemplateChange: (template: RoutineTemplate) => void;
}) {
  const today = taipeiDateKey();
  const groups = splitTodayTasks(tasks, projects, today);
  const completed = completedForDate(tasks, today);
  const scheduled = groups.today.filter((task) => task.startTime).sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const [templateOpen, setTemplateOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
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
  const updateItem = (id: string, patch: Partial<RoutineTemplateItem>) => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.map((item) => item.id === id ? { ...item, ...patch } : item) });
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
  const enabledRoutineItems = routineTemplate.items.filter((item) => item.enabled);
  const scheduledRoutineItems = enabledRoutineItems.filter((item) => item.startTime);
  return <section className="command-center">
    <header className="command-hero"><div><span className="eyebrow">COMMAND CENTER · {today}</span><h2>安排精力，而不只是塞滿行程</h2><p>先選出今天最重要的事，再把低耗能工作留給下午。</p></div><button className="primary start-day-button" onClick={startToday}><Plus />開始今天</button></header>
    {notice && <div className="routine-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="關閉提示"><X /></button></div>}
    <section className="routine-template-card" aria-label="每日任務模板">
      <div className="routine-template-icon"><Settings2 /></div>
      <div><span className="eyebrow">每日任務模板</span><strong>{routineTemplate.name}</strong><small>{enabledRoutineItems.length} 個啟用項目 · {scheduledRoutineItems.length} 個已排時間</small></div>
      <button className="routine-template-action" onClick={() => setTemplateOpen((open) => !open)} aria-expanded={templateOpen}><Settings2 />{templateOpen ? "收合模板" : "管理模板"}</button>
    </section>
    <div className="command-summary"><article className="focus-summary"><span>今日最重要</span><strong>{important?.title ?? "尚未選定"}</strong><small>{important?.projectName ?? "在今日任務按下星號選定"}</small></article><article><span>逾期</span><strong>{groups.overdue.length}</strong><small>需要重新決定日期</small></article><article><span>今天</span><strong>{groups.today.length}</strong><small>{scheduled.length} 項已排時間</small></article></div>
    {templateOpen && <section className="routine-editor"><header><div><span className="eyebrow">DAILY ROUTINE</span><input aria-label="模板名稱" value={routineTemplate.name} onChange={(event) => onRoutineTemplateChange({ ...routineTemplate, name: event.target.value })} /></div><button onClick={() => setTemplateOpen(false)} aria-label="關閉模板"><X /></button></header><div className="routine-items">{routineTemplate.items.map((item) => <article key={item.id} draggable onDragStart={() => setDraggedItem(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropItem(item.id)}><GripVertical /><input type="checkbox" aria-label={`${item.title}啟用`} checked={item.enabled} onChange={(event) => updateItem(item.id, { enabled: event.target.checked })} /><input aria-label="例行任務名稱" value={item.title} onChange={(event) => updateItem(item.id, { title: event.target.value })} /><select aria-label="例行任務專案" value={item.projectId ?? ""} onChange={(event) => { const project = projects.find((value) => value.id === event.target.value); updateItem(item.id, { projectId: project?.id ?? null, projectName: project?.name ?? null }); }}><option value="">無專案</option>{projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}</select><select aria-label="例行任務優先度" value={item.priority} onChange={(event) => updateItem(item.id, { priority: event.target.value as RoutineTemplateItem["priority"] })}>{(["highest","high","medium","normal","low"] as const).map((value) => <option key={value} value={value}>{priorityDisplay(value).code}</option>)}</select><input aria-label="開始時間" type="time" value={item.startTime ?? ""} onChange={(event) => updateItem(item.id, { startTime: event.target.value || null, durationMinutes: event.target.value ? item.durationMinutes ?? 30 : null })} /><select aria-label="持續時間" disabled={!item.startTime} value={item.durationMinutes ?? 30} onChange={(event) => updateItem(item.id, { durationMinutes: Number(event.target.value) })}>{[15,30,45,60,90,120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分</option>)}</select><button className="danger-icon" aria-label={`刪除${item.title}`} onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: routineTemplate.items.filter((value) => value.id !== item.id) })}><Trash2 /></button></article>)}</div><button className="secondary" onClick={() => onRoutineTemplateChange({ ...routineTemplate, items: [...routineTemplate.items, { id: crypto.randomUUID(), title: "新的例行任務", enabled: true, projectId: null, projectName: null, priority: "normal", startTime: null, durationMinutes: null, rank: rankForIndex(routineTemplate.items.length) }] })}><Plus />新增模板項目</button></section>}
    <section className="timeline-section"><header><div><span className="eyebrow">TODAY TIMELINE</span><h3>今日時間軸</h3></div><button className="secondary" onClick={onQuickAdd}><Plus />新增任務 <kbd>N</kbd></button></header>{scheduled.length === 0 ? <Empty text="尚未安排時間。可直接在下方任務設定開始時間。" /> : <div className="timeline">{scheduled.map((task) => <article key={task.id ?? task.title} className={`${Number(task.startTime?.slice(0,2)) >= 13 && ["normal","low"].includes(task.priority) ? "low-energy" : ""}`}><time>{task.startTime}</time><div><strong>{task.title}</strong><small>{task.durationMinutes ?? 30} 分鐘 · {task.projectName ?? "無專案"}</small></div></article>)}</div>}</section>
    <div className="today-columns"><TaskPanel title="逾期任務" tone="overdue" tasks={groups.overdue} projects={projects} today={today} onPatch={patchTask} onComplete={complete} onDelete={onDelete} /><TaskPanel title="今日任務" tone="today" tasks={groups.today} projects={projects} today={today} onPatch={patchTask} onComplete={complete} onDelete={onDelete} /></div>
    {showCompleted && completed.length > 0 && <details className="completed-section"><summary>今日已完成 · {completed.length} 項</summary><div className="focus-task-list">{completed.map((task) => <InlineTaskCard key={task.id ?? task.title} task={task} projects={projects} today={today} onPatch={patchTask} onComplete={complete} onDelete={onDelete} />)}</div></details>}
  </section>;
}

function TaskPanel({ title, tone, tasks, projects, today, onPatch, onComplete, onDelete }: { title: string; tone: "overdue" | "today"; tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; today: string; onPatch: (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => void; onComplete: (task: BrainTaskSnapshot) => void; onDelete: (task: BrainTaskSnapshot) => void }) {
  return <section className={`today-panel ${tone}`}><header><div><span className="eyebrow">{tone === "overdue" ? "NEEDS A DECISION" : "TODAY'S FOCUS"}</span><h3>{title}</h3></div><strong>{tasks.length}</strong></header>{tasks.length === 0 ? <Empty text={tone === "overdue" ? "沒有逾期任務。" : "今天沒有待辦任務。"} /> : <div className="focus-task-list">{tasks.map((task) => <InlineTaskCard key={task.id ?? task.title} task={task} projects={projects} today={today} onPatch={onPatch} onComplete={onComplete} onDelete={onDelete} />)}</div>}</section>;
}

function InlineTaskCard({ task, projects, today, onPatch, onComplete, onDelete }: { task: BrainTaskSnapshot; projects: BrainProjectSnapshot[]; today: string; onPatch: (task: BrainTaskSnapshot, patch: Partial<BrainTaskSnapshot>) => void; onComplete: (task: BrainTaskSnapshot) => void; onDelete: (task: BrainTaskSnapshot) => void }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(task.title);
  const saveTitle = () => { const next = title.trim(); if (next && next !== task.title) onPatch(task, { title: next }); else setTitle(task.title); setEditingTitle(false); };
  const overdueDays = task.taskDate && task.taskDate < today ? Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${task.taskDate}T00:00:00Z`)) / 86400000)) : 0;
  return <article className={`inline-task-card ${task.priority === "highest" ? "most-important" : ""} ${task.status === "done" ? "completed-task" : ""}`}><button className={`clear-check ${task.status === "done" ? "done" : ""}`} aria-label={task.status === "done" ? `${task.title}重新開啟` : `${task.title}標記完成`} title={task.status === "done" ? "重新開啟" : "完成"} onClick={() => onComplete(task)}>{task.status === "done" ? "✓" : ""}</button><div className="inline-task-main"><div className="inline-title-row"><PriorityBadge priority={task.priority} />{editingTitle ? <input autoFocus aria-label="任務標題" value={title} onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={(event) => { if (event.key === "Enter") saveTitle(); if (event.key === "Escape") { setTitle(task.title); setEditingTitle(false); } }} /> : <button className="inline-title-button" onClick={() => setEditingTitle(true)}>{task.title}</button>}</div><div className="inline-fields"><select aria-label={`${task.title}所屬專案`} value={task.projectId ?? ""} onChange={(event) => { const project = projects.find((value) => value.id === event.target.value); onPatch(task, { projectId: project?.id ?? null, projectName: project?.name ?? null }); }}><option value="">無專案</option>{projects.map((project) => <option key={project.id ?? project.name} value={project.id ?? ""}>{project.name}</option>)}</select><input aria-label={`${task.title}日期`} type="date" value={task.taskDate ?? ""} onChange={(event) => onPatch(task, { taskDate: event.target.value || null })} /><input aria-label={`${task.title}開始時間`} type="time" value={task.startTime ?? ""} onChange={(event) => onPatch(task, { startTime: event.target.value || null, durationMinutes: event.target.value ? task.durationMinutes ?? 30 : null, timeZone: "Asia/Taipei" })} /><select aria-label={`${task.title}持續時間`} disabled={!task.startTime} value={task.durationMinutes ?? 30} onChange={(event) => onPatch(task, { durationMinutes: Number(event.target.value) })}>{[15,30,45,60,90,120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分</option>)}</select></div>{overdueDays > 0 && <small className="overdue-label">逾期 {overdueDays} 天 · 原日期 {task.taskDate}</small>}</div><div className="inline-task-actions"><button className={task.priority === "highest" ? "active" : ""} aria-label="設為今日最重要" title="設為今日最重要" onClick={() => onPatch(task, { priority: "highest", taskDate: today })}><Star fill={task.priority === "highest" ? "currentColor" : "none"} /></button>{overdueDays > 0 && <button aria-label="移到今天" title="移到今天" onClick={() => onPatch(task, { taskDate: today })}><CalendarDays /></button>}<button className="danger-icon" aria-label="永久刪除" title="永久刪除" onClick={() => onDelete(task)}><Trash2 /></button></div></article>;
}

function AgendaInlineTitle({ task, onSave }: { task: BrainTaskSnapshot; onSave: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const finish = () => {
    const title = value.trim();
    if (title && title !== task.title) onSave(title);
    else setValue(task.title);
    setEditing(false);
  };
  if (editing) {
    return <input className="agenda-inline-title-input" autoFocus aria-label="任務名稱" value={value} onChange={(event) => setValue(event.target.value)} onBlur={finish} onKeyDown={(event) => {
      if (event.key === "Enter") finish();
      if (event.key === "Escape") { setValue(task.title); setEditing(false); }
    }} />;
  }
  return <button className="agenda-inline-title" title="點一下直接編輯" onClick={() => setEditing(true)}>{task.status === "done" ? "✓ " : ""}{task.title}</button>;
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
  onClose,
  onSave,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  onClose: () => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
}) {
  const [title, setTitle] = useState("");
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
        aria-label="快速新增任務"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
            submit();
        }}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">QUICK CAPTURE</span>
            <h2>快速新增任務</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="關閉新增任務">
            <X aria-hidden="true" />
          </button>
        </div>
        <label>
          任務內容
          <input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="現在想到什麼？"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
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
            <strong>先放想法匣</strong>
            <small>
              還不確定要執行，不安排規劃日；之後可拖到日曆或看板待辦。
            </small>
          </span>
        </label>
        <div className="quick-grid">
          <label>
            關聯專案
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">無專案</option>
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
            規劃日
            <input
              type="date"
              disabled={ideaInbox}
              value={ideaInbox ? "" : taskDate}
              onChange={(event) => setTaskDate(event.target.value)}
            />
          </label>
          <label>
            開始時間
            <input
              type="time"
              disabled={ideaInbox}
              value={ideaInbox ? "" : startTime}
              onChange={(event) => setStartTime(event.target.value)}
            />
          </label>
          <label>
            持續時間
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
            <strong>設為今日最重要</strong>
            <small>
              {ideaInbox
                ? "先取消想法匣並安排日期"
                : "同一天只能有一項，原本的會自動降為高優先"}
            </small>
          </span>
        </label>
        <div className="modal-actions">
          <span>
            <kbd>Enter</kbd> 建立 · <kbd>Esc</kbd> 關閉
          </span>
          <button className="primary action-with-icon" disabled={!title.trim()} onClick={submit}>
            <Plus aria-hidden="true" />建立任務
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
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onShowCompletedChange: (value: boolean) => void;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const today = taipeiDateKey();
  const projectNames = [
    ...new Set(
      tasks
        .map((task) => task.projectName)
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
  const lanes: Array<{ id: BoardLane; label: string; hint: string }> = [
    { id: "idea", label: "想法匣", hint: "還沒確定要執行" },
    { id: "todo", label: "待辦", hint: "已規劃、準備開始" },
    { id: "doing", label: "執行中", hint: "現在正在推進" },
    { id: "waiting", label: "等待", hint: "等待回覆或條件" },
    { id: "done", label: "完成", hint: "已完成並保留歷史" },
  ];
  const filtered = tasks.filter(
    (task) => projectFilter === "all" || task.projectName === projectFilter,
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
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    const lane = target?.closest<HTMLElement>("[data-board-lane]")?.dataset.boardLane as BoardLane | undefined;
    if (lane) moveToLane(taskId, lane);
    setDrag(null);
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
          <h2>專案任務看板</h2>
          <p>拖曳卡片即可改變階段；想法匣代表尚未承諾執行。</p>
        </div>
        <div>
          <select
            aria-label="篩選專案"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="all">全部專案</option>
            {projectNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(event) => onShowCompletedChange(event.target.checked)}
            />
            顯示完成
          </label>
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
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  moveToLane(drag, lane.id);
                  setDrag(null);
                }}
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
                  <div className="lane-empty">拖到這裡</div>
                )}
                {laneTasks.map((task) => (
                  <article
                    draggable
                    onDragStart={(event) => {
                      setDrag(task.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDrag(null)}
                    onPointerDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button,select,input")) { setDrag(task.id); event.currentTarget.setPointerCapture(event.pointerId); } }}
                    onPointerUp={(event) => finishBoardPointer(event, task.id)}
                    onKeyDown={(event) => {
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
                      <PriorityBadge priority={task.priority} />
                      <strong>
                        {task.status === "done" ? "✓ " : ""}
                        {task.title}
                      </strong>
                    </div>
                    <small>{task.projectName ?? "無專案"}</small>
                    <label className="board-date-field" onPointerDown={(event) => event.stopPropagation()}>
                      <CalendarDays aria-hidden="true" />
                      <input
                        className="board-date-input"
                        aria-label={`修改 ${task.title} 日期`}
                        type="date"
                        value={task.taskDate ?? ""}
                        onChange={(event) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, taskDate: event.target.value || null } : item))}
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
                        title="往上"
                        onClick={() => moveWithinColumn(task.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        title="往下"
                        onClick={() => moveWithinColumn(task.id, 1)}
                      >
                        ↓
                      </button>
                      <TaskActionBar
                        task={task}
                        important={task.priority === "highest"}
                        onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, task.taskDate ?? today))}
                        onComplete={() => moveToLane(task.id, task.status === "done" ? "todo" : "done")}
                        onEdit={() => setEditingTaskId(editingTaskId === task.id ? null : task.id)}
                        onDelete={onDelete}
                      />
                    </div>
                    {editingTaskId === task.id && (
                      <TaskEditor
                        task={task}
                        projects={projects}
                        onSave={(next) => {
                          setEditingTaskId(null);
                          const changed = tasks.map((item) => item.id === task.id ? next : item);
                          void onSave(
                            next.priority === "highest" && next.id
                              ? markMostImportant(changed, next.id, next.taskDate ?? today)
                              : changed,
                          );
                        }}
                      />
                    )}
                  </article>
                ))}
              </section>
            );
          })}
      </div>
    </section>
  );
}

function Calendar({
  tasks,
  projects,
  showCompleted,
  onSave,
  onDelete,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  showCompleted: boolean;
  onSave: (tasks: BrainTaskSnapshot[]) => void;
  onDelete: (task: BrainTaskSnapshot) => void;
}) {
  const today = taipeiDateKey();
  const [mode, setMode] = useState<"month" | "week">("month");
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
  const beginDrag = (id: string | null, originDate: string | null) => {
    setDragTaskId(id);
    setDragOriginDate(originDate);
    setDropTargetDate(null);
    setActiveTaskId(id);
  };
  const resetDrag = () => {
    setDragTaskId(null);
    setDragOriginDate(null);
    setDropTargetDate(null);
  };
  function shift(delta: number) {
    if (mode === "week") {
      const next = addDateDays(anchor, delta * 7);
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
  const schedule = (id: string | null, date: string) => {
    if (id)
      void onSave(
        tasks.map((task) => (task.id === id ? scheduleTask(task, date) : task)),
      );
  };
  const unschedule = (id: string | null) => {
    if (id)
      void onSave(
        tasks.map((task) =>
          task.id === id
            ? { ...task, status: "todo", taskDate: null, completedAt: null }
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
    const date = target?.closest<HTMLElement>("[data-calendar-date]")?.dataset.calendarDate;
    if (date) schedule(taskId, date);
    else if (target?.closest("[data-idea-drawer]")) unschedule(taskId);
    resetDrag();
  };
  const dateLabel = (date: string) =>
    new Intl.DateTimeFormat("zh-TW", {
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
            <button onClick={() => shift(-1)} aria-label="上一個日期範圍">‹</button>
            <button
              className="today-button"
              onClick={() => {
                setAnchor(today);
                setSelected(today);
              }}
            >
              今天
            </button>
            <button onClick={() => shift(1)} aria-label="下一個日期範圍">›</button>
          </div>
          <h2>
            {mode === "month"
              ? `${month.replace("-", " 年 ")} 月`
              : `${dateLabel(weekDates[0]!)}－${dateLabel(weekDates[6]!)}`}
          </h2>
          <div>
            <div className="view-switch">
              <button
                className={mode === "month" ? "active" : ""}
                onClick={() => setMode("month")}
              >
                月曆
              </button>
              <button
                className={mode === "week" ? "active" : ""}
                onClick={() => setMode("week")}
              >
                週曆
              </button>
            </div>
            <button
              className="text-button"
              onClick={() => setSideOpen((value) => !value)}
            >
              <Columns3 aria-hidden="true" />側面板
            </button>
            <button
              className="text-button"
              onClick={() => setFullscreen((value) => !value)}
            >
              <Eye aria-hidden="true" />{fullscreen ? "離開全螢幕" : "全螢幕"}
            </button>
          </div>
        </header>
        {mode === "month" ? (
          <>
            <div className="weekdays">
              {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="month-grid">
              {cells.map((cell) => {
                const dayEntries = byDate.get(cell.date) ?? [];
                return (
                  <button
                    key={cell.date}
                    className={`calendar-day ${cell.currentMonth ? "" : "muted"} ${selected === cell.date ? "selected" : ""} ${cell.date === today ? "today" : ""} ${dragTaskId && dragOriginDate === cell.date ? "drag-origin" : ""} ${dragTaskId && dropTargetDate === cell.date && dragOriginDate !== cell.date ? "drop-target" : ""}`}
                    data-calendar-date={cell.date}
                    onDragEnter={() => setDropTargetDate(cell.date)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      schedule(
                        event.dataTransfer.getData("text/plain") || dragTaskId,
                        cell.date,
                      );
                      resetDrag();
                    }}
                    onClick={() => {
                      setSelected(cell.date);
                      setSideOpen(true);
                    }}
                  >
                    <span className="day-number">
                      {Number(cell.date.slice(8))}
                    </span>
                    <div className="calendar-task-list">
                      {dayEntries.slice(0, 4).map((entry) => (
                        <span
                          draggable
                          onDragStart={(event) => {
                            event.stopPropagation();
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", entry.task.id);
                            beginDrag(entry.task.id, entry.date);
                          }}
                          onDragEnd={resetDrag}
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveTaskId(entry.task.id);
                          }}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            setSelected(entry.date);
                            setSideOpen(true);
                          }}
                          style={taskProjectStyle(entry.task)}
                          key={`${entry.task.id}:${entry.date}`}
                          className={`calendar-task-title ${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragTaskId === entry.task.id ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        >
                          <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                          {entry.task.status === "done"
                            ? "✓ "
                            : `${priorityDisplay(entry.task.priority).code} `}
                          {entry.task.title}
                        </span>
                      ))}
                      {dayEntries.length > 4 && (
                        <small>＋{dayEntries.length - 4} 項</small>
                      )}
                    </div>
                    {dragTaskId && <i className="drop-hint">拖到這一天排程</i>}
                  </button>
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
                  onDragEnter={() => setDropTargetDate(date)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    schedule(
                      event.dataTransfer.getData("text/plain") || dragTaskId,
                      date,
                    );
                    resetDrag();
                  }}
                >
                  <button
                    className="week-date"
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
                  <div className="week-task-list">
                    {dayEntries.map((entry) => (
                      <article
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", entry.task.id);
                          beginDrag(entry.task.id, entry.date);
                        }}
                        onDragEnd={resetDrag}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveTaskId(entry.task.id);
                        }}
                        onDoubleClick={() => {
                          setSelected(entry.date);
                          setSideOpen(true);
                        }}
                        style={taskProjectStyle(entry.task)}
                        className={`${activeTaskId === entry.task.id ? "selected-task" : ""} ${dragTaskId === entry.task.id ? "dragging" : ""} ${entry.task.priority === "highest" ? "most-important" : ""} ${entry.task.status === "done" ? "completed-task" : ""}`}
                        key={`${entry.task.id}:${entry.date}`}
                      >
                        <div className="task-title-row">
                          <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                          <PriorityBadge priority={entry.task.priority} />
                          <strong>
                            {entry.task.status === "done" ? "✓ " : ""}
                            {entry.task.title}
                          </strong>
                        </div>
                        <small>
                          {entry.task.projectName ?? "無專案"}
                        </small>
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
        <section
          className={`idea-drawer ${dragTaskId ? "drag-active" : ""}`}
          data-idea-drawer
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            unschedule(event.dataTransfer.getData("text/plain") || dragTaskId);
            resetDrag();
          }}
        >
          <header>
            <div>
              <h3>想法匣</h3>
              <p>尚未承諾執行的草稿任務；拖到月曆或週曆即可排程。</p>
            </div>
            <button
              type="button"
              className="idea-count-button"
              onClick={() => setIdeasExpanded((value) => !value)}
              aria-expanded={ideasExpanded}
            >
              {ideasExpanded ? "收合" : `${ideas.length} 項`}
            </button>
          </header>
          <div className="idea-grid">
            {ideas.length === 0 ? (
              <small>目前沒有未排程想法</small>
            ) : (
              visibleIdeas.map((task) => (
                <article
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    if (task.id) event.dataTransfer.setData("text/plain", task.id);
                    beginDrag(task.id, null);
                  }}
                  onDragEnd={resetDrag}
                  onClick={() => setActiveTaskId(task.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveTaskId(task.id);
                    setIdeaContextMenu({
                      task,
                      x: Math.min(event.clientX, window.innerWidth - 210),
                      y: Math.min(event.clientY, window.innerHeight - 64),
                    });
                  }}
                  style={taskProjectStyle(task)}
                  className={`${activeTaskId === task.id ? "selected-task" : ""} ${dragTaskId === task.id ? "dragging" : ""}`}
                  key={task.id ?? task.title}
                >
                  <GripVertical className="calendar-task-drag-handle" aria-hidden="true" />
                  <div className="idea-card-body">
                    <strong>{task.title}</strong>
                    <span>
                      <PriorityBadge priority={task.priority} />
                      <small>{task.projectName ?? "無專案"}</small>
                    </span>
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
            <button className="icon-button" onClick={() => setSideOpen(false)} aria-label="關閉側面板">
              <X aria-hidden="true" />
            </button>
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
                  draggable
                  aria-label={`拖曳 ${task.title}`}
                  title="拖曳到其他日期"
                  onDragStart={(event) => {
                    setDragTaskId(task.id);
                    event.dataTransfer.effectAllowed = "move";
                    if (task.id) event.dataTransfer.setData("application/x-second-brain-task-id", task.id);
                  }}
                  onDragEnd={() => setDragTaskId(null)}
                  onPointerDown={(event) => {
                    if (event.button === 0) {
                      setDragTaskId(task.id);
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }
                  }}
                  onPointerUp={(event) => finishPointerDrag(event, task.id)}
                >
                  <GripVertical aria-hidden="true" />
                </button>
                <div>
                  <div className="task-title-row">
                    <PriorityBadge priority={task.priority} />
                    <AgendaInlineTitle task={task} onSave={(title) => void onSave(tasks.map((item) => item.id === task.id ? { ...item, title } : item))} />
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
                <input
                  aria-label={`${task.title}規劃日`}
                  type="date"
                  value={task.taskDate ?? ""}
                  onChange={(event) =>
                    void onSave(
                      tasks.map((item) =>
                        item.id === task.id
                          ? { ...item, taskDate: event.target.value || null }
                          : item,
                      ),
                    )
                  }
                />
                <div className="agenda-actions">
                  <TaskActionBar
                    task={task}
                    important={task.priority === "highest"}
                    onImportant={() => task.id && onSave(markMostImportant(tasks, task.id, selected))}
                    onComplete={() => complete(task.id)}
                    onDelete={remove}
                    showEdit={false}
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
  onSave,
  onFocus,
  onComplete,
  onReopen,
  onArchive,
}: {
  project: BrainProjectSnapshot;
  openTasks: number;
  onSave: (value: BrainProjectSnapshot) => void;
  onFocus: (enabled: boolean) => void;
  onComplete: () => void;
  onReopen: () => void;
  onArchive: () => void;
}) {
  const [value, setValue] = useState(project);
  useEffect(() => setValue(project), [project]);
  return (
    <article className="project-card">
      <div className="project-head">
        <div>
          <span className="eyebrow">{value.area ?? "未分類"}</span>
          <h3>{value.name}</h3>
        </div>
        <label className="focus">
          <input
            type="checkbox"
            checked={value.focusToday}
            onChange={(event) => onFocus(event.target.checked)}
          />
          今日焦點
        </label>
      </div>
      <div className="progress">
        <i style={{ width: `${value.progress ?? 0}%` }} />
      </div>
      <div className="project-meta">
        <span>{value.progress ?? 0}%</span>
        <span>{openTasks} 項未完成</span>
        <span>{value.startDate || value.endDate ? `${value.startDate ?? "未定"} — ${value.endDate ?? "未定"}` : "未設期間"}</span>
      </div>
      <div className="project-editor-grid">
        <label>
          狀態
          <select
            value={value.status}
            onChange={(event) =>
              setValue({ ...value, status: event.target.value })
            }
          >
            <option value="active">進行中</option>
            <option value="paused">暫停</option>
            {value.status === "done" && <option value="done">完成</option>}
            {value.status === "archived" && <option value="archived">封存</option>}
          </select>
        </label>
        <label>
          領域
          <input
            value={value.area ?? ""}
            onChange={(event) =>
              setValue({ ...value, area: event.target.value || null })
            }
          />
        </label>
        <label>
          優先序
          <input
            type="number"
            value={value.priority ?? ""}
            onChange={(event) =>
              setValue({
                ...value,
                priority:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
          />
        </label>
        <label>
          開始日
          <input
            type="date"
            value={value.startDate ?? ""}
            onChange={(event) =>
              setValue({ ...value, startDate: event.target.value || null })
            }
          />
        </label>
        <label>
          結束日
          <input
            type="date"
            value={value.endDate ?? ""}
            onChange={(event) =>
              setValue({ ...value, endDate: event.target.value || null })
            }
          />
        </label>
        <label className="project-progress">
          進度 {value.progress ?? 0}%
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
        <div className="project-actions">
          <button className="primary" onClick={() => onSave(value)}>儲存變更</button>
          {value.status === "done" || value.status === "archived" ? (
            <button className="secondary-button" onClick={onReopen}>重新啟用</button>
          ) : (
            <button className="secondary-button" onClick={onComplete}><CheckCircle2 aria-hidden="true" />完成專案</button>
          )}
          {value.status !== "archived" && <button className="archive-button" onClick={onArchive}>封存</button>}
        </div>
      </div>
    </article>
  );
}
function Projects({
  projects,
  tasks,
  onSave,
}: {
  projects: BrainProjectSnapshot[];
  tasks: BrainTaskSnapshot[];
  onSave: (projects: BrainProjectSnapshot[], tasks: BrainTaskSnapshot[]) => void;
}) {
  const [tab, setTab] = useState<"current" | "completed" | "archived">("current");
  const groups = {
    current: projects.filter((project) => project.status !== "done" && project.status !== "archived"),
    completed: projects.filter((project) => project.status === "done"),
    archived: projects.filter((project) => project.status === "archived"),
  };
  const visibleProjects = groups[tab];
  const saveProject = (project: BrainProjectSnapshot, value: BrainProjectSnapshot) =>
    onSave(projects.map((item) => item.id === project.id ? value : item), tasks);
  const finishProject = (project: BrainProjectSnapshot) => {
    const openCount = tasks.filter((task) => task.projectId === project.id && task.status !== "done").length;
    if (!window.confirm(`完成「${project.name}」？\n\n將同時完成 ${openCount} 項未完成任務，並保留完整歷史。`)) return;
    const completed = completeProject(project, tasks, taipeiDateKey());
    onSave(projects.map((item) => item.id === project.id ? completed.project : item), completed.tasks);
    setTab("completed");
  };
  return (
    <section className="projects-workspace">
      <header className="project-tabs" role="tablist" aria-label="專案狀態">
        {([
          ["current", "進行中"],
          ["completed", "已完成"],
          ["archived", "封存"],
        ] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}<span>{groups[id].length}</span>
          </button>
        ))}
      </header>
      <div className="project-grid">
      {visibleProjects.length === 0 ? (
        <Empty text="尚未找到 type: project 的 Markdown。" />
      ) : (
        visibleProjects.map((project) => (
          <ProjectEditor
            key={project.id ?? project.name}
            project={project}
            openTasks={
              tasks.filter(
                (task) =>
                  task.projectId === project.id && task.status !== "done",
              ).length
            }
            onSave={(value) => saveProject(project, value)}
            onFocus={(enabled) =>
              void onSave(
                projects.map((item) => ({
                  ...item,
                  focusToday: item.id === project.id ? enabled : false,
                })),
                tasks,
              )
            }
            onComplete={() => finishProject(project)}
            onReopen={() => saveProject(project, { ...project, status: "active", completedAt: null, focusToday: false })}
            onArchive={() => saveProject(project, { ...project, status: "archived", focusToday: false })}
          />
        ))
      )}
      </div>
    </section>
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
}) {
  return (
    <div className="settings-grid">
      <section className="settings-card">
        <span className="step">1</span>
        <h2>Markdown 資料夾</h2>
        <p>按瀏覽資料夾即可用 Windows 選擇器，不需要手動貼路徑。</p>
        <code>{diagnostics?.selectedVault ?? "尚未選擇"}</code>
        <button
          className="browse-button wide"
          disabled={working}
          onClick={onBrowseVault}
        >
          瀏覽資料夾
        </button>
        <details>
          <summary>或手動輸入路徑</summary>
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
              使用此資料夾
            </button>
          </div>
        </details>
      </section>
      <section className="settings-card">
        <span className="step">2</span>
        <h2>雲端同步服務</h2>
        <p>雲端同步是選用功能；此開源版本預設為本機模式，Markdown 正文不會上傳。</p>
        <div className="input-action">
          <input
            value={serverOrigin}
            onChange={(event) => setServerOrigin(event.target.value)}
            readOnly={diagnostics?.syncEnabled === true}
            placeholder="選用：localhost 開發伺服器"
          />
          <button className="primary" disabled={diagnostics?.syncEnabled === true} onClick={onConfigureServer}>
            儲存
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
        <h2>安全配對</h2>
        <p>網站現在只需要下方 8 位碼；不需要填 UUID 或其他安全密碼。</p>
        {devicePaired ? (
          <div className="paired-ok">
            <strong>✓ 已完成安全配對</strong>
            <small>現在可以執行首次同步</small>
          </div>
        ) : pairing ? (
          <div className="pair-code">
            <small>請到網站輸入</small>
            <strong>{pairing.userCode}</strong>
            <span>
              有效至 {new Date(pairing.expiresAt).toLocaleTimeString("zh-TW")}
            </span>
            <button className="primary wide" onClick={onOpenPairingWebsite}>
              在網站輸入配對碼
            </button>
          </div>
        ) : (
          <button
            className="primary wide"
            disabled={working || !serverOrigin}
            onClick={onStartPairing}
          >
            開始配對
          </button>
        )}
      </section>
      <section className="settings-card">
        <span className="step">4</span>
        <h2>同步與復原</h2>
        <p>
          寫入前自動建立 SHA-256 驗證 ZIP；背景只安靜檢查版本，有變更才同步。
        </p>
        {!writeApproved && devicePaired && (
          <div className="first-sync-hint">
            <strong>還差最後一次確認</strong>
            <span>先產生安全預覽；第一次同步完成後，才會啟用自動同步。</span>
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
            ? "請先完成配對"
            : writeApproved
              ? "立即完整同步"
              : "完成首次同步"}
        </button>
        {writeApproved && (
          <button className="secondary-button wide" onClick={onShadow}>
            切回 Shadow 模式
          </button>
        )}
      </section>
    </div>
  );
}

function WorkspaceSearch({
  tasks,
  projects,
  onClose,
  onSelect,
}: {
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  onClose: () => void;
  onSelect: (result: WorkspaceSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"relevance" | "date">("relevance");
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "completed">("all");
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
    { query, sort, status: statusFilter, today: taipeiDateKey() },
  ), [projects, query, sort, statusFilter, tasks]);
  useEffect(() => setActiveIndex(0), [query, sort, statusFilter]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="modal workspace-search"
        role="dialog"
        aria-modal="true"
        aria-label="搜尋任務與專案"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => Math.min(value + 1, results.length - 1)); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)); }
          if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); onSelect(results[activeIndex]); }
        }}
      >
        <div className="search-input-row">
          <Search aria-hidden="true" />
          <input ref={inputRef} aria-label="搜尋關鍵字" placeholder="搜尋任務、專案、相對路徑…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="icon-button" aria-label="關閉搜尋" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
        <div className="search-toolbar">
          <div className="segmented-control" aria-label="排序方式">
            <button className={sort === "relevance" ? "active" : ""} onClick={() => setSort("relevance")}>關聯性</button>
            <button className={sort === "date" ? "active" : ""} onClick={() => setSort("date")}>日期</button>
          </div>
          <select aria-label="狀態篩選" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">全部狀態</option>
            <option value="open">進行中</option>
            <option value="completed">已完成與封存</option>
          </select>
          <span>{results.length} 筆結果</span>
        </div>
        <div className="search-results" role="listbox">
          {results.length === 0 ? <Empty text="找不到相符的任務或專案。" /> : results.map((result, index) => {
            const isTask = result.kind === "task";
            const title = isTask ? result.value.title : result.value.name;
            const meta = isTask
              ? [result.value.projectName, result.value.taskDate, result.value.sourcePath].filter(Boolean).join(" · ")
              : [result.value.area, result.value.status, result.value.endDate].filter(Boolean).join(" · ");
            return (
              <button
                key={`${result.kind}:${result.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onSelect(result)}
              >
                <span className="result-kind">{isTask ? "任務" : "專案"}</span>
                <span><strong>{title}</strong><small>{meta || "未分類"}</small></span>
                {result.date && <time>{result.date}</time>}
              </button>
            );
          })}
        </div>
        <footer>↑↓ 選擇 · Enter 開啟 · Esc 關閉</footer>
      </section>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}
