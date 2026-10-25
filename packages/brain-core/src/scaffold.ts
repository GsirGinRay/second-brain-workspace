/**
 * Vault-architecture template packs for "建立知識架構".
 *
 * First-run writes only deletable generic samples (a Getting Started project,
 * three teaching tasks, and a neutral collection). Packs are opt-in later;
 * projects and knowledge are selected by default. Packs are:
 *
 * - "knowledge"  個人知識庫   -> 知識/ (references; category folders later)
 * - "projects"   專案管理     -> 專案/ + 收件匣/待辦.md
 * - "prompts"    提示詞庫     -> 知識/提示詞/ + sample reusable prompts
 * - "ai"         AI 委任架構  -> .ai/INSTRUCTIONS.md + entry files + INDEX
 * - "templates"  模板套件     -> 模板/ starter entity templates
 *
 * Folder names and file contents follow the vault layout: an English vault
 * gets Inbox/Projects/Knowledge/… with English samples.
 *
 * The desktop app turns the resulting file map into atomic `create` changes and
 * skips any file that already exists (checked via readMarkdownFiles).
 */

import {
  activeVaultLayout,
  vaultLayoutFor,
  type VaultLayout,
  type VaultLocale,
} from "./vault-paths";
import { AI_WORKLOG_DIR } from "./ai-worklog";

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

/** AI tools that read their own root file; each points at the canonical handoff. */
export const AI_ENTRY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "QWEN.md"] as const;

/** Marks the write-back section so an older INSTRUCTIONS.md can be upgraded once. */
export const WRITE_BACK_MARKER = "<!-- aizbrain:write-back v1 -->";

function indexScaffold(layout: VaultLayout): string {
  const zh = layout.locale === "en"
    ? ""
    : "> 此索引由 aizbrain 自動再生。開啟 App 並載入資料夾後，\n> 此檔會由實際的專案／任務／收藏內容更新。\n";
  return `# Second Brain — Vault Index

${zh}> This index is regenerated automatically once the vault is loaded.
`;
}

const ENTRY = `# See .ai/INSTRUCTIONS.md

This vault is managed by a canonical instruction file. Read \`.ai/INSTRUCTIONS.md\`
first, then \`.ai/INDEX.md\`, then operate on the Markdown in place. When you
finish a piece of work, write it back as the instructions describe.
`;

function writeBackSection(layout: VaultLayout): string {
  if (layout.locale === "en") {
    return `${WRITE_BACK_MARKER}
## Write back when you finish

Every time you finish a piece of work for the user (or stop partway), add a work
log under the matching task so the next AI can pick it up:

\`\`\`
- [ ] #task Summarize the earnings call ⏳ 2026-10-25

  ### AI work log 2026-10-25 10:42 (Codex)

  - Done: …
  - Result: …
  - Next: …
\`\`\`

- Indent it two spaces under the task line. Use local time, and put your tool
  name in brackets (Claude Code, Codex, Antigravity, Grok, OpenCode, …).
- When no task matches, append the same block to \`${AI_WORKLOG_DIR}/YYYY-MM.md\`
  (create it if needed) and name the work after the time.
- Write a short summary, not the conversation. Never write API keys, passwords,
  tokens or personal data.
- When the task is done, change \`- [ ]\` to \`- [x]\`.
`;
  }
  return `${WRITE_BACK_MARKER}
## 做完要寫回（Write back）

每次替使用者做完一件事（或做到一半要停），在對應任務下面追加一段工作紀錄，
讓下一個 AI 接得上：

\`\`\`
- [ ] #task 整理法說會重點 ⏳ 2026-10-25

  ### AI 工作紀錄 2026-10-25 10:42（Codex）

  - 做了什麼：……
  - 結果在哪：……
  - 下一步：……
\`\`\`

- 縮排兩格寫在任務那一行下面。時間用本地時間，括號寫你的工具名稱
  （Claude Code、Codex、Antigravity、Grok、OpenCode……）。
- 找不到對應任務時，把同樣的段落追加到 \`${AI_WORKLOG_DIR}/YYYY-MM.md\`（沒有就建立），
  並在時間後面寫做的是什麼事。
- 只寫摘要，不要貼整段對話；不要寫入 API key、密碼、token 或個資。
- 任務完成就把 \`- [ ]\` 改成 \`- [x]\`。
`;
}

