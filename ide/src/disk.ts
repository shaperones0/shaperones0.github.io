// Saving to and opening from the student's own disk.
const MAX_OPEN_BYTES = 2 * 1024 * 1024;

interface SaveFilePicker {
  showSaveFilePicker?(options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle>;
}

export type SaveResult = { name: string; handle: FileSystemFileHandle | null } | null;

// Chromium on desktop can write in place, so repeated saves update one file. Everywhere else
// it's a download. Returns null if the student cancelled.
export async function saveToDisk(name: string, content: string | Blob, handle: FileSystemFileHandle | null): Promise<SaveResult> {
  const picker = (window as SaveFilePicker).showSaveFilePicker;
  if (!picker) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: "text/x-python" }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    return { name, handle: null };
  }
  try {
    const target =
      handle ??
      (await picker.call(window, {
        suggestedName: name,
        types: content instanceof Blob
          ? [{ description: "Zip", accept: { "application/zip": [".zip"] } }]
          : [{ description: "Python", accept: { "text/x-python": [".py"] } }],
      }));
    const writable = await target.createWritable();
    await writable.write(content);
    await writable.close();
    return { name: target.name, handle: target };
  } catch (error) {
    if ((error as Error).name === "AbortError") return null;
    throw error;
  }
}

export interface OpenedFile {
  name: string;
  text: string;
  encoding: "utf-8" | "windows-1251";
}

export class FileTooLargeError extends Error {}

// Older Russian Windows editors save as Windows-1251, so that's the fallback.
export async function readCodeFile(file: File): Promise<OpenedFile> {
  if (file.size > MAX_OPEN_BYTES) throw new FileTooLargeError();
  const bytes = await file.arrayBuffer();
  try {
    return { name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { name: file.name, text: new TextDecoder("windows-1251").decode(bytes), encoding: "windows-1251" };
  }
}
