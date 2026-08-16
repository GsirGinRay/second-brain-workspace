import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type MarkdownEditorLocale = "zh-TW" | "en";

export function MarkdownPreview({ value }: { value: string }) {
  return <div className="markdown-preview">
    {value.trim() ? <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >{value}</ReactMarkdown> : <p className="muted">—</p>}
  </div>;
}

export function MarkdownEditor({ value, onChange, locale = "zh-TW", minRows = 10 }: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
  minRows?: number;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const labels = locale === "en"
    ? { title: "Markdown content", write: "Write", preview: "Preview", placeholder: "Write Markdown here…" }
    : { title: "Markdown 內容", write: "編輯", preview: "預覽", placeholder: "在這裡輸入 Markdown…" };
  return <section className="markdown-editor">
    <div className="markdown-editor-header">
      <strong>{labels.title}</strong>
      <div className="segmented-control" role="tablist" aria-label={labels.title}>
        <button type="button" role="tab" aria-selected={mode === "write"} className={mode === "write" ? "active" : ""} onClick={() => setMode("write")}>{labels.write}</button>
        <button type="button" role="tab" aria-selected={mode === "preview"} className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>{labels.preview}</button>
      </div>
    </div>
    {mode === "write"
      ? <textarea className="markdown-textarea" rows={minRows} value={value} maxLength={2_000_000} placeholder={labels.placeholder} onChange={(event) => onChange(event.target.value)} />
      : <MarkdownPreview value={value} />}
  </section>;
}
