/**
 * Vault-architecture template packs for the "建立 New" onboarding.
 *
 * Each pack describes a set of folders and starter Markdown files that let a
 * brand-new user scaffold a working Second Brain architecture in one step and
 * immediately feel the tool is powerful. Packs are:
 *
 * - "knowledge"  個人知識庫   -> Collections/ (references)
 * - "projects"   專案管理     -> intake inbox (10-收件匣)
 * - "prompts"    提示詞庫     -> Prompts/ + a sample reusable prompt
 * - "ai"         AI 委任架構  -> .ai/INSTRUCTIONS.md + entry files + INDEX
 * - "templates"  模板套件     -> 90-模板/ starter entity templates
 *
 * The desktop app turns the resulting file map into atomic `create` changes and
 * skips any file that already exists (checked via readMarkdownFiles).
 */

export type TemplatePackId =
  | "knowledge"
  | "projects"
  | "prompts"
  | "ai"
  | "templates";

export interface TemplatePack {
  id: TemplatePackId;
  label: string;
  description: string;
  files: Record<string, string>;
}

const INDEX_SCAFFOLD = `# Second Brain — Vault Index

> 此索引由 Second Brain Workspace 自動再生。開啟 App 並載入資料夾後，
> 此檔會由實際的專案／任務／收藏內容更新。
> This index is regenerated automatically once the vault is loaded.
`;

const INSTRUCTIONS = `# Second Brain — INSTRUCTIONS（正本 / Canonical）

> 手寫正本，任何 AI 都以此為準。此檔由你維護；下方的 .ai/INDEX.md 為自動索引。
> Human-owned canonical handoff. Any AI should follow this file; .ai/INDEX.md is the machine index.

## 你的第二大腦（Your second brain）

這是一個本機優先、以普通 Markdown 為唯一真相來源的知識架構。任務、成果專案
與收藏都存放在這個資料夾裡，任何 Markdown 編輯器或 AI 工具都能直接讀寫。

## 讀取順序（Read order for AI）

1. 先閱讀本檔（.ai/INSTRUCTIONS.md）——這是作者的規則。
2. 再閱讀 .ai/INDEX.md——裡面有目前的專案／任務／收藏清單與編碼規格。
3. 依索引操作：做專案管理、維護任務清單；變數與重用內容放 Collections 的「提示詞」分類。

## 準則（Rules）

- 保留未知符號、BOM、CRLF 與縮排；不要重排與你無關的內容。
- 不要上傳 Markdown 正文；在本機就地編輯。
- 任務可用一行 \`- [ ] #task 標題 [[專案名]] ⏳ YYYY-MM-DD\` 表示。
- 專案與收藏用 YAML frontmatter（type: project / collection）放在 Projects/ 與 Collections/。
- 可重用提示詞的 category 請以 \`提示詞/\` 開頭，例如 \`提示詞/投資分析\`。
`;

const CLAUDE_ENTRY = `# See .ai/INSTRUCTIONS.md

This vault is managed by a canonical instruction file. Read \`.ai/INSTRUCTIONS.md\`
first, then \`.ai/INDEX.md\`, then operate on the Markdown in place.
`;

const AGENTS_ENTRY = `# See .ai/INSTRUCTIONS.md

This vault is managed by a canonical instruction file. Read \`.ai/INSTRUCTIONS.md\`
first, then \`.ai/INDEX.md\`, then operate on the Markdown in place.
`;

const SAMPLE_PROMPT = `---
type: collection
category: 提示詞/投資分析
importance: 1
---
# 股票選股分析

你是一位專業的股票選股分析專家。請分析 Excel 檔案中的股票數據，按以下步驟工作：

【第一步】數據解析 — 讀取每檔股票的基本面（EPS、ROE、營收增長率、淨利率等）
與籌碼面（融資融券、大戶持股、機構投資者比例）。

【第二步】題材性評估 — 依產業機遇、需求側信號、供給側信號、價格位置、籌碼面支撐五個維度評估。

【第三步】綜合評分排序 — 以題材性 60%、基本面 20%、籌碼面 20% 綜合評分，排出 Top5。

【第四步】詳細分析 — 每檔股票提供核心題材原因、基本面亮點、籌碼面買點信號、潛在風險、推薦價位或買入策略。

【第五步】呈現格式 — 使用清晰表格或結構化文本，便於快速理解與執行投資決策。
`;

