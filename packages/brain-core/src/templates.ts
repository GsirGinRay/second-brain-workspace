/**
 * Template instantiation for the Second Brain.
 *
 * Templates are ordinary Markdown (stored under the scanning-excluded
 * `90-模板/` folder) that may contain `{{variable}}` placeholders. Instantiating
 * replaces those placeholders with caller-provided values. Callers are
 * responsible for turning the resulting text into a task line, project file or
 * collection file via the existing create-change builders in the desktop app.
 */

/** Replace `{{name}}` placeholders. Unknown keys are left as-is so the user
 *  sees any misspelled variable instead of silently dropping it. */
export function instantiateTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}

/** Extract declared placeholders (`{{...}}`) in order, deduplicated. */
export function extractTemplateVariables(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    if (!seen.has(match[1]!)) {
      seen.add(match[1]!);
      out.push(match[1]!);
    }
  }
  return out;
}

/**
 * A reusable entity template stored in the vault. Kept as a plain interface so
 * brain-core does not depend on Zod here; the desktop app validates on read.
 */
export interface BrainTemplate {
  name: string;
  kind: "project" | "task" | "collection";
  /** Short hint surfaced to AI and in the "apply template" picker. */
  hint?: string | null;
  /** Template body (may contain {{variables}}). */
  body: string;
}

/** Build the Markdown document used to store a template in `90-模板/`. */
export function renderTemplateDocument(template: BrainTemplate): string {
  const hint = template.hint?.trim() ? template.hint.trim() : "";
  return [
    "---",
    "type: template",
    `template_kind: ${template.kind}`,
    hint ? `ai_hint: ${hint.replace(/\r?\n/g, " ")}` : "ai_hint:",
    "---",
    `# ${template.name}`,
    "",
    template.body.trim(),
    "",
  ].join("\n");
}
