// Shared memory layout used by both the page and the worker.
export const CTRL = { STDIN_STATE: 0, STDIN_LEN: 1, OUT_HEAD: 2, OUT_TAIL: 3, SLEEP: 4 };
export const STDIN_EMPTY = 0;
export const STDIN_DATA = 1;
export const STDIN_EOF = 2;
export const RING_SIZE = 1 << 20; // must be a power of two
export const STDIN_SIZE = 1 << 16;
export const FRAME_HEADER = 5; // 1 byte stream id, 4 bytes little-endian length
