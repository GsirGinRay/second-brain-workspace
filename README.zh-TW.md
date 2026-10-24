# 第二大腦（Second Brain Workspace）

[English](README.md)

給「每天事情很多」的人用的 Windows 任務與專案管理工具。所有資料都是你電腦裡的一般 Markdown 檔，可以同時用 Obsidian、VS Code 或任何編輯器開啟；不需要帳號，也不會把你的筆記上傳到雲端。

## 下載與安裝

1. 到 [最新版本頁面](https://github.com/GsirGinRay/second-brain-workspace/releases/latest) 下載 `Second-Brain-Workspace_x.y.z_x64-setup.exe`。
2. 執行安裝檔。
3. 第一次打開時選一個資料夾存放 Markdown（可以先不選，關閉前再選）。

### 看到「Windows 已保護您的電腦」怎麼辦？

這是 Windows SmartScreen 對「還沒有付費程式碼簽章」的新軟體的標準警告，不代表有病毒。第二大腦是開源軟體，所有程式碼都在這個頁面上公開。

1. 在藍色視窗點 **「其他資訊」**。
2. 按 **「仍要執行」**。

只有第一次安裝會出現。之後的更新由 App 自動下載，並用內建的公開金鑰驗證簽章，確認是官方發布的版本才會安裝。

### 更新

App 啟動時和每 6 小時會檢查新版本，有更新時會詢問你是否安裝。更新不會動到你的 Markdown 資料夾。

## 功能

**今天要做什麼**
- 今天頁：今天最重要的一件事、時間軸、未排時間的任務
- 負荷提醒：今天排的時數超過可用時間時會提醒
- 專注模式：一次只看一件事，計時，做完再換下一件
- 收工：一鍵把沒做完的移到明天，看看今天完成了什麼
- 「等待別人」清單：交辦出去的事集中追蹤，時間到了會標示
- 回顧：這週完成幾件、哪個專案進展最多，可以往回看 12 週

**排程與整理**
- 月曆／週曆，拖曳任務就能改日期；可以框選多個一起拖曳或刪除
- 任務看板，也能切換成表格或清單
- 專案：卡片、表格、狀態三種檢視；任務、筆記、附件都在專案裡
- 知識：常用提示詞、參考筆記，可以匯入匯出提示詞
- 跨欄位搜尋：`+` 表示「或」，`&` 或空白表示「且」

**記錄任務**
- 快速新增（按 `N`）：直接打「明天下午三點 繳電話費」，日期時間會自動辨識
- 重複任務：每天、每週幾、每月幾號，也能自訂間隔
- 任務裡的勾選清單，卡片上會顯示完成進度
- Windows 通知：任務開始前提醒，每天早上一則今日摘要

**手機**
- 手機收件匣（免費）：配對一次，從手機（或其他 App 的分享選單）送出的任務會端對端加密送到電腦的收件匣
- 手機今天清單（Skool 付費會員）：在手機上看今天和接下來 7 天的任務，可以勾選完成、改期、設為今天最重要

**其他**
- 繁體中文／英文介面，淺色／深色主題
- 復原與重做（`Ctrl+Z`／`Ctrl+Shift+Z`）
- 自動產生 `.ai/INDEX.md`，讓 AI 助理快速找到你的專案、知識和今天的任務

## 你的資料就是 Markdown

App 裡的每個操作都直接寫進你選的資料夾，沒有另外一份資料庫。任務長這樣：

```markdown
- [ ] #task 撰寫第一份教學 [[Open Source Launch]] ⏳ 2026-08-15 ⏰ 09:30 ⏱ 30m

  ## 筆記

  這個任務的完整 Markdown 內容。
```

- 重複規則等寫法與 Obsidian Tasks 相容，換到別的工具也讀得懂。
- 每次寫入前會先建立並驗證備份，再用原子寫入，中途當機也不會只寫一半。
- 想在手機上看同一份檔案，可以把資料夾放進 OneDrive、Dropbox、Google 雲端硬碟或 Obsidian Sync。

## 隱私

- 你的 Markdown 不會被上傳，讀寫都只發生在你選的資料夾。
- App 只在兩種情況連網：檢查更新，以及你配對手機之後接收手機送來的任務。
- 手機送來的任務先在手機上加密，只有你的電腦能解開；中繼伺服器 `inbox.aizbrain.com` 只暫存看不懂的資料，電腦收到後立刻刪除（最多保留 14 天）。細節見 [docs/inbox-relay.md](docs/inbox-relay.md)。

## 給開發者

需要 Node.js 20 以上、Rust stable、Microsoft WebView2，以及 Tauri 2 的 Windows 建置環境（含 C++ 工作負載的 Visual Studio Build Tools、Windows SDK）。

```bash
git clone https://github.com/GsirGinRay/second-brain-workspace.git
cd second-brain-workspace
npm install
npm run desktop:dev   # 開發模式
npm test              # TypeScript 單元、整合與 DOM 測試
npm run rust:test     # Rust 測試
npm run build         # 型別檢查與網頁建置
```

| 資料夾 | 內容 |
| --- | --- |
| `apps/desktop` | 桌面 App：Tauri 2（Rust）＋ React、TypeScript |
| `apps/mobile-capture` | 手機網頁（PWA） |
| `packages/brain-core` | Markdown 解析、任務規則、加密格式 |
| `packages/brain-ui` | 行事曆與搜尋等共用邏輯 |
| `services/inbox-relay` | 手機收件匣的中繼伺服器（Rust） |
| `examples/sample-vault` | 範例資料（全部是虛構內容） |

貢獻方式見 [CONTRIBUTING.md](CONTRIBUTING.md)，架構說明見 [docs/architecture.md](docs/architecture.md)。

## 授權

MIT
