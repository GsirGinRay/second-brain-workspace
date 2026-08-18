// Stub loader for non-JS assets (png) and Tauri API modules when running
// DOM tests outside a Tauri runtime.
export async function load(url, context, nextLoad) {
  if (/\.(png|jpg|jpeg|gif|svg|webp|css)$/i.test(url)) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export default '';",
    };
  }
  if (url.includes("/@tauri-apps/api/event")) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export async function listen() { return () => undefined; }",
    };
  }
  if (url.includes("/@tauri-apps/api/window")) {
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function getCurrentWindow() { return { onCloseRequested: async () => () => undefined, close: async () => undefined }; }",
    };
  }
  if (url.includes("/@tauri-apps/api/core")) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export async function invoke() { throw new Error('TAURI_INVOKE_STUBBED'); }",
    };
  }
  return nextLoad(url, context);
}
