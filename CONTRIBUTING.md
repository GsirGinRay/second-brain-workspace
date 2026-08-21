# 如何一起開發（新人練習指南 / 白話版）

我們現在是內部開發階段（0.x 版本），兩個人都在邊做邊學。這段是給我們自己練「多人協作流程」用的，等以後開源，下面的英文規範就是對外標準。

## 三個鐵則
1. **不直接改 main**：main 是正本、受保護。每次修改都開分支 → 發 PR → 互相看過才合併。
2. **改之前先 pull**：`git checkout main && git pull`，抓到最新再開分支。
3. **提交前跑測試**：`npm test` 至少跑一次。

## 一次完整流程
```bash
git checkout main && git pull            # 1. 抓最新
git checkout -b feature/功能名            # 2. 開分支
# 3. 改程式
npm test                                  # 4. 跑測試
git add . && git commit -m "做了什麼"      # 5. 提交
git push -u origin feature/功能名          # 6. 推上去
```
然後到 GitHub 對該分支點「Compare & pull request」發 PR，等對方 review 並按 Approve，
branch protection 會要求「不能直接推 main、合併前至少 1 人批准」，都 OK 後按 Merge。

## 合併流程重點（避開衝突、內容不會被覆蓋）
收到 PR 後照這個順序，一定能避免「內容被覆蓋」：
1. 打開 PR →「Files changed」分頁逐行看（綠＝新增、紅＝刪除），並看頁面頂端的「衝突徽章」。
2. 若顯示「有衝突」：請對方先在 PR 頁面按「Update branch」同步到最新 main；仍有衝突就點
   「Resolve conflicts」在網頁上逐段決定（會同時顯示「你的版本」vs「他的版本」）。
3. 看完沒問題 → 右上「Review changes」→ Approve（滿足 main 需 1 人批准的規則）。
4. 合併一律用「Create a merge commit」（保留雙邊歷史），不要用 Rebase and merge。
5. 合併後在本機：`git pull` → `npm test` → `npm run build`，確認兩邊內容共存。

> 重點：Git 合併＝把兩邊內容併在一起，不會「用新的蓋掉舊的」。只有「衝突」時才需要你
> 手動選擇，決定權在你；所以你的改動不會因為收下別人的 PR 而消失。

> 這是練習場，弄壞也沒關係（私有 repo 外面看不到）。有衝突就叫 GsirGinRay 一起處理。

---

# Contributing

1. Use synthetic data under `examples/sample-vault`; never use a real vault in
   a fixture or screenshot.
2. Add a failing test before changing Markdown parsing, formatting, merge,
   backup, path or recovery behavior.
3. Run `npm test`, `npm run build`, and `npm run rust:test` before opening a pull
   request.
4. Explain any data-format or permission change in the pull request.

Cloud adapters must use an explicit origin allowlist. Do not broaden the Tauri
Content Security Policy to arbitrary Internet origins.
