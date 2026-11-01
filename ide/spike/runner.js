// Page-side handle for one program run in a fresh worker.
import { CTRL, RING_SIZE, STDIN_SIZE, STDIN_DATA, STDIN_EOF, FRAME_HEADER } from "./layout.js";

const encoder = new TextEncoder();
const STOP_RETRY_MS = 250;
const STOP_KILL_MS = 1500;
export const HEAP_LIMIT_MB = matchMedia("(pointer: coarse)").matches ? 512 : 2048;

export class Run {
  // Callbacks: onOutput(text, stream), onInputRequest(), onReady(bootMs).
  constructor({ code, stdin, onOutput, onInputRequest, onReady }) {
    this.onOutput = onOutput ?? (() => {});
    this.onInputRequest = onInputRequest ?? (() => {});
    this.onReady = onReady ?? (() => {});
    this.decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
    this.waitingForInput = false;
    this.settled = false;

    this.shared = {
      ctrl: new SharedArrayBuffer(6 * 4),
      ring: new SharedArrayBuffer(RING_SIZE),
      stdin: new SharedArrayBuffer(STDIN_SIZE),
      interrupt: new SharedArrayBuffer(1),
    };
    this.ctrl = new Int32Array(this.shared.ctrl);
    this.ring = new Uint8Array(this.shared.ring);
    this.stdinBytes = new Uint8Array(this.shared.stdin);
    this.interruptFlag = new Uint8Array(this.shared.interrupt);

    this.finished = new Promise((resolve) => (this.resolve = resolve));
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => this.#onMessage(data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.#finish({ kind: "crash", message: event.message ?? "worker error" });
    };
    this.drainTimer = setInterval(() => this.#drain(), 16);
    Run.latest = this;
    const transfer = stdin ? [stdin.buffer] : [];
    this.worker.postMessage({ code, stdin, shared: this.shared, heapLimitMb: HEAP_LIMIT_MB }, transfer);
  }

  #onMessage(data) {
    if (data.type === "ready") this.onReady(data.bootMs);
    if (data.type === "stdin-request") {
      this.waitingForInput = true;
      this.#drain();
      this.onInputRequest();
    }
    if (data.type === "done") this.#finish({ kind: "exit", status: data.status, files: data.files });
    if (data.type === "fatal") this.#finish({ kind: "fatal", message: data.message });
  }

  #drain() {
    let tail = Atomics.load(this.ctrl, CTRL.OUT_TAIL);
    const head = Atomics.load(this.ctrl, CTRL.OUT_HEAD);
    const at = (position) => this.ring[position & (RING_SIZE - 1)];
    while (tail !== head) {
      const stream = at(tail);
      let length = 0;
      for (let i = 0; i < 4; i++) length |= at(tail + 1 + i) << (8 * i);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = at(tail + FRAME_HEADER + i);
      this.onOutput(this.decoders[stream].decode(bytes, { stream: true }), stream);
      tail = (tail + FRAME_HEADER + length) | 0;
    }
    Atomics.store(this.ctrl, CTRL.OUT_TAIL, tail);
    Atomics.notify(this.ctrl, CTRL.OUT_TAIL);
  }

  #finish(result) {
    if (this.settled) return;
    this.settled = true;
    this.#drain();
    clearInterval(this.drainTimer);
    this.worker.terminate();
    this.resolve(result);
  }

  sendLine(line) {
    const bytes = encoder.encode(line + "\n").subarray(0, STDIN_SIZE);
    this.stdinBytes.set(bytes);
    Atomics.store(this.ctrl, CTRL.STDIN_LEN, bytes.length);
    this.#answerInput(STDIN_DATA);
  }

  sendEof() {
    this.#answerInput(STDIN_EOF);
  }

  #answerInput(state) {
    this.waitingForInput = false;
    Atomics.store(this.ctrl, CTRL.STDIN_STATE, state);
    Atomics.notify(this.ctrl, CTRL.STDIN_STATE);
  }

  get heapMb() {
    return Atomics.load(this.ctrl, CTRL.HEAP_MB);
  }

  interrupt() {
    Atomics.store(this.interruptFlag, 0, 2);
  }

  // Pyodide occasionally consumes an interrupt without raising it, so retry before killing.
  stop() {
    this.interrupt();
    const retry = setTimeout(() => this.interrupt(), STOP_RETRY_MS);
    const kill = setTimeout(() => this.kill(), STOP_KILL_MS);
    this.finished.then(() => {
      clearTimeout(retry);
      clearTimeout(kill);
    });
  }

  kill() {
    this.#finish({ kind: "killed" });
  }
}
