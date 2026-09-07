import { createContext, useContext, type DragEvent as ReactDragEvent } from "react";
import {
  ATTACHMENT_MAX_FILE_BYTES,
  canAddAttachments,
  renderAttachmentMarkdown,
  sanitizeAttachmentFileName,
} from "@second-brain/brain-core";
import type { NativeAdapter, VaultAttachmentContents, VaultAttachmentInfo } from "./ipc";

export interface VaultAttachmentApi {
  importFiles(folder: string, files: File[]): Promise<VaultAttachmentInfo[]>;
  readImage(relativePath: string): Promise<VaultAttachmentContents>;
  openFile(relativePath: string): Promise<void>;
}

const AttachmentContext = createContext<VaultAttachmentApi | null>(null);

export const AttachmentProvider = AttachmentContext.Provider;

export function useVaultAttachments(): VaultAttachmentApi | null {
  return useContext(AttachmentContext);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function decodeAttachmentBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createAttachmentApi(native: NativeAdapter): VaultAttachmentApi | null {
  if (!native.importVaultAttachment || !native.readVaultAttachment || !native.openVaultAttachment) {
    return null;
  }
  const importVaultAttachment = native.importVaultAttachment;
  const readVaultAttachment = native.readVaultAttachment;
  const openVaultAttachment = native.openVaultAttachment;
  return {
    async importFiles(folder, files) {
      const imported: VaultAttachmentInfo[] = [];
      for (const file of files) {
        if (file.size <= 0 || file.size > ATTACHMENT_MAX_FILE_BYTES) {
          throw new Error("ATTACHMENT_TOO_LARGE");
        }
        if (!sanitizeAttachmentFileName(file.name)) {
          throw new Error("ATTACHMENT_TYPE");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        imported.push(await importVaultAttachment({
          folder,
          fileName: file.name,
          bytesBase64: encodeBase64(bytes),
        }));
      }
      return imported;
    },
    readImage: (relativePath) => readVaultAttachment(relativePath),
    openFile: (relativePath) => openVaultAttachment(relativePath),
  };
}

export function attachmentErrorMessage(locale: "zh-TW" | "en", code: string): string {
  const zh = locale === "zh-TW";
  if (code === "ATTACHMENT_TOO_LARGE") return zh ? "檔案太大。" : "That file is too large.";
  if (code === "ATTACHMENT_TASK_LIMIT") {
    return zh
      ? "任務只能掛一個檔；多檔請掛到專案或知識。"
      : "A task can hold one file. Attach more files to the project or a knowledge note.";
  }
  return zh ? "不支援這個檔案類型。" : "That file type is not allowed.";
}

export async function snippetsFromFiles(
  api: VaultAttachmentApi,
  folder: string,
  files: File[],
  markdown: string,
  locale: "zh-TW" | "en",
  maxAttachments?: number,
): Promise<string[]> {
  if (files.length === 0) return [];
  if (!canAddAttachments(markdown, files.length, maxAttachments)) {
    window.alert(attachmentErrorMessage(locale, "ATTACHMENT_TASK_LIMIT"));
    return [];
  }
  try {
    const imported = await api.importFiles(folder, files);
    return imported.map((item) => renderAttachmentMarkdown(item.relativePath));
  } catch (cause) {
    const code = cause instanceof Error && cause.message.startsWith("ATTACHMENT_")
      ? cause.message
      : "ATTACHMENT_TYPE";
    window.alert(attachmentErrorMessage(locale, code));
    return [];
  }
}

export function dropHasFiles(event: ReactDragEvent): boolean {
  return [...event.dataTransfer.types].includes("Files");
}

export function filesFromDrop(event: ReactDragEvent): File[] {
  if (!dropHasFiles(event)) return [];
  return [...event.dataTransfer.files];
}
