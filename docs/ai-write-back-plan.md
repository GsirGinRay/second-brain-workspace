# 計畫：AI 做完自動寫回

狀態：M0～M2 完成（2026-10-25），M3 完成 Grok 與 Antigravity，M4～M6 未開始。對應 [feature-roadmap.md](feature-roadmap.md)「AI 協作」第 1 項。

## 目標

不管使用者今天用哪一家 AI，AI 一開始就知道今天的重點，做完之後結果會留在第二大腦裡，下一家 AI 一句話就接得上。

- 主流 AI 都要涵蓋：Claude、OpenAI（Codex）、Gemini、Grok，以及透過 OpenCode、Qwen Code、Kimi 等工具使用的開源模型。
- 寫回的內容仍是使用者看得懂的 Markdown，App 和任何編輯器都打得開。
- 預設關閉；使用者自己選要連接哪些工具，也可以移除。

## 非目標

- 不記錄完整對話，也不讀對話紀錄檔（transcript）。只寫 AI 自己整理的摘要。
- 不做語意搜尋、不建資料庫。
- App 版的 AI（Claude Desktop、ChatGPT、Gemini 網頁版）留給第 2 項 MCP 伺服器。

## 設計：三層，愈下層支援愈多工具

| 層 | 做法 | 涵蓋 | 狀態 |
| --- | --- | --- | --- |
| 1. 說明檔規則 | INSTRUCTIONS 加「做完要寫回」；入口檔補上 `GEMINI.md`、`QWEN.md` | 所有能讀資料夾的 AI 工具 | ✅ |
| 2. Hooks | 對話開始時帶入今天的重點；對話結束時檢查有沒有寫回，沒有就提醒一次 | Claude Code、Codex、Grok Build、Antigravity、Gemini CLI | ✅（Gemini CLI 無法實測，見下表） |
| 3. MCP | `log_work` 等工具（第 2 項） | App 版 AI、沒有 hooks 的工具 | 未開始 |

### 寫回格式

AI 做完一件事，在對應任務下面追加一段（英文 vault 用 `### AI work log 2026-10-25 10:42 (Codex)` 與 `Done / Result / Next`）：

```markdown
  ### AI 工作紀錄 2026-10-25 10:42（Codex）

  - 做了什麼：……
  - 結果在哪：……
  - 下一步：……
```

- 找不到對應任務時，寫到 `.ai/worklog/YYYY-MM.md`。`.ai/` 底下是給 AI 和程式讀的技術資料夾，一律用英文命名。
- 紀錄就在任務筆記裡，任務詳情直接看得到。`.ai/INDEX.md` 新增「最近 AI 交接」，列出每個任務最新的一筆（`packages/brain-core/src/ai-worklog.ts`）。
- 舊 vault：再按一次「建立知識架構」並勾選「AI 委任架構」，預覽會列出 `.ai/INSTRUCTIONS.md`，確認後只在檔尾補上寫回規則（帶 `<!-- aizbrain:write-back v1 -->` 標記，只補一次），原本的內容不動。

### Hooks 的行為

沒有另外的程式：AI 工具執行 App 本身，`<App>.exe --aizbrain-hook <事件>`，App 回答後就結束，不開視窗（`apps/desktop/src-tauri/src/ai_hook.rs`）。

