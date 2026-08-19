import React, { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bold,
  Check,
  Code,
  Copy,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  Minus,
  Pencil,
  Quote,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownEditorLocale = "zh-TW" | "en";

/** 從渲染後的 code 節點遞迴取出純文字，供複製按鈕使用。 */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children;
    return children === undefined ? "" : nodeText(children);
  }
  return "";
}

function CodeBlock({ children, locale }: { children: ReactNode; locale: MarkdownEditorLocale }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => nodeText(children).replace(/\n$/, ""), [children]);
  const labels = locale === "en"
    ? { copy: "Copy", copied: "Copied" }
    : { copy: "複製", copied: "已複製" };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <figure className="code-block">
      <button
        type="button"
        className={`code-copy${copied ? " copied" : ""}`}
        aria-label={labels.copy}
        title={labels.copy}
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? labels.copied : labels.copy}
      </button>
      <pre>{children}</pre>
    </figure>
  );
}

export function MarkdownPreview({ value, locale = "zh-TW" }: { value: string; locale?: MarkdownEditorLocale }) {
  return <div className="markdown-preview">
    {value.trim() ? <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        pre: ({ children }) => <CodeBlock locale={locale}>{children}</CodeBlock>,
      }}
    >{value}</ReactMarkdown> : <p className="muted">—</p>}
  </div>;
}

export function MarkdownEditor({ value, onChange, locale = "zh-TW", minRows = 10, mode, onModeChange, iconToggle = false }: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
  minRows?: number;
  mode?: "write" | "preview";
  onModeChange?: (mode: "write" | "preview") => void;
  iconToggle?: boolean;
}) {
  const [internalMode, setInternalMode] = useState<"write" | "preview">("write");
  const currentMode = mode ?? internalMode;
  const setMode = onModeChange ?? setInternalMode;
  const labels = locale === "en"
    ? {
        title: "Markdown content", write: "Write", preview: "Preview", placeholder: "Write Markdown here…",
        code: "Code block", bold: "Bold", italic: "Italic", heading: "Heading", quote: "Quote",
        list: "Bullet list", task: "Task item", link: "Link", rule: "Divider",
        boldText: "bold text", italicText: "italic text", linkText: "text",
      }
    : {
        title: "Markdown 內容", write: "編輯", preview: "預覽", placeholder: "在這裡輸入 Markdown…",
        code: "程式碼區塊", bold: "粗體", italic: "斜體", heading: "標題", quote: "引用",
        list: "項目清單", task: "待辦項目", link: "連結", rule: "分隔線",
        boldText: "粗體文字", italicText: "斜體文字", linkText: "文字",
      };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 在選取範圍前後包上語法；無選取時插入佔位文字並選取它。 */
  const applyWrap = (prefix: string, suffix: string, placeholderText: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    const insertion = selected ? `${prefix}${selected}${suffix}` : `${prefix}${placeholderText}${suffix}`;
    onChange(value.slice(0, start) + insertion + value.slice(end));
    const anchor = start + prefix.length;
    requestAnimationFrame(() => {
      textarea.focus();
      const length = selected ? selected.length : placeholderText.length;
      textarea.setSelectionRange(anchor, anchor + length);
    });
  };
  /** 在目前整行的開頭加上前綴（標題、引用、清單等）。 */
  const applyLinePrefix = (prefix: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    onChange(value.slice(0, lineStart) + prefix + value.slice(lineStart, lineEnd) + value.slice(lineEnd));
    const newStart = lineStart + prefix.length + (start - lineStart);
    const newEnd = lineStart + prefix.length + (end - lineStart);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(newStart, newEnd);
    });
  };
  const insertDivider = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const insertion = `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}---\n`;
    onChange(before + insertion + after);
    const anchor = start + insertion.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(anchor, anchor);
    });
  };
  const tools = [
    { label: labels.code, icon: Code, run: () => applyWrap("```\n", "\n```", "") },
    { label: labels.bold, icon: Bold, run: () => applyWrap("**", "**", labels.boldText) },
    { label: labels.italic, icon: Italic, run: () => applyWrap("*", "*", labels.italicText) },
    { label: labels.heading, icon: Heading2, run: () => applyLinePrefix("## ") },
    { label: labels.quote, icon: Quote, run: () => applyLinePrefix("> ") },
    { label: labels.list, icon: List, run: () => applyLinePrefix("- ") },
    { label: labels.task, icon: ListChecks, run: () => applyLinePrefix("- [ ] ") },
    { label: labels.link, icon: Link2, run: () => applyWrap("[", "](https://)", labels.linkText) },
  ];
  return <section className="markdown-editor">
    <div className="markdown-editor-header">
      <strong>{labels.title}</strong>
      {iconToggle ? (
        <button
          type="button"
          className="icon-button editor-toggle-icon"
          aria-label={currentMode === "write" ? labels.preview : labels.write}
          title={currentMode === "write" ? labels.preview : labels.write}
          onClick={() => setMode(currentMode === "write" ? "preview" : "write")}
        >
          {currentMode === "write" ? <Eye aria-hidden="true" /> : <Pencil aria-hidden="true" />}
        </button>
      ) : (
        <div className="segmented-control" role="tablist" aria-label={labels.title}>
          <button type="button" role="tab" aria-selected={currentMode === "write"} className={currentMode === "write" ? "active" : ""} onClick={() => setMode("write")}>{labels.write}</button>
          <button type="button" role="tab" aria-selected={currentMode === "preview"} className={currentMode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>{labels.preview}</button>
        </div>
      )}
    </div>
    {currentMode === "write" ? <>
      <div className="markdown-toolbar" role="toolbar" aria-label={labels.title}>
        {tools.map((tool) => (
          <button key={tool.label} type="button" className="markdown-tool" aria-label={tool.label} title={tool.label} onClick={tool.run}>
            <tool.icon aria-hidden="true" />
          </button>
        ))}
        <button type="button" className="markdown-tool" aria-label={labels.rule} title={labels.rule} onClick={insertDivider}>
          <Minus aria-hidden="true" />
        </button>
      </div>
      <textarea ref={textareaRef} className="markdown-textarea" rows={minRows} value={value} maxLength={2_000_000} placeholder={labels.placeholder} onChange={(event) => onChange(event.target.value)} />
    </> : <MarkdownPreview value={value} locale={locale} />}
  </section>;
}