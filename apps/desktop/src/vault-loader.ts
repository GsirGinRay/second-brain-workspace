import type { BrainCollectionSnapshot, BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import type { NativeAdapter } from "./ipc";
import { createIncrementalVaultScanner, scanStructuredVault, type LocalMarkdownFile } from "./vault";

type NativeVaultReader = Pick<NativeAdapter, "scanVault" | "readMarkdownFiles">;

// Keyed by adapter: the app builds a fresh VaultLoader for each local reload.
const fileContentCache = new WeakMap<object, Map<string, LocalMarkdownFile>>();
const vaultScanners = new WeakMap<object, ReturnType<typeof createIncrementalVaultScanner>>();

/** Reads the Markdown folder and parses it, re-reading only changed files. */
export class VaultLoader {
  constructor(private readonly native: NativeVaultReader) {}

  async loadLocal(): Promise<{ files: LocalMarkdownFile[]; tasks: BrainTaskSnapshot[]; projects: BrainProjectSnapshot[]; collections: BrainCollectionSnapshot[]; bootstrapChanges: ReturnType<typeof scanStructuredVault>["bootstrapChanges"]; warnings: ReturnType<typeof scanStructuredVault>["warnings"] }> {
    const scan = await this.native.scanVault();
    if (scan.length === 0) return { files: [], tasks: [], projects: [], collections: [], bootstrapChanges: [], warnings: [] };
    const files = await this.readChangedFiles(scan);
    const structured = this.parse(files);
    return { files, tasks: structured.snapshot.tasks, projects: structured.snapshot.projects, collections: structured.snapshot.collections, bootstrapChanges: structured.bootstrapChanges, warnings: structured.warnings };
  }

  /**
   * A save loads the vault twice, and most files are unchanged each time.
   * The cached file objects let the scanner re-parse only the changed ones.
   * Callers get a copy, so nothing they change can leak into the next load.
   */
  private parse(files: LocalMarkdownFile[]): ReturnType<typeof scanStructuredVault> {
    let scan = vaultScanners.get(this.native);
    if (!scan) {
      scan = createIncrementalVaultScanner();
      vaultScanners.set(this.native, scan);
    }
    return structuredClone(scan(files));
  }

  /**
   * Every save re-scans the vault, and sending every file's bytes over IPC
   * again dominated large vaults. A file whose scanned hash matches the last
   * read is reused; equal SHA-256 means equal bytes, so this cannot go stale.
   */
  private async readChangedFiles(scan: readonly { relativePath: string; sha256: string }[]): Promise<LocalMarkdownFile[]> {
    let cache = fileContentCache.get(this.native);
    if (!cache) {
      cache = new Map();
      fileContentCache.set(this.native, cache);
    }
    // Windows scans report "a\b.md" while reads return "a/b.md"; key both the same way.
    const key = (relativePath: string) => relativePath.replace(/\\/g, "/");
    const stale = scan.filter((file) => cache!.get(key(file.relativePath))?.sha256 !== file.sha256);
    const fresh = stale.length ? await this.native.readMarkdownFiles(stale.map((file) => file.relativePath)) : [];
    for (const file of fresh) cache.set(key(file.relativePath), file);
    const present = new Set(scan.map((file) => key(file.relativePath)));
    for (const relativePath of [...cache.keys()]) if (!present.has(relativePath)) cache.delete(relativePath);
    return scan.flatMap((file) => cache!.get(key(file.relativePath)) ?? []);
  }
}