- **session-start**：讀 `.ai/INDEX.md`，輸出 vault 的完整路徑、「今日最重要」、「最近 AI 交接」和寫回提醒，當作 AI 的背景資訊（`hookSpecificOutput.additionalContext`）。同時記下這次對話開始的時間，以及每個檔案目前有幾筆工作紀錄。
- **stop**（Gemini 是 AfterAgent）：這次對話改了 vault 的 Markdown、但工作紀錄沒有增加，才用 exit 2 提醒一次，四家工具都把 stderr 當成要 AI 繼續的理由。之後同一個對話不再擋。只問問題、沒改檔的對話不打擾；Grok 在結束時多送的一次 Stop（`reason: shutdown`）直接放行。
- **只認 aizbrain 的 vault**：往上找 `.ai/INSTRUCTIONS.md`，而且要是 App 寫的（以 `# Second Brain — INSTRUCTIONS` 開頭，或帶寫回標記）。家目錄裡別的 `.ai/` 規則資料夾不算。
- **一律放行**：讀不到、看不懂、不在 vault 裡，都安靜結束，不影響 AI 工具。
- 狀態檔在 `%LOCALAPPDATA%\aizbrain\hooks\`，7 天後自動清掉。hook 不讀對話，也不寫 vault。

### 安裝

目前用指令安裝，設定頁的按鈕是 M5：

```
<App>.exe --aizbrain-hook install claude <vault 資料夾>
<App>.exe --aizbrain-hook install codex  <vault 資料夾>
<App>.exe --aizbrain-hook install gemini <vault 資料夾>
<App>.exe --aizbrain-hook install antigravity <vault 資料夾>
<App>.exe --aizbrain-hook uninstall <claude|codex|gemini|antigravity> <vault 資料夾>
```

| 工具 | 寫到哪 | 使用者要做的事 |
| --- | --- | --- |
| Claude Code | `<vault>/.claude/settings.json` | 無 |
| Grok Build | 同上（Grok 讀 Claude 的設定檔） | 第一次在 vault 用 `/hooks-trust` 或 `--trust` 信任資料夾 |
| Gemini CLI | `<vault>/.gemini/settings.json`（並設 `hooksConfig.enabled`） | 信任資料夾 |
| Antigravity（CLI、IDE、2.0） | `<vault>/.agents/hooks.json` 裡名為 `aizbrain` 的 hook | 無（資料夾要在信任清單裡） |
| Codex | `~/.codex/hooks.json`（或 `CODEX_HOME`） | 在 Codex 輸入 `/hooks`，審核並信任這兩個 hook |

- Codex 實測時沒有載入專案層的 `.codex/hooks.json`（試過信任資料夾、`git init`、`--dangerously-bypass-hook-trust`），所以改裝在使用者層。hook 自己會判斷是不是在 vault 裡，在別的專案不會做任何事。
- 寫入前把原檔複製成 `<檔名>.aizbrain-backup`；只加、只刪指令裡有 `--aizbrain-hook` 的項目，其他設定不動；原檔不是合法 JSON 就不碰。
- 安裝時記錄的是 App 的完整路徑。路徑有空白時會加引號，但 PowerShell 會把加引號的路徑當成字串，這種情況還沒實測。

## 各工具實測（2026-10-25，Windows）

| 工具 | 版本 | 讀的入口檔 | Hook 輸入（實測） | 結果 |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.310 | `CLAUDE.md` | snake_case：`session_id`、`cwd`、`source`；Stop 有 `stop_hook_active`、`last_assistant_message` | ✅ 開始帶入、自己寫回；故意要它不寫時被提醒一次，它說明原因後結束 |
| Codex CLI | 0.159.2 | `AGENTS.md` | snake_case：`session_id`、`cwd`、`source`、`model`、`permission_mode` | ✅（用 `-c hooks.*` 模擬使用者層設定）開始帶入，寫了英文工作紀錄 |
| Grok Build | 1.0.67 | `AGENTS.md`、`CLAUDE.md` | 同時送 camelCase 和 snake_case；Stop 有 `reason`（`end_turn`／`shutdown`）；SessionStart 的輸出只顯示給使用者，不進模型 | ✅ 讀 `.claude/settings.json`，自己寫回 |
| Gemini CLI | 0.65.0 | `GEMINI.md` | 依官方文件：SessionStart、AfterAgent（exit 2 會重試） | 無法實測：個人 Google 帳號登入後回覆「This client is no longer supported for Gemini Code Assist for individuals」，要改用 Antigravity；只剩 API key 能用 |
| Antigravity CLI（agy） | 1.4.0 | `AGENTS.md`、`GEMINI.md`、`.agents/rules/*.md` | 格式不同：camelCase，沒有 `cwd`（用 `workspacePaths`）、用 `conversationId`；開場回 `injectSteps`；Stop 有 `terminationReason`，要擋就回 `{"decision":"continue"}`；hook 指令以 `cmd /c` 執行。App 用 `--format antigravity` 轉換 | ✅ 開始帶入、自己寫回；要它不寫時被提醒一次，它就補寫了 |
| OpenCode | 2.1.4 | `AGENTS.md` | 沒有 hooks；`.opencode/plugins/` 的外掛 `plugin list` 看得到，但 `opencode run` 沒有收到任何 `session.*` 事件 | 未完成（M4）；說明檔規則照樣有效 |
| Qwen Code | — | `QWEN.md` | — | 未測：免費額度據報已停止 |
| Kimi CLI | — | 待確認 | 第三方比較表說沒有 hooks | 未測：要訂閱 |

測試 vault 與紀錄：`D:\sbw-hookprobe\`（`e2e-zh`、`e2e-en`、`logs/`）。

參考：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Gemini CLI hooks](https://geminicli.com/docs/hooks/)、Grok Build 內建文件 `~/.grok/docs/user-guide/10-hooks.md`、[OpenCode plugins](https://opencode.ai/docs/plugins/)。

## 里程碑

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| M0 | 查證各工具的 hooks 輸入、入口檔名與限制 | ✅ 見上表 |
| M1 | INSTRUCTIONS 寫回規則（中英）、`GEMINI.md`、`QWEN.md`、舊 vault 補規則、INDEX「最近 AI 交接」 | ✅ |
| M2 | hook 模式＋Claude Code、Codex | ✅ 單元測試 11 項；兩個 CLI 實測通過 |
| M3 | Gemini CLI、Grok Build、Antigravity、Qwen Code | Grok ✅、Antigravity ✅；Gemini CLI 程式完成但個人帳號已停用，無法實測；Qwen 未測 |
| M4 | OpenCode 外掛 | 未開始（外掛事件沒觸發，要先查清楚） |
| M5 | 設定頁「連接 AI 工具」 | 未開始 |
| M6 | 文件、發版、影片素材 | 未開始 |

## 還沒做的

- 在別的專案資料夾工作時的寫回（`aizbrain-log` 區塊由 hook 代寫）：hook 目前只讀不寫，留到 M5 一起決定。
- 寫入前過濾金鑰格式：hook 不寫 vault，目前只靠寫回規則提醒 AI 不要寫機密。

## 風險

- 各家 hooks 改版很快，欄位名稱可能變。輸入同時接受 snake_case 與 camelCase；不認得的輸入一律放行。
- 改使用者的 AI 設定檔屬於敏感操作：Codex 只能裝在使用者層，安裝前要說清楚，並保留備份。
- 使用者自己的全域指令可能指向別的「第二大腦」：實測時 Claude 一度以為要改 `D:\G股網\第二大腦`，所以開始時的說明會寫出這個 vault 的完整路徑。

## 已決定（2026-10-25）

- 測試範圍：Claude Code、Codex、Grok Build、OpenCode、Gemini CLI。
- 開源模型（Qwen、Kimi、GLM、DeepSeek）先透過 OpenCode 的 Go 方案測，不另外付費。
- 產品改名 aizbrain 排在 hook 程式之前；hook 指令與設定標記用新名字。
- 技術資料夾與檔名（`.ai/worklog/`、hook 設定標記）一律英文；內容資料夾依建立時的語言（見 roadmap「國際化」）。
- 預設只裝在 vault；Codex 例外，見上方說明。
