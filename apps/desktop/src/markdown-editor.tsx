import React, { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
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
  Paperclip,
  Pencil,
  Quote,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ATTACHMENT_ACCEPT,
  attachmentExtension,
  isImageAttachmentPath,
  vaultAttachmentRelativePath,
} from "@second-brain/brain-core";
import {
  decodeAttachmentBytes,
  dropHasFiles,
  filesFromDrop,
  snippetsFromFiles,
  useVaultAttachments,
} from "./attachment-context";

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

export function fencedCodeInsertion(selected: string, placeholder: string): { insertion: string; selectStart: number; selectLength: number } {
  const body = selected.replace(/^\r?\n+|\r?\n+$/g, "") || placeholder;
  const prefix = "```\n";
  const suffix = "\n```";
  return { insertion: prefix + body + suffix, selectStart: prefix.length, selectLength: body.length };
}

function codeClassName(node: ReactNode): string | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = codeClassName(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!React.isValidElement(node)) return undefined;
  const props = node.props as { className?: string; children?: ReactNode };
  if (typeof props.className === "string" && props.className.includes("language-")) return props.className;
  return codeClassName(props.children);
}

function CodeBlock({ children, locale }: { children: ReactNode; locale: MarkdownEditorLocale }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => nodeText(children).replace(/^\n+|\n+$/g, ""), [children]);
  const languageClass = useMemo(() => codeClassName(children), [children]);
  const lang = languageClass ? languageClass.replace("language-", "").trim() : "";
  const langDisplay = lang ? lang.toUpperCase() : (locale === "en" ? "CODE" : "程式碼");
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
      <div className="code-block-header">
        <span className="code-block-lang">{langDisplay}</span>
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
      </div>
      <pre><code className={languageClass}>{text}</code></pre>
    </figure>
  );
}

