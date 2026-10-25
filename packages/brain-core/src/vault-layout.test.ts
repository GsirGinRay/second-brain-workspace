import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_ENTRY_FILES,
  EN_VAULT_LAYOUT,
  WRITE_BACK_MARKER,
  ZH_TW_VAULT_LAYOUT,
  attachmentFolderForTask,
  canonicalAttachmentPath,
  canonicalJournalPath,
  canonicalKnowledgeWriteDir,
  detectVaultLocale,
  isContentScanExcludedPath,
  isJournalNotePath,
  managedTemplateDirs,
  vaultAttachmentRelativePath,
  parseAiWorklog,
  recentAiHandoffs,
  renderVaultIndex,
  resolveInboxWritePath,
  scaffoldTemplateFiles,
  setActiveVaultLayout,
  templatePacks,
  type BrainTaskSnapshot,
} from "./index";

function withLayout(layout: typeof EN_VAULT_LAYOUT, run: () => void): void {
  setActiveVaultLayout(layout);
  try {
    run();
  } finally {
    setActiveVaultLayout(ZH_TW_VAULT_LAYOUT);
  }
}

test("an empty vault takes the interface language", () => {
  assert.equal(detectVaultLocale([], "en"), "en");
  assert.equal(detectVaultLocale([], "zh-TW"), "zh-TW");
  assert.equal(detectVaultLocale(["README.md"], "en"), "en");
});

test("existing folders decide the layout, whatever the interface language", () => {
  assert.equal(detectVaultLocale(["收件匣/待辦.md"], "en"), "zh-TW");
  assert.equal(detectVaultLocale(["Inbox/Inbox.md", "Projects/Launch.md"], "zh-TW"), "en");
  assert.equal(detectVaultLocale(["Knowledge\\References.md"], "zh-TW"), "en");
  // Legacy Publisher folders are migrated into the Chinese layout.
  assert.equal(detectVaultLocale(["10-收件匣/待辦收件匣.md"], "en"), "zh-TW");
  assert.equal(detectVaultLocale(["Projects/A.md", "Collections/B.md"], "en"), "zh-TW");
  // A Chinese folder wins over an English one.
  assert.equal(detectVaultLocale(["Inbox/a.md", "專案/b.md"], "en"), "zh-TW");
});

test("an English vault writes into English folders", () => {
  withLayout(EN_VAULT_LAYOUT, () => {
    assert.equal(resolveInboxWritePath([]), "Inbox/Inbox.md");
    assert.equal(resolveInboxWritePath(["inbox/inbox.md"]), "inbox/inbox.md");
    assert.equal(canonicalJournalPath("2026-10-25"), "Journal/2026-10-25.md");
    assert.ok(isJournalNotePath("Journal/2026-10-25.md"));
    assert.equal(canonicalKnowledgeWriteDir("Prompts/Meeting notes"), "Knowledge/Prompts");
    assert.equal(canonicalKnowledgeWriteDir("Reference"), "Knowledge");
    assert.equal(canonicalAttachmentPath("Launch", "a.png"), "Attachments/Launch/a.png");
    assert.equal(attachmentFolderForTask(null), "Inbox");
    assert.ok(isContentScanExcludedPath("Templates/General project.md"));
    assert.ok(isContentScanExcludedPath("Attachments/Launch/a.md"));
    assert.deepEqual(managedTemplateDirs(), ["Templates", "模板", "90-模板"]);
    assert.equal(vaultAttachmentRelativePath("Attachments/Launch/a.png"), "Attachments/Launch/a.png");
  });
});

test("the Chinese layout keeps its folders", () => {
  assert.equal(resolveInboxWritePath([]), "收件匣/待辦.md");
  assert.equal(canonicalJournalPath("2026-10-25"), "日誌/2026-10-25.md");
  assert.equal(canonicalKnowledgeWriteDir("提示詞/會議紀錄"), "知識/提示詞");
  assert.equal(vaultAttachmentRelativePath("附件/專案/a.png"), "附件/專案/a.png");
});

test("English scaffolding names folders and samples in English", () => {
  const files = scaffoldTemplateFiles(["projects", "knowledge", "prompts", "ai", "templates"], {
    locale: "en",
    today: "2026-10-25",
    samples: true,
    createId: () => "id-1",
  });
  const paths = Object.keys(files).sort();
  assert.deepEqual(paths, [
    ".ai/INDEX.md",
    ".ai/INSTRUCTIONS.md",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "Inbox/Inbox.md",
    "Knowledge/Prompts/Meeting notes.md",
    "Knowledge/Prompts/README.md",
    "Knowledge/Prompts/Writing outline.md",
    "Knowledge/README.md",
    "Knowledge/References.md",
    "Projects/Getting Started.md",
    "Projects/README.md",
    "QWEN.md",
    "Templates/General project.md",
  ]);
  assert.match(files["Inbox/Inbox.md"]!, /\[\[Getting Started\]\] ⏳ 2026-10-25/);
  assert.doesNotMatch(Object.values(files).join("\n"), /[專案知識收件匣待辦]/u);
  assert.match(files[".ai/INSTRUCTIONS.md"]!, /`Inbox\/Inbox\.md`/);
});