function instructions(layout: VaultLayout): string {
  const inbox = `${layout.inboxDir}/${layout.inboxFile}`;
  if (layout.locale === "en") {
    return `# Second Brain — INSTRUCTIONS (Canonical)

> Human-owned canonical handoff. Any AI should follow this file; .ai/INDEX.md is the machine index.

## Your second brain

A local-first knowledge vault where plain Markdown is the only source of truth.
Tasks, projects and knowledge all live in this folder, so any Markdown editor or
AI tool can read and write them.

| Folder | Holds |
| --- | --- |
| \`${inbox}\` | Tasks that belong to no project |
| \`${layout.projectsDir}/\` | One Markdown file per project (\`type: project\`) |
| \`${layout.knowledgeDir}/\` | Reference notes and prompts (\`type: collection\`) |
| \`${layout.journalDir}/\` | Daily journal, \`YYYY-MM-DD.md\` |
| \`${AI_WORKLOG_DIR}/\` | AI work logs that match no task |

## Read order for AI

1. Read this file (.ai/INSTRUCTIONS.md) first; these are the owner's rules.
2. Then read .ai/INDEX.md, a short map: projects in progress, today and overdue
   tasks, important knowledge, today's journal, unscheduled ideas, recent AI handoffs.
3. Open only one file that INDEX lists; do not read the whole inbox.

## Rules

- Preserve unknown tokens, BOM, CRLF and indentation; do not reorder unrelated content.
- Do not upload Markdown content; edit it in place.
- Projects and knowledge use YAML frontmatter (type: project / collection) in
  \`${layout.projectsDir}/\` and \`${layout.knowledgeDir}/\`.
- Reusable prompts use a category starting with \`${layout.promptsCategory}/\`, for example \`${layout.promptsCategory}/Meeting notes\`.

## Adding a task line

Append a line to the file INDEX lists; do not read the whole inbox:

\`\`\`
- [ ] #task Write the report [[Project name]] ⏳ 2026-08-15 ⏰ 09:30 ⏱ 30m

  Optional notes, as indented Markdown.
\`\`\`

The scanner assigns the id; do not invent one.

For a repeating task put \`🔁 every …\` (Obsidian Tasks syntax) before the date, for example
\`🔁 every day\`, \`🔁 every week on Monday\`, \`🔁 every month on the 5th\`.
The app creates the next one when this one is completed; do not copy the line yourself.

## Priority

- \`🔺\` P1 most important today: one per day. When asked for today's most important task, use "Most important today (P1)" in INDEX.
- \`⏫\` P2 high, \`🔼\` P3 medium, no symbol is P4 normal, \`🔽\` P5 low.

${writeBackSection(layout)}`;
  }
  return `# Second Brain — INSTRUCTIONS（正本 / Canonical）

> 手寫正本，任何 AI 都以此為準。此檔由你維護；下方的 .ai/INDEX.md 為自動索引。
> Human-owned canonical handoff. Any AI should follow this file; .ai/INDEX.md is the machine index.

## 你的第二大腦（Your second brain）

這是一個本機優先、以普通 Markdown 為唯一真相來源的知識架構。任務、成果專案
與收藏都存放在這個資料夾裡，任何 Markdown 編輯器或 AI 工具都能直接讀寫。

| 資料夾 | 放什麼 |
| --- | --- |
| \`${inbox}\` | 不屬於任何專案的任務 |
| \`${layout.projectsDir}/\` | 每個專案一個 Markdown 檔（\`type: project\`） |
| \`${layout.knowledgeDir}/\` | 參考資料與提示詞（\`type: collection\`） |
| \`${layout.journalDir}/\` | 每日日誌 \`YYYY-MM-DD.md\` |
| \`${AI_WORKLOG_DIR}/\` | 找不到對應任務的 AI 工作紀錄 |

## 讀取順序（Read order for AI）

1. 先閱讀本檔（.ai/INSTRUCTIONS.md）——這是作者的規則。
2. 再閱讀 .ai/INDEX.md——短地圖：進行中專案、今日／逾期任務、常用知識、今日日誌、未排程想法、最近 AI 交接。
3. 只打開 INDEX 列出的一個檔；不要讀整本收件匣。

## 準則（Rules）

- 保留未知符號、BOM、CRLF 與縮排；不要重排與你無關的內容。
- 不要上傳 Markdown 正文；在本機就地編輯。
- 專案與知識用 YAML frontmatter（type: project / collection）放在 ${layout.projectsDir}/ 與 ${layout.knowledgeDir}/。
- 可重用提示詞的 category 請以 \`${layout.promptsCategory}/\` 開頭，例如 \`${layout.promptsCategory}/會議紀錄\`。

## 如何新增一行任務

在 INDEX 列出的那個檔追加一行，不要讀整本收件匣：

\`\`\`
- [ ] #task 寫報告 [[專案名]] ⏳ 2026-08-15 ⏰ 09:30 ⏱ 30m

  可選筆記，用一般縮排 Markdown。
\`\`\`

掃描器會自動指定 id；不要自己發明 id。

重複任務在日期前加 \`🔁 every …\`（Obsidian Tasks 寫法），例如
\`🔁 every day\`、\`🔁 every week on Monday\`、\`🔁 every month on the 5th\`。
完成時 App 會自動建立下一次，不要自己複製下一行。

## 優先度（Priority）

- \`🔺\` P1 今日最重要：同一天只有一項。被問到「今天最重要的任務」時，以 INDEX 的「今日最重要（P1）」為準。
- \`⏫\` P2 高、\`🔼\` P3 中、沒有符號是 P4 一般、\`🔽\` P5 低。

${writeBackSection(layout)}`;
}

