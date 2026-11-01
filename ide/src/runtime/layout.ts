// Shared memory layout used by both the page and the worker.
export const CTRL = { STDIN_STATE: 0, STDIN_LEN: 1, OUT_HEAD: 2, OUT_TAIL: 3, SLEEP: 4, HEAP_MB: 5 } as const;
export const CTRL_LENGTH = 6;
export const STDIN_EMPTY = 0;
export const STDIN_DATA = 1;
export const STDIN_EOF = 2;
export const RING_SIZE = 1 << 20; // must be a power of two
export const STDIN_SIZE = 1 << 16;
export const FRAME_HEADER = 5; // 1 byte stream id, 4 bytes little-endian length
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;

export const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_PATH = `${import.meta.env.BASE_URL}pyodide/${PYODIDE_VERSION}/`;

export interface SharedBuffers {
  ctrl: SharedArrayBuffer;
  ring: SharedArrayBuffer;
  stdin: SharedArrayBuffer;
  interrupt: SharedArrayBuffer;
}

export interface ProgramRequest {
  entry: string;
  files: Record<string, string>;
  stdin?: Uint8Array<ArrayBuffer>;
}

export type WorkerCommand =
  | { type: "boot"; shared: SharedBuffers; heapLimitMb: number }
  | ({ type: "run" } & ProgramRequest);

export type WorkerEvent =
  | { type: "ready"; bootMs: number }
  | { type: "started" }
  | { type: "stdin-request" }
  | { type: "done"; status: number; stopped: boolean; errorLine: number | null }
  | { type: "fatal"; message: string };