test("the AI handoff pack points every tool at INSTRUCTIONS and asks it to write back", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const files = scaffoldTemplateFiles(["ai"], { locale });
    for (const entry of AI_ENTRY_FILES) assert.match(files[entry]!, /\.ai\/INSTRUCTIONS\.md/);
    const instructions = files[".ai/INSTRUCTIONS.md"]!;
    assert.ok(instructions.includes(WRITE_BACK_MARKER));
    assert.match(instructions, /\.ai\/worklog\/YYYY-MM\.md/);
    assert.match(instructions, locale === "en" ? /### AI work log 2026-10-25 10:42 \(Codex\)/ : /### AI 工作紀錄 2026-10-25 10:42（Codex）/);
  }
  assert.match(scaffoldTemplateFiles(["ai"], { locale: "zh-TW" })[".ai/INSTRUCTIONS.md"]!, /`收件匣\/待辦\.md`/);
});

test("pack labels follow the interface language", () => {
  assert.equal(templatePacks("en").find((pack) => pack.id === "ai")?.label, "AI handoff");
  assert.equal(templatePacks("zh-TW").find((pack) => pack.id === "ai")?.label, "AI 委任架構");
});

test("work logs are read from both languages with their next step", () => {
  const body = [
    "  ## Notes",
    "",
    "  ### AI 工作紀錄 2026-10-24 21:10（Claude Code）",
    "",
    "  - 做了什麼：整理三個追蹤重點",
    "  - 下一步：追 AI 伺服器需求",
    "",
    "  ### AI work log 2026-10-25 09:05 (Codex)",
    "  - Done: compared margins",
    "  - Next: check the next call",
    "",
    "  ### Something else",
    "  - Next: not part of a log",
  ].join("\r\n");
  assert.deepEqual(parseAiWorklog(body), [
    { date: "2026-10-24", time: "21:10", tool: "Claude Code", next: "追 AI 伺服器需求" },
    { date: "2026-10-25", time: "09:05", tool: "Codex", next: "check the next call" },
  ]);
  assert.deepEqual(parseAiWorklog("### AI 工作紀錄 sometime"), []);
  // Some tools write the whole log on the heading line.
  assert.deepEqual(parseAiWorklog("  ### AI 工作紀錄 2026-10-25 23:24（Codex）   - 做了什麼：補上提醒   - 下一步：下次法說會比較"), [
    { date: "2026-10-25", time: "23:24", tool: "Codex", next: "下次法說會比較" },
  ]);
});

function task(overrides: Partial<BrainTaskSnapshot>): BrainTaskSnapshot {
  return {
    id: "t1",
    title: "Task",
    status: "todo",
    priority: "normal",
    rank: "a",
    taskDate: null,
    startTime: null,
    durationMinutes: null,
    projectId: null,
    projectName: null,
    sourcePath: "收件匣/待辦.md",
    ...overrides,
  } as BrainTaskSnapshot;
}

test("the newest handoff per task is listed newest first", () => {
  const tasks = [
    task({ id: "a", title: "舊的", body: "  ### AI 工作紀錄 2026-10-20 10:00（Codex）\n  - 下一步：A" }),
    task({ id: "b", title: "新的", body: "  ### AI 工作紀錄 2026-10-25 08:00（Claude Code）\n  - 下一步：B\n  ### AI 工作紀錄 2026-10-25 11:30（Gemini CLI）\n  - 下一步：C" }),
    task({ id: "c", title: "沒有紀錄", body: "  just notes" }),
  ];
  const handoffs = recentAiHandoffs(tasks);
  assert.deepEqual(handoffs.map((item) => [item.taskTitle, item.tool, item.next]), [
    ["新的", "Gemini CLI", "C"],
    ["舊的", "Codex", "A"],
  ]);
});

test("INDEX lists recent AI handoffs, in English for an English vault", () => {
  const tasks = [task({ title: "Summarize the call", sourcePath: "Inbox/Inbox.md", body: "  ### AI work log 2026-10-25 10:42 (Codex)\n  - Next: compare margins" })];
  withLayout(EN_VAULT_LAYOUT, () => {
    const out = renderVaultIndex({ today: "2026-10-25", generatedAt: "x", tasks, projects: [], collections: [] });
    assert.match(out, /## Recent AI handoffs\n/);
    assert.match(out, /\| 2026-10-25 10:42 \| Codex \| Summarize the call \| compare margins \| Inbox\/Inbox\.md \|/);
    assert.match(out, /Most important today \(P1\): not chosen yet/);
    assert.doesNotMatch(out, /[今日最重要尚無]/u);
  });
  const zh = renderVaultIndex({ today: "2026-10-25", generatedAt: "x", tasks: [], projects: [], collections: [] });
  assert.match(zh, /## Recent AI handoffs 最近 AI 交接\n\n_還沒有 AI 工作紀錄。_/);
});