/** The section an older INSTRUCTIONS.md gets appended when it lacks the marker. */
export function instructionsWriteBackAppendix(layout: VaultLayout = activeVaultLayout()): string {
  return `\n${writeBackSection(layout)}`;
}

interface PackCopy {
  label: string;
  description: string;
}

const PACK_COPY: Record<VaultLocale, Record<TemplatePackId, PackCopy>> = {
  "zh-TW": {
    projects: { label: "專案管理", description: "建立專案資料夾與待辦收件匣，立刻開始排程與看板。" },
    knowledge: { label: "個人知識庫", description: "建立收藏資料夾，集中參考資料與長期知識。" },
    prompts: { label: "提示詞庫", description: "之後需要再加。附會議紀錄與寫作大綱範例，作為可重用提示詞的起點。" },
    ai: { label: "AI 委任架構", description: "之後需要再加。產生 INSTRUCTIONS 正本、自動索引與 CLAUDE/AGENTS/GEMINI/QWEN 入口，讓任何 AI 秒懂、做完會寫回。" },
    templates: { label: "模板套件", description: "之後需要再加。建立 模板 資料夾與一張範例專案模板，之後可一鍵套用。" },
  },
  en: {
    projects: { label: "Projects", description: "Create the projects folder and the inbox, then schedule and use the board right away." },
    knowledge: { label: "Knowledge", description: "Create the knowledge folder for reference notes you keep coming back to." },
    prompts: { label: "Prompt library", description: "Add later if you need it. Includes meeting-notes and outline examples to start reusable prompts." },
    ai: { label: "AI handoff", description: "Add later if you need it. Writes the canonical INSTRUCTIONS, an automatic index and CLAUDE/AGENTS/GEMINI/QWEN entry files so any AI understands the vault and writes back." },
    templates: { label: "Templates", description: "Add later if you need it. Creates the Templates folder with a sample project template you can apply in one click." },
  },
};

interface ContentCopy {
  inbox: string;
  projectsReadme: string;
  knowledgeReadme: string;
  promptsReadme: string;
  meetingPrompt: string;
  outlinePrompt: string;
  meetingFile: string;
  outlineFile: string;
  templateProject: string;
  templateFile: string;
}