const PROMPTS_README = `# Prompts（提示詞庫）

建立可重用的提示詞時，請在收藏中建立 \`type: collection\`，並將 \`category\` 設為
\`提示詞/<子類別>\`（例如 \`提示詞/投資分析\`）。提示詞正文可包含 \`[變數]\` 佔位符，
供複製或插入時填寫。此資料夾暫存提示詞相關的參考與備註。
`;

const INBOX = `# 待辦收件匣

未排程的想法先放這裡。可在 App 的今日／日曆中把想法拖曳到日期以排程。
`;

const TEMPLATE_PROJECT = `---
type: template
template_kind: project
ai_hint: 通用專案模板，包含背景、目標與下一步。
---
# {{專案名稱}}

## 背景
{{背景}}

## 目標
{{目標}}

## 下一步
- [ ] 定義成功標準
- [ ] 拆解第一個可交付成果
`;

const PROJECTS_README = `# Projects

存放有明確成果、需要多個行動的專案。每個專案是一個 Markdown 檔，使用
\`type: project\` frontmatter（status / area / priority / progress / focus_today / dates）。
`;

const COLLECTIONS_README = `# Collections

存放會重複查閱的參考資料與可重用提示詞。每個收藏是一個 Markdown 檔，使用
\`type: collection\` frontmatter（category / importance）。提示詞請用
\`category: 提示詞/…\`，例如 \`提示詞/投資分析\`。
`;

export const TEMPLATE_PACKS: ReadonlyArray<TemplatePack> = [
  {
    id: "projects",
    label: "專案管理",
    description: "建立專案資料夾與待辦收件匣，立刻開始排程與看板。",
    files: {
      "10-收件匣/待辦收件匣.md": INBOX,
      "Projects/README.md": PROJECTS_README,
    },
  },
  {
    id: "knowledge",
    label: "個人知識庫",
    description: "建立收藏資料夾，集中參考資料與長期知識。",
    files: {
      "Collections/README.md": COLLECTIONS_README,
    },
  },
  {
    id: "prompts",
    label: "提示詞庫",
    description: "附一支股票選股分析範例，建立可重用提示詞的起點。",
    files: {
      "Prompts/README.md": PROMPTS_README,
      "Collections/股票選股分析.md": SAMPLE_PROMPT,
    },
  },
  {
    id: "ai",
    label: "AI 委任架構",
    description: "產生 INSTRUCTIONS 正本、自動索引與 CLAUDE/AGENTS 入口，讓任何 AI 秒懂。",
    files: {
      ".ai/INSTRUCTIONS.md": INSTRUCTIONS,
      ".ai/INDEX.md": INDEX_SCAFFOLD,
      "CLAUDE.md": CLAUDE_ENTRY,
      "AGENTS.md": AGENTS_ENTRY,
    },
  },
  {
    id: "templates",
    label: "模板套件",
    description: "建立 90-模板 資料夾與一張範例專案模板，之後可一鍵套用。",
    files: {
      "90-模板/通用專案.md": TEMPLATE_PROJECT,
    },
  },
];

export const TEMPLATE_PACK_BY_ID: Readonly<Record<TemplatePackId, TemplatePack>> =
  Object.fromEntries(TEMPLATE_PACKS.map((pack) => [pack.id, pack])) as Record<
    TemplatePackId,
    TemplatePack
  >;

/** Merge the file maps of the requested packs (later packs win on conflicts). */
export function scaffoldTemplateFiles(
  ids: readonly TemplatePackId[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const pack = TEMPLATE_PACK_BY_ID[id];
    if (!pack) continue;
    for (const [path, content] of Object.entries(pack.files)) {
      out[path] = content;
    }
  }
  return out;
}
