/**
 * Vault-architecture template packs for "建立知識架構".
 *
 * First-run writes only deletable generic samples (a Getting Started project,
 * three teaching tasks, and a neutral collection). Packs are opt-in later;
 * projects and knowledge are selected by default. Packs are:
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
  /** When false, the pack is opt-in (「之後需要再加」). Defaults to true. */
  defaultSelected?: boolean;
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
- 任務可用一行 \`- [ ] #task 標題 [[專案名]] ⏳ YYYY-MM-DD ⏰ HH:MM ⏱ 30m\` 表示；詳細筆記縮排寫在該行下面，Obsidian 與 AI 都看得到。
- 專案與收藏用 YAML frontmatter（type: project / collection）放在 Projects/ 與 Collections/。
- 可重用提示詞的 category 請以 \`提示詞/\` 開頭，例如 \`提示詞/會議紀錄\`。
`;

const CLAUDE_ENTRY = `# See .ai/INSTRUCTIONS.md

This vault is managed by a canonical instruction file. Read \`.ai/INSTRUCTIONS.md\`
first, then \`.ai/INDEX.md\`, then operate on the Markdown in place.
`;

const AGENTS_ENTRY = `# See .ai/INSTRUCTIONS.md

This vault is managed by a canonical instruction file. Read \`.ai/INSTRUCTIONS.md\`
first, then \`.ai/INDEX.md\`, then operate on the Markdown in place.
`;

const MEETING_PROMPT = `---
type: collection
category: 提示詞/會議紀錄
importance: 1
---
# 會議紀錄

請把這次會議整理成可追蹤的紀錄：

【出席】列出與會者與角色
【結論】用條列寫出達成的決定
【待辦】每項待辦包含負責人與日期
【未決】記下還沒有結論、需要下次討論的問題

請用清楚小標與條列，方便之後查閱。可直接改名或刪除這則範例。
`;

const OUTLINE_PROMPT = `---
type: collection
category: 提示詞/寫作大綱
importance: 1
---
# 寫作大綱

請為以下主題草擬一份寫作大綱：

【主題】{{主題}}
【讀者】{{讀者}}
【目的】{{目的}}

請輸出：
1. 一句話核心主張
2. 三到五個段落標題，每段附一句要表達的重點
3. 結尾行動或結論

可直接改名或刪除這則範例。
`;

const PROMPTS_README = `# Prompts（提示詞庫）

建立可重用的提示詞時，請在收藏中建立 \`type: collection\`，並將 \`category\` 設為
\`提示詞/<子類別>\`（例如 \`提示詞/會議紀錄\`）。提示詞正文可包含 \`[變數]\` 佔位符，
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
\`category: 提示詞/…\`，例如 \`提示詞/會議紀錄\`。
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
    description: "之後需要再加。附會議紀錄與寫作大綱範例，作為可重用提示詞的起點。",
    defaultSelected: false,
    files: {
      "Prompts/README.md": PROMPTS_README,
      "Collections/會議紀錄.md": MEETING_PROMPT,
      "Collections/寫作大綱.md": OUTLINE_PROMPT,
    },
  },
  {
    id: "ai",
    label: "AI 委任架構",
    description: "之後需要再加。產生 INSTRUCTIONS 正本、自動索引與 CLAUDE/AGENTS 入口，讓任何 AI 秒懂。",
    defaultSelected: false,
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
    description: "之後需要再加。建立 90-模板 資料夾與一張範例專案模板，之後可一鍵套用。",
    defaultSelected: false,
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

export const DEFAULT_ARCHITECTURE_PACK_IDS: readonly TemplatePackId[] =
  TEMPLATE_PACKS.filter((pack) => pack.defaultSelected !== false).map(
    (pack) => pack.id,
  );

export interface ScaffoldFileOptions {
  /** Calendar date (`YYYY-MM-DD`) stamped onto the first-run sample task. */
  today?: string;
  /** Mint project/collection ids. Defaults to `crypto.randomUUID()`. */
  createId?: () => string;
  /** Overlay the deletable first-run samples (project, three teaching tasks, collection). */
  samples?: boolean;
}

function ensureEntityId(content: string, createId: () => string): string {
  if (!/^type: (project|collection)$/m.test(content)) return content;
  if (/^(id|publisher_id):/m.test(content)) return content;
  return content.replace(
    /^(type: (?:project|collection))$/m,
    `$1\nid: ${createId()}`,
  );
}

function scaffoldSampleFiles(
  today: string,
  createId: () => string,
): Record<string, string> {
  const projectId = createId();
  const collectionId = createId();
  return {
    "Projects/開始使用.md": `---
type: project
id: ${projectId}
status: active
area: 
priority: 2
progress: 0
focus_today: true
start_date: ${today}
end_date: 
completed_at: 
---
# 開始使用

這是示範專案，用來練習看板、日曆與任務筆記。可直接改名或刪除。
`,
    "Collections/以後要查的資料.md": `---
type: collection
id: ${collectionId}
category: 參考
importance: 2
---
# 以後要查的資料

以後會重複查閱的參考資料放這裡。這則是合成示範，可直接改名或刪除。
`,
    "10-收件匣/待辦收件匣.md": `# 待辦收件匣

未排程的想法先放這裡。可在 App 的今日／日曆中把想法拖曳到日期以排程。

- [ ] #task 完成這一則 [[開始使用]] ⏳ ${today}

- [ ] #task 把它排到今天或日曆 [[開始使用]] ⏳ ${today} ⏰ 09:30 ⏱ 30m

- [ ] #task 在任務下面寫一段筆記 [[開始使用]] ⏳ ${today}

  ## Notes

  - 縮排寫在這一則下面
  - 可直接改或刪
`,
  };
}

/** Merge the file maps of the requested packs (later packs win on conflicts). */
export function scaffoldTemplateFiles(
  ids: readonly TemplatePackId[],
  options: ScaffoldFileOptions = {},
): Record<string, string> {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const out: Record<string, string> = {};
  for (const id of ids) {
    const pack = TEMPLATE_PACK_BY_ID[id];
    if (!pack) continue;
    for (const [path, content] of Object.entries(pack.files)) {
      out[path] = ensureEntityId(content, createId);
    }
  }
  if (options.samples) {
    if (!options.today) throw new Error("SCAFFOLD_TODAY_REQUIRED");
    for (const [path, content] of Object.entries(
      scaffoldSampleFiles(options.today, createId),
    )) {
      out[path] = content;
    }
  }
  return out;
}