function contentCopy(layout: VaultLayout): ContentCopy {
  const prompts = layout.promptsCategory;
  if (layout.locale === "en") {
    return {
      inbox: `# Inbox

Unscheduled ideas start here. Drag an idea onto a date in Today or the calendar to schedule it.
`,
      projectsReadme: `# Projects

Projects with a clear outcome that need several actions. Each project is one Markdown file with
\`type: project\` frontmatter (status / area / priority / progress / focus_today / dates).
`,
      knowledgeReadme: `# Knowledge

Reference notes and reusable prompts you look up again and again. Each note is one Markdown file
with \`type: collection\` frontmatter (category / importance). Prompts use \`category: ${prompts}/…\`.
`,
      promptsReadme: `# Prompts

To keep a reusable prompt, create a \`type: collection\` note in Knowledge and set \`category\` to
\`${prompts}/<subcategory>\` (for example \`${prompts}/Meeting notes\`). A prompt can contain \`[variable]\`
placeholders to fill in when you copy or insert it.
`,
      meetingPrompt: `---
type: collection
category: ${prompts}/Meeting notes
importance: 1
---
# Meeting notes

Turn this meeting into notes we can follow up on:

[Attendees] who joined and their roles
[Decisions] what was decided, as a list
[Actions] each action with an owner and a date
[Open] questions that still need a decision

Use clear subheadings and lists. Rename or delete this example as you like.
`,
      outlinePrompt: `---
type: collection
category: ${prompts}/Writing outline
importance: 1
---
# Writing outline

Draft an outline for this topic:

[Topic] {{topic}}
[Readers] {{readers}}
[Goal] {{goal}}

Give me:
1. The core point in one sentence
2. Three to five section headings, each with one sentence on its point
3. A closing action or conclusion

Rename or delete this example as you like.
`,
      meetingFile: "Meeting notes.md",
      outlineFile: "Writing outline.md",
      templateProject: `---
type: template
template_kind: project
ai_hint: General project template with background, goal and next steps.
---
# {{Project name}}

## Background
{{Background}}

## Goal
{{Goal}}

## Next steps
- [ ] Define what success looks like
- [ ] Break out the first deliverable
`,
      templateFile: "General project.md",
    };
  }
  return {
    inbox: `# 待辦

未排程的想法先放這裡。可在 App 的今日／日曆中把想法拖曳到日期以排程。
`,
    projectsReadme: `# 專案

存放有明確成果、需要多個行動的專案。每個專案是一個 Markdown 檔，使用
\`type: project\` frontmatter（status / area / priority / progress / focus_today / dates）。
`,
    knowledgeReadme: `# 知識

存放會重複查閱的參考資料與可重用提示詞。每個知識檔是一個 Markdown 檔，使用
\`type: collection\` frontmatter（category / importance）。分類資料夾之後可再細分：
FAQ、產業、社群、影片、方法、提示詞。提示詞請用 \`category: ${prompts}/…\`。
`,
    promptsReadme: `# 提示詞

建立可重用的提示詞時，請在知識庫中建立 \`type: collection\`，並將 \`category\` 設為
\`${prompts}/<子類別>\`（例如 \`${prompts}/會議紀錄\`）。提示詞正文可包含 \`[變數]\` 佔位符，
供複製或插入時填寫。
`,
    meetingPrompt: `---
type: collection
category: ${prompts}/會議紀錄
importance: 1
---
# 會議紀錄

請把這次會議整理成可追蹤的紀錄：

【出席】列出與會者與角色
【結論】用條列寫出達成的決定
【待辦】每項待辦包含負責人與日期
【未決】記下還沒有結論、需要下次討論的問題

請用清楚小標與條列，方便之後查閱。可直接改名或刪除這則範例。
`,
    outlinePrompt: `---
type: collection
category: ${prompts}/寫作大綱
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
`,
    meetingFile: "會議紀錄.md",
    outlineFile: "寫作大綱.md",
    templateProject: `---
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
`,
    templateFile: "通用專案.md",
  };
}

