# 讓 Obsidian 與 AI 讀得懂：分 session 路線圖

第一次試用後的三個缺口，拆成三次獨立改動。每次開一個 session 只做一項、分別 commit；三項都完成、本機確認後再 push。

| Session | 目標 | 分支上的 commit 主題 |
| --- | --- | --- |
| 1 | 任務時間與筆記改成普通可見 Markdown | `feat: store task time and notes as visible Markdown` |
| 2 | `.ai/INDEX.md` 列出今日/逾期任務與檔案路徑 | `feat: list tasks and paths in the AI vault index` |
| 3 | 第一次啟動就有架構與示範內容 | `feat: first-run architecture and sample content` |

不要在同一個 session 混做下一項。Session 1 會改 Markdown 編碼，Session 2 的 INDEX 必須寫出新格式，Session 3 的示範檔必須用新格式。

## Session 1 — 可見的時間與筆記（本次）

現況：開始時間只在 `<!-- publisher-task:{...} -->` JSON；詳細筆記在 `<!-- second-brain-task-content:... -->` HTML 註解。Obsidian 閱讀模式與部分 AI 會看不到。

改成：

```markdown
- [ ] #task 寫第一份教學 [[Open Source Launch]] ⏳ 2026-08-15 ⏰ 09:30 ⏱ 30m <!-- publisher-task:{...} -->

  ## Notes

  - 可見的任務清單
```

規則：

- 保留 `publisher-task` 相容標記（id / status / rank，時間仍可雙寫進 JSON）。
- 讀：行上的 `⏰` / `⏱` 優先；沒有才回退 JSON。筆記先讀任務下一行的縮排正文，沒有才讀舊 HTML 註解。
- 寫：時間寫成 `⏰ HH:MM`、`⏱ NNm`；筆記寫成任務下一行縮排兩格的普通 Markdown，並刪掉該任務的舊註解區塊。
- 第一次載入時，若檔案仍是舊格式，掃描可一次遷移（有既有備份／原子寫入）。
- 縮排區塊裡的 `- [ ] #task` 範例不得被當成真正任務。
- 保留 BOM、CRLF、未知 token。先補失敗測試再改解析／寫入。

完成後請用本機 vault 打開桌機版，改一個時間、寫一段任務筆記，再用 Obsidian 閱讀模式確認看得到。

## Session 2 — INDEX 要能當 AI 目錄

`.ai/INDEX.md` 目前只有專案表、收藏表與任務數量，沒有任務清單。

改成至少包含：

- 今日任務（標題、時間、專案、`sourcePath`）
- 逾期任務（同上）
- 未排程想法（標題與路徑，上限避免檔案過大）

編碼說明改成 Session 1 的可見格式。不要發明 `publisher_id`。

## Session 3 — 第一次打開就有東西

- 第一次選資料夾後，預設建立知識架構（可預覽、不覆寫既有檔）。
- 附 2–3 筆合成示範：一個專案、一則今日任務（含可見時間與筆記）、一則收藏。
- `examples/sample-vault` 改成與正式資料夾慣例一致（`Projects/`、`Collections/`、`10-收件匣/`），不要把專案／收藏放在根目錄。
- 繁中介面去掉「清單 View」這類中英混用語。

## 每個 session 結束時

1. `npm test`（Markdown 解析變更時必須）。
2. 需要時 `npm run build`。
3. 告訴使用者改了什麼、打開新版本要注意什麼。
4. 一次 commit。不要 push，直到三項都完成。
5. 開新 session 再做下一項。