export function VaultAttachmentView({ href, alt, children, as = "link", width, onResize }: {
  href?: string;
  alt?: string;
  children?: ReactNode;
  as?: "image" | "link";
  width?: number;
  onResize?: (width: number) => void;
}) {
  const api = useVaultAttachments();
  const relative = href ? vaultAttachmentRelativePath(href) : null;
  const isImage = relative ? isImageAttachmentPath(relative) : false;
  const extension = (attachmentExtension(relative ?? "") ?? "").toUpperCase();
  const label = alt || (typeof children === "string" ? children : "") || relative?.split("/").pop() || "";
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!api || !relative || !isImage) return;
    let cancelled = false;
    let created: string | null = null;
    void api.readImage(relative).then((file) => {
      if (cancelled) return;
      const bytes = decodeAttachmentBytes(file.bytesBase64);
      created = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      setBlobUrl(created);
    }).catch(() => {
      if (!cancelled) setBlobUrl(null);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [api, relative, isImage]);
  if (!relative) {
    if (as === "image") return alt ? <span className="markdown-image-pending">{alt}</span> : null;
    return <a href={href} target="_blank" rel="noreferrer">{children ?? alt}</a>;
  }
  const open = (event: { preventDefault(): void; stopPropagation(): void }) => {
    event.preventDefault();
    event.stopPropagation();
    if (api) void api.openFile(relative);
  };
  if (isImage) {
    if (!blobUrl) return <span className="markdown-image-pending">{label || relative}</span>;
    const image = <img src={blobUrl} alt={label} className="vault-attachment-image" draggable={false} />;
    if (!onResize) {
      return width
        ? <div className="vault-image-resize" style={{ width }}>{image}</div>
        : image;
    }
    const startResize = (event: React.PointerEvent<HTMLButtonElement>, edge: "e" | "w") => {
      event.preventDefault();
      event.stopPropagation();
      const frame = frameRef.current;
      const originX = event.clientX;
      const originWidth = frame?.getBoundingClientRect().width ?? width ?? 320;
      const sign = edge === "e" ? 1 : -1;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      let latest = originWidth;
      let frameId = 0;
      const apply = () => {
        frameId = 0;
        if (frame) frame.style.width = `${latest}px`;
      };
      const move = (next: PointerEvent) => {
        latest = Math.min(900, Math.max(120, Math.round(originWidth + sign * (next.clientX - originX))));
        if (!frameId) frameId = requestAnimationFrame(apply);
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        if (frameId) cancelAnimationFrame(frameId);
        onResize(latest);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
    };
    return (
      <div className="vault-image-resize" ref={frameRef} style={width ? { width } : undefined}>
        {image}
        <button type="button" className="vault-image-resize-handle west" aria-label="縮小圖片" onPointerDown={(event) => startResize(event, "w")} />
        <button type="button" className="vault-image-resize-handle east" aria-label="放大圖片" onPointerDown={(event) => startResize(event, "e")} />
      </div>
    );
  }
  return (
    <button type="button" className="vault-file-tile" onClick={open} title={label}>
      <span className={`vault-file-icon${extension === "PDF" ? " is-pdf" : ""}`} aria-hidden="true">{extension || "FILE"}</span>
      <span className="vault-file-name">{label || relative}</span>
    </button>
  );
}

function VaultImage({ src, alt }: { src?: string; alt?: string }) {
  return <VaultAttachmentView href={src} alt={alt} as="image" />;
}

function VaultLink({ href, children }: { href?: string; children: ReactNode }) {
  return <VaultAttachmentView href={href} as="link">{children}</VaultAttachmentView>;
}

export function MarkdownPreview({ value, locale = "zh-TW" }: { value: string; locale?: MarkdownEditorLocale }) {
  return <div className="markdown-preview">
    {value.trim() ? <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={(url) => url}
      components={{
        a: ({ href, children }) => <VaultLink href={href}>{children}</VaultLink>,
        img: ({ src, alt }) => <VaultImage src={src} alt={alt} />,
        pre: ({ children }) => <CodeBlock locale={locale}>{children}</CodeBlock>,
      }}
    >{value}</ReactMarkdown> : <p className="muted">—</p>}
  </div>;
}

export function MarkdownEditor({ value, onChange, locale = "zh-TW", minRows = 10, mode, onModeChange, iconToggle = false, attachmentFolder, maxAttachments }: {
  value: string;
  onChange: (value: string) => void;
  locale?: MarkdownEditorLocale;
  minRows?: number;
  mode?: "write" | "preview";
  onModeChange?: (mode: "write" | "preview") => void;
  iconToggle?: boolean;
  attachmentFolder?: string;
  maxAttachments?: number;
}) {
  const [internalMode, setInternalMode] = useState<"write" | "preview">("write");
  const currentMode = mode ?? internalMode;
  const setMode = onModeChange ?? setInternalMode;
  const labels = locale === "en"
    ? {
        title: "Markdown content", write: "Write", preview: "Preview", placeholder: "Write Markdown here…",
        code: "Code block", bold: "Bold", italic: "Italic", heading: "Heading", quote: "Quote",
        list: "Bullet list", task: "Task item", link: "Link", rule: "Divider", attach: "Add file",
        boldText: "bold text", italicText: "italic text", linkText: "text", codeSample: "code",
      }
    : {
        title: "Markdown 內容", write: "編輯", preview: "預覽", placeholder: "在這裡輸入 Markdown…",
        code: "程式碼區塊", bold: "粗體", italic: "斜體", heading: "標題", quote: "引用",
        list: "項目清單", task: "待辦項目", link: "連結", rule: "分隔線", attach: "加入檔案",
        boldText: "粗體文字", italicText: "斜體文字", linkText: "文字", codeSample: "程式碼",
      };
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useVaultAttachments();
  const canAttach = Boolean(attachments && attachmentFolder);
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
  const insertCodeFence = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const { insertion, selectStart, selectLength } = fencedCodeInsertion(value.slice(start, end), labels.codeSample);
    onChange(value.slice(0, start) + insertion + value.slice(end));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + selectStart, start + selectStart + selectLength);
    });
  };
  const insertSnippets = (snippets: string[]) => {
    if (snippets.length === 0) return;
    const textarea = textareaRef.current;
    const snippet = snippets.join("\n");
    if (!textarea) {
      onChange(value ? `${value.replace(/(\r?\n)*$/, "")}\n\n${snippet}\n` : `${snippet}\n`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const insertion = `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}${snippet}\n`;
    onChange(before + insertion + after);
    const anchor = start + insertion.length;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(anchor, anchor);
    });
  };
  const importFiles = (files: File[]) => {
    if (!attachments || !attachmentFolder) return;
    void snippetsFromFiles(attachments, attachmentFolder, files, value, locale, maxAttachments).then(insertSnippets);
  };
  const onDragOver = (event: ReactDragEvent) => {
    if (!canAttach || !dropHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (event: ReactDragEvent) => {
    const files = filesFromDrop(event);
    if (!canAttach || files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    importFiles(files);
  };
  const tools = [
    { label: labels.code, icon: Code, run: insertCodeFence },
    { label: labels.bold, icon: Bold, run: () => applyWrap("**", "**", labels.boldText) },
    { label: labels.italic, icon: Italic, run: () => applyWrap("*", "*", labels.italicText) },
    { label: labels.heading, icon: Heading2, run: () => applyLinePrefix("## ") },
    { label: labels.quote, icon: Quote, run: () => applyLinePrefix("> ") },
    { label: labels.list, icon: List, run: () => applyLinePrefix("- ") },
    { label: labels.task, icon: ListChecks, run: () => applyLinePrefix("- [ ] ") },
    { label: labels.link, icon: Link2, run: () => applyWrap("[", "](https://)", labels.linkText) },
  ];
  return <section className="markdown-editor" onDragOver={onDragOver} onDrop={onDrop}>
    {canAttach && <input ref={fileInputRef} type="file" hidden accept={ATTACHMENT_ACCEPT} multiple={maxAttachments !== 1} onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; importFiles(files); }} />}
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
        {canAttach && (
          <button type="button" className="markdown-tool" aria-label={labels.attach} title={labels.attach} onClick={() => fileInputRef.current?.click()}>
            <Paperclip aria-hidden="true" />
          </button>
        )}
      </div>
      <textarea ref={textareaRef} className="markdown-textarea" rows={minRows} value={value} maxLength={2_000_000} placeholder={labels.placeholder} onChange={(event) => onChange(event.target.value)} />
    </> : <MarkdownPreview value={value} locale={locale} />}
  </section>;
}