import { useEffect, useRef, useState } from "react";

export function committedTitle(draft: string, current: string): string | null {
  const title = draft.trim();
  if (!title || title === current) return null;
  return title;
}

export function InlineTitle({
  value,
  onSave,
  editing,
  onEditingChange,
  prefix = "",
  className = "inline-title-button",
  inputClassName = "inline-title-input",
  ariaLabel,
  hint,
}: {
  value: string;
  onSave: (title: string) => void;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  prefix?: string;
  className?: string;
  inputClassName?: string;
  ariaLabel: string;
  hint: string;
}) {
  const [internalEditing, setInternalEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const isEditing = editing ?? internalEditing;
  const setIsEditing = onEditingChange ?? setInternalEditing;
  const closed = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (isEditing) {
      closed.current = false;
      if (textareaRef.current) {
        const el = textareaRef.current;
        el.style.height = "auto";
        el.style.height = `${Math.max(28, el.scrollHeight)}px`;
        el.focus();
        el.select();
      }
    }
  }, [isEditing]);

  const finish = (next = draft) => {
    if (closed.current) return;
    closed.current = true;
    const title = committedTitle(next, value);
    if (title) onSave(title);
    else setDraft(value);
    setIsEditing(false);
  };

  const cancel = () => {
    if (closed.current) return;
    closed.current = true;
    setDraft(value);
    setIsEditing(false);
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = `${Math.max(28, event.target.scrollHeight)}px`;
  };

  if (isEditing) {
    return (
      <textarea
        ref={textareaRef}
        rows={1}
        className={inputClassName}
        autoFocus
        aria-label={ariaLabel}
        value={draft}
        onChange={handleInput}
        onBlur={() => finish()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            finish();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={hint}
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDraft(value);
        setIsEditing(true);
      }}
    >
      {prefix}
      {value}
    </button>
  );
}
