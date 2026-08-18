# Second Brain Workspace（第二大腦工作區）

一個以本地為優先（local-first）的桌面工作區，用於管理任務、成果專案（outcome projects）與參考收藏（reference collections），全部以一般的 Markdown 檔案儲存。可搭配 Obsidian、VS Code、Typora、Notepad++ 或任何編輯器使用。

## 不需要伺服器也能使用的功能

- Windows 桌面應用程式
- 今日、月/週行事曆、任務看板、專案清單/狀態檢視、本機收藏
- 繁體中文與英文介面，並支援持久化的亮色/暗色主題
- 跨欄位搜尋：用 `+` 表示 OR、用 `&`（或空格）表示 AND、可用引號包住詞組
- 任務、專案、收藏的完整 Markdown 編輯與安全預覽
- 新手草稿模式：先記錄，關閉前再選擇 Markdown 資料夾
- 首次啟動的繁中/英文引導
- Markdown 資料夾掃描與檔案監看
- 本機備份、原子寫入與當機復原日誌
- 可離線使用

雲端同步是可選的。只有在你想從手機或瀏覽器檢視/編輯同一份任務鏡像時，才需要設定相容的 HTTPS 伺服器。

## 安裝

### 給開發者（從原始碼建置）

需求環境：

- Node.js 20 以上
- Rust 穩定工具鏈
- Microsoft WebView2 執行環境
- Tauri 2 Windows 建置前置項目（含 C++ 工作負載的 Visual Studio Build Tools、Windows SDK）

克隆並安裝：

```bash
git clone https://github.com/GsirGinRay/second-brain-workspace.git
cd second-brain-workspace
npm install
```

以開發模式執行桌面程式（含熱重載）：

```bash
npm run desktop:dev
```

### 給一般用戶（Windows 安裝檔）

從 [Releases](https://github.com/GsirGinRay/second-brain-workspace/releases) 頁面下載最新的 NSIS 安裝檔
（檔名為 `Second Brain Workspace_x.y.z_x64-setup.exe`）並執行。升級時會保留你既有的 Markdown 資料夾。

安裝檔可在本機用以下指令產生：

```bash
npm run desktop:installer
```

產出位置為
`apps/desktop/src-tauri/target/release/bundle/nsis/`。

## 開發

在發起 Pull Request 前，請先執行完整的檢查清單：

```bash
npm test            # TypeScript 單元 + 整合 + DOM 測試
npm run rust:test   # Rust（Tauri）測試
npm run build       # 型別檢查與生產環境網頁建置
```

桌面程式使用 Tauri 2（Rust），前端為 React + TypeScript，位於 `apps/desktop`；
共用邏輯放在 `packages/brain-core`（Markdown 解析與任務規則）與 `packages/brain-ui`（行事曆與儲存庫輔助）。

### 內部開發狀態

本倉庫目前用於**內部開發**，由一小群協作者共同進行。發行版本以 `0.x` 版本線的預發布（pre-release）形式釋出
（依語意化版本規範，`0.x` 表示 API 與資料格式仍在穩定中）。
當專案對外開放給更廣大的社群時，會建立一個專屬的「公開發行」標記。
Markdown 檔案格式是長期的真相來源（source of truth），設計上會在各版本間保持穩定。

## 資料格式

```markdown
- [ ] #task 撰寫第一份教學 [[Open Source Launch]] ⏳ 2026-08-15

<!-- second-brain-task-content:00000000-0000-4000-8000-000000000000:start -->
## 筆記

這個任務的完整 Markdown 內容。
<!-- second-brain-task-content:00000000-0000-4000-8000-000000000000:end -->
```

產品邊界說明請見 [docs/architecture.md](docs/architecture.md) 與
[docs/cloud-sync.md](docs/cloud-sync.md)。

## 隱私

本應用程式不會上傳 Markdown 內文。啟用雲端配接器時，只會收到結構化的任務/專案欄位、相對來源路徑與雜湊值。
收藏的 Markdown 內文僅在本機建立索引，不會加入雲端同步計畫。

專案使用 `type: project`，並有有限的生命週期（`planning`、`active`、`paused`、`done` 或 `archived`）。
長期保存的提示與參考筆記使用 `type: collection`，可選擇性帶有 `category` 與 `importance` 前置資料（frontmatter）。

任務狀態 `waiting` 表示工作被某個回覆、素材、核准、日期或其他外部條件阻塞；
它與專案被**刻意** `paused` 是不同的概念。

## 授權

MIT