/** Template packs whose folders, files and labels follow `locale`. */
export function templatePacks(locale: VaultLocale = activeVaultLayout().locale): TemplatePack[] {
  const layout = vaultLayoutFor(locale);
  const copy = contentCopy(layout);
  const labels = PACK_COPY[locale];
  const entries = Object.fromEntries(AI_ENTRY_FILES.map((name) => [name, ENTRY]));
  return [
    {
      id: "projects",
      ...labels.projects,
      files: {
        [`${layout.inboxDir}/${layout.inboxFile}`]: copy.inbox,
        [`${layout.projectsDir}/README.md`]: copy.projectsReadme,
      },
    },
    {
      id: "knowledge",
      ...labels.knowledge,
      files: {
        [`${layout.knowledgeDir}/README.md`]: copy.knowledgeReadme,
      },
    },
    {
      id: "prompts",
      ...labels.prompts,
      defaultSelected: false,
      files: {
        [`${layout.knowledgeDir}/${layout.promptsCategory}/README.md`]: copy.promptsReadme,
        [`${layout.knowledgeDir}/${layout.promptsCategory}/${copy.meetingFile}`]: copy.meetingPrompt,
        [`${layout.knowledgeDir}/${layout.promptsCategory}/${copy.outlineFile}`]: copy.outlinePrompt,
      },
    },
    {
      id: "ai",
      ...labels.ai,
      defaultSelected: false,
      files: {
        ".ai/INSTRUCTIONS.md": instructions(layout),
        ".ai/INDEX.md": indexScaffold(layout),
        ...entries,
      },
    },
    {
      id: "templates",
      ...labels.templates,
      defaultSelected: false,
      files: {
        [`${layout.templatesDir}/${copy.templateFile}`]: copy.templateProject,
      },
    },
  ];
}

/** Traditional Chinese packs; see templatePacks for other layouts. */
export const TEMPLATE_PACKS: ReadonlyArray<TemplatePack> = templatePacks("zh-TW");

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
  /** Folder layout to write. Defaults to the open vault's layout. */
  locale?: VaultLocale;
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
  layout: VaultLayout,
  today: string,
  createId: () => string,
): Record<string, string> {
  const projectId = createId();
  const collectionId = createId();
  const inbox = `${layout.inboxDir}/${layout.inboxFile}`;
  if (layout.locale === "en") {
    return {
      [`${layout.projectsDir}/Getting Started.md`]: `---
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
# Getting Started

A sample project to practice the board, the calendar and task notes. Rename or delete it.
`,
      [`${layout.knowledgeDir}/References.md`]: `---
type: collection
id: ${collectionId}
category: Reference
importance: 2
---
# References

Reference notes you will look up again go here. This is a made-up sample; rename or delete it.
`,
      [inbox]: `# Inbox

Unscheduled ideas start here. Drag an idea onto a date in Today or the calendar to schedule it.

- [ ] #task Finish this one [[Getting Started]] ⏳ ${today}

- [ ] #task Schedule it for today or on the calendar [[Getting Started]] ⏳ ${today} ⏰ 09:30 ⏱ 30m

- [ ] #task Write a note under a task [[Getting Started]] ⏳ ${today}

  ## Notes

  - Indent the note under its task
  - Edit or delete it freely
`,
    };
  }
  return {
    [`${layout.projectsDir}/開始使用.md`]: `---
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
    [`${layout.knowledgeDir}/以後要查的資料.md`]: `---
type: collection
id: ${collectionId}
category: 參考
importance: 2
---
# 以後要查的資料

以後會重複查閱的參考資料放這裡。這則是合成示範，可直接改名或刪除。
`,
    [inbox]: `# 待辦

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
  const locale = options.locale ?? activeVaultLayout().locale;
  const packs = Object.fromEntries(templatePacks(locale).map((pack) => [pack.id, pack])) as Record<TemplatePackId, TemplatePack>;
  const out: Record<string, string> = {};
  for (const id of ids) {
    const pack = packs[id];
    if (!pack) continue;
    for (const [path, content] of Object.entries(pack.files)) {
      out[path] = ensureEntityId(content, createId);
    }
  }
  if (options.samples) {
    if (!options.today) throw new Error("SCAFFOLD_TODAY_REQUIRED");
    for (const [path, content] of Object.entries(
      scaffoldSampleFiles(vaultLayoutFor(locale), options.today, createId),
    )) {
      out[path] = content;
    }
  }
  return out;
}
