// Automated checks. Each returns { pass, detail }, using a fresh worker per run.
import { Run } from "./runner.js";

const TEST_TIMEOUT_MS = 90000;

// Runs a program and records its output, answering input requests with `lines`.
function run(code, { stdin, lines = [], onOutput, onInputRequest, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  let out = "";
  let err = "";
  const queue = [...lines];
  const handle = new Run({
    code,
    stdin,
    onOutput(text, stream) {
      if (stream === 1) out += text;
      else err += text;
      onOutput?.(text, stream, handle);
    },
    onInputRequest() {
      if (onInputRequest) return onInputRequest(handle, () => out);
      if (queue.length) handle.sendLine(queue.shift());
      else handle.sendEof();
    },
    onReady: (ms) => (handle.bootMs = ms),
  });
  const timer = setTimeout(() => handle.kill(), timeoutMs);
  const startedAt = performance.now();
  return handle.finished.then((result) => {
    clearTimeout(timer);
    return { ...result, out, err, handle, bootMs: handle.bootMs, totalMs: performance.now() - startedAt };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (ms) => `${Math.round(ms)} ms`;

// Starts a program that prints "go", interrupts it, and reports how long stopping took.
async function stopTest(code, options = {}) {
  let interruptedAt;
  const result = await run(code, {
    ...options,
    timeoutMs: 15000,
    onOutput(text, stream, handle) {
      if (!interruptedAt && text.includes("go")) {
        interruptedAt = -1;
        setTimeout(() => {
          interruptedAt = performance.now();
          handle.stop();
        }, 300);
      }
    },
  });
  const latency = performance.now() - interruptedAt;
  const stopped = result.kind === "exit" && result.err.includes("KeyboardInterrupt");
  return {
    pass: stopped && latency < 1000,
    detail: stopped ? `stopped in ${round(latency)}` : `${result.kind}: not stopped by interrupt`,
  };
}

// A fatal crash must leave the page able to run another program.
async function recoveryProbe() {
  const after = await run('print("alive")');
  return after.out.includes("alive") ? `next run OK (boot ${round(after.bootMs)})` : "NEXT RUN FAILED";
}

async function crashTest(code) {
  const result = await run(code);
  const heapMb = result.handle.heapMb;
  const recovery = await recoveryProbe();
  const how = result.kind === "exit" ? result.err.trim().split("\n").pop() || result.out.trim() : `${result.kind}: ${result.message ?? ""}`;
  return { pass: recovery.startsWith("next run OK"), detail: `${how.slice(0, 160)}; heap ${heapMb} MB; ${recovery}` };
}

export const TESTS = [
  ["Boot and print", async () => {
    const r = await run('print("Привет")');
    return { pass: r.out === "Привет\n", detail: `boot ${round(r.bootMs)}` };
  }],
  ["Output appears while the program is still busy", async () => {
    let firstAt, secondAt;
    await run('import time\nprint("first")\nt = time.time()\nwhile time.time() - t < 2: pass\nprint("second")', {
      onOutput(text) {
        if (text.includes("first")) firstAt = performance.now();
        if (text.includes("second")) secondAt = performance.now();
      },
    });
    const gap = secondAt - firstAt;
    return { pass: gap > 1500, detail: `gap ${round(gap)} (expected about 2000)` };
  }],
  ["Prompt is visible before input() blocks; Cyrillic round trip", async () => {
    let promptShown = false;
    const r = await run('name = input("Имя: ")\nprint("Привет,", name)', {
      onInputRequest(handle, out) {
        promptShown = out() === "Имя: ";
        handle.sendLine("Мир");
      },
    });
    return { pass: promptShown && r.out === "Имя: Привет, Мир\n", detail: JSON.stringify(r.out) };
  }],
  ["Several input() calls", async () => {
    const r = await run("print(int(input()) + int(input()))", { lines: ["2", "40"] });
    return { pass: r.out === "42\n", detail: JSON.stringify(r.out + r.err) };
  }],
  ["End of input raises EOFError", async () => {
    const r = await run('try:\n    input()\nexcept EOFError:\n    print("eof")');
    return { pass: r.out === "eof\n", detail: JSON.stringify(r.out + r.err) };
  }],
  ["Preloaded stdin, 5 MB", async () => {
    const count = 700000;
    const stdin = new TextEncoder().encode("1234567\n".repeat(count));
    const r = await run("import sys\nprint(sum(int(line) for line in sys.stdin))", { stdin });
    return { pass: r.out.trim() === String(1234567 * count), detail: `${(stdin.length || 5600000) / 1e6} MB, total ${round(r.totalMs - r.bootMs)} after boot` };
  }],
  ["Preloaded stdin running out raises EOFError", async () => {
    const stdin = new TextEncoder().encode("only\n");
    const r = await run('print(input())\ntry:\n    input()\nexcept EOFError:\n    print("eof")', { stdin });
    return { pass: r.out === "only\neof\n", detail: JSON.stringify(r.out + r.err) };
  }],
  ["Traceback shows only student code", async () => {
    const r = await run("def f():\n    return 1 / 0\nf()");
    const clean = r.err.includes('File "main.py", line 2') && !r.err.includes("exec") && !r.err.includes("pyodide") && !r.err.includes("_run");
    return { pass: clean && r.status === 1, detail: r.err.trim().replaceAll("\n", " | ").slice(0, 200) };
  }],
  ["sys.exit status", async () => {
    const r = await run("import sys\nsys.exit(3)");
    return { pass: r.status === 3 && r.err === "", detail: `status ${r.status}` };
  }],
  ["Files written by the program can be read back", async () => {
    const r = await run('open("out.txt", "w").write("данные")');
    return { pass: r.files?.["out.txt"] === "данные", detail: JSON.stringify(r.files) };
  }],
  ["numpy loads from this site", async () => {
    const r = await run("import numpy as np\nprint(np.arange(5).sum())");
    return { pass: r.out === "10\n", detail: `boot with numpy ${round(r.bootMs)}${r.err ? "; " + r.err.slice(-120) : ""}` };
  }],
  ["time.sleep waits the right time", async () => {
    const r = await run("import time\nfrom time import sleep\nt = time.time()\nsleep(1)\nprint(round(time.time() - t, 1))");
    return { pass: r.out === "1.0\n", detail: JSON.stringify(r.out + r.err) };
  }],
  ["Stop: busy loop", () => stopTest('print("go")\nwhile True: pass')],
  ["Stop: during input()", () => stopTest('print("go")\ninput()', { onInputRequest() {} })],
  ["Stop: during time.sleep(60)", () => stopTest('import time\nprint("go")\ntime.sleep(60)')],
  ["Stop: during a print flood", () => stopTest('print("go")\nwhile True: print("x" * 100)')],
  ["Hard kill, then a new run", async () => {
    const victim = await run('print("go")\nwhile True: pass', {
      onOutput: (text, stream, handle) => text.includes("go") && setTimeout(() => handle.kill(), 200),
    });
    const recovery = await recoveryProbe();
    return { pass: victim.kind === "killed" && recovery.startsWith("next run OK"), detail: recovery };
  }],
  ["Output flood keeps the page responsive", async () => {
    let last = performance.now();
    let worstGap = 0;
    const ticker = setInterval(() => {
      worstGap = Math.max(worstGap, performance.now() - last);
      last = performance.now();
    }, 20);
    let bytes = 0;
    const r = await run("for i in range(200000): print(i)", { onOutput: (text) => (bytes += text.length) });
    clearInterval(ticker);
    await sleep(0);
    return { pass: r.kind === "exit" && bytes === 1288890, detail: `${bytes} chars in ${round(r.totalMs - r.bootMs)}, worst page stall ${round(worstGap)}` };
  }],
  ["Infinite recursion", () => crashTest("def f(n):\n    return f(n + 1)\nf(0)")],
  ["Infinite recursion with a raised limit", () => crashTest("import sys\nsys.setrecursionlimit(10**8)\ndef f(n):\n    return f(n + 1)\nf(0)")],
  ["Deep structure crash (repr of nested list)", () => crashTest("a = []\nfor _ in range(10**6):\n    a = [a]\nprint(len(repr(a)))")],
  ["Memory exhaustion", () => crashTest("a = []\nwhile True:\n    a.append(bytearray(10**7))\n    a[-1][::4096] = b'x' * len(a[-1][::4096])")],
];
