// Page-side handle for one interpreter in its own worker. Each is used for a single program,
// which gives every run a clean state and lets Stop always succeed by killing the worker.
import {
  CTRL,
  CTRL_LENGTH,
  FRAME_HEADER,
  RING_SIZE,
  STDIN_DATA,
  STDIN_EOF,
  STDIN_SIZE,
  type ProgramRequest,
  type SharedBuffers,
  type WorkerCommand,
  type WorkerEvent,
} from "./layout";

const STOP_RETRY_MS = 250;
const STOP_KILL_MS = 1500;
export const HEAP_LIMIT_MB = matchMedia("(pointer: coarse)").matches ? 512 : 2048;

export type RunResult =
  | { kind: "exit"; status: number; stopped: boolean; errorLine: number | null }
  | { kind: "killed" }
  | { kind: "crash"; message: string };

export interface RunCallbacks {
  onOutput(text: string, stream: number): void;
  onInputRequest(): void;
  onStarted(): void;
}

const encoder = new TextEncoder();

export class Interpreter {
  private shared: SharedBuffers = {
    ctrl: new SharedArrayBuffer(CTRL_LENGTH * 4),
    ring: new SharedArrayBuffer(RING_SIZE),
    stdin: new SharedArrayBuffer(STDIN_SIZE),
    interrupt: new SharedArrayBuffer(1),
  };
  private ctrl = new Int32Array(this.shared.ctrl);
  private ring = new Uint8Array(this.shared.ring);
  private stdinBytes = new Uint8Array(this.shared.stdin);
  private interruptFlag = new Uint8Array(this.shared.interrupt);
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private decoders: Record<number, TextDecoder> = { 1: new TextDecoder(), 2: new TextDecoder() };
  private callbacks: RunCallbacks | null = null;
  private drainTimer = 0;
  private resolveResult!: (result: RunResult) => void;
  private resolveBoot!: (bootMs: number | null) => void;
  private settled = false;
  private pendingLines: string[] = [];
  private inputRequested = false;

  // Resolves when the interpreter is ready, or with null if it died while booting.
  readonly booted = new Promise<number | null>((resolve) => (this.resolveBoot = resolve));
  readonly finished = new Promise<RunResult>((resolve) => (this.resolveResult = resolve));

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerEvent>) => this.onMessage(data);
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.finish({ kind: "crash", message: event.message ?? "worker error" });
    };
    this.post({ type: "boot", shared: this.shared, heapLimitMb: HEAP_LIMIT_MB });
  }

  private post(command: WorkerCommand, transfer: Transferable[] = []) {
    this.worker.postMessage(command, transfer);
  }

  start(program: ProgramRequest, callbacks: RunCallbacks) {
    this.callbacks = callbacks;
    this.drainTimer = window.setInterval(() => this.drain(), 16);
    this.post({ type: "run", ...program }, program.stdin ? [program.stdin.buffer] : []);
  }

  private onMessage(event: WorkerEvent) {
    switch (event.type) {
      case "ready":
        this.resolveBoot(event.bootMs);
        break;
      case "started":
        this.callbacks?.onStarted();
        break;
      case "stdin-request":
        this.inputRequested = true;
        this.drain();
        if (this.pendingLines.length) this.answerWithLine(this.pendingLines.shift()!);
        else this.callbacks?.onInputRequest();
        break;
      case "done":
        this.finish({ kind: "exit", status: event.status, stopped: event.stopped, errorLine: event.errorLine });
        break;
      case "fatal":
        this.finish({ kind: "crash", message: event.message });
        break;
    }
  }

  private drain() {
    let tail = Atomics.load(this.ctrl, CTRL.OUT_TAIL);
    const head = Atomics.load(this.ctrl, CTRL.OUT_HEAD);
    const at = (position: number) => this.ring[position & (RING_SIZE - 1)];
    while (tail !== head) {
      const stream = at(tail);
      let length = 0;
      for (let i = 0; i < 4; i++) length |= at(tail + 1 + i) << (8 * i);
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = at(tail + FRAME_HEADER + i);
      this.callbacks?.onOutput(this.decoders[stream].decode(bytes, { stream: true }), stream);
      tail = (tail + FRAME_HEADER + length) | 0;
    }
    Atomics.store(this.ctrl, CTRL.OUT_TAIL, tail);
    Atomics.notify(this.ctrl, CTRL.OUT_TAIL);
  }

  private finish(result: RunResult) {
    if (this.settled) return;
    this.settled = true;
    this.resolveBoot(null);
    this.drain();
    clearInterval(this.drainTimer);
    this.worker.terminate();
    this.resolveResult(result);
  }

  // Lines typed before the program asks for them wait here, like a terminal's type-ahead.
  sendLine(line: string) {
    if (this.inputRequested) this.answerWithLine(line);
    else this.pendingLines.push(line);
  }

  private answerWithLine(line: string) {
    const bytes = encoder.encode(line + "\n").subarray(0, STDIN_SIZE);
    this.stdinBytes.set(bytes);
    Atomics.store(this.ctrl, CTRL.STDIN_LEN, bytes.length);
    this.answerInput(STDIN_DATA);
  }

  sendEof() {
    if (this.inputRequested) this.answerInput(STDIN_EOF);
  }

  private answerInput(state: number) {
    this.inputRequested = false;
    Atomics.store(this.ctrl, CTRL.STDIN_STATE, state);
    Atomics.notify(this.ctrl, CTRL.STDIN_STATE);
  }

  get heapMb() {
    return Atomics.load(this.ctrl, CTRL.HEAP_MB);
  }

  private interrupt() {
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
    this.finish({ kind: "killed" });
  }
}
