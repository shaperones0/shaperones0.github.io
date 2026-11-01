import { HEAP_LIMIT_MB, Run } from "./runner.js";
import { TESTS } from "./tests.js";

const $ = (id) => document.getElementById(id);
const PROGRESS_KEY = "spike-progress";
const report = { environment: {}, storage: {}, tests: [] };

function renderEnvironment() {
  report.environment = {
    url: location.href,
    userAgent: navigator.userAgent,
    coiStatus: window.coiStatus,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    deviceMemoryGb: navigator.deviceMemory ?? "unknown",
    coarsePointer: matchMedia("(pointer: coarse)").matches,
    viewport: `${innerWidth}x${innerHeight}`,
    spikeVersion: 2,
    heapLimitMb: HEAP_LIMIT_MB,
  };
  renderReport();
}

function renderReport() {
  $("report").textContent = JSON.stringify(report, null, 2);
}

// Storage identity: compare this ID between browsers, and re-check it after 8+ days.
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("spike", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("kv");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function checkStorage() {
  try {
    const db = await openDb();
    const store = (mode) => db.transaction("kv", mode).objectStore("kv");
    const previous = await new Promise((resolve, reject) => {
      const request = store("readonly").get("identity");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    const identity = previous
      ? { ...previous, lastVisit: now, visits: previous.visits + 1 }
      : { id: Math.random().toString(36).slice(2, 8).toUpperCase(), firstVisit: now, lastVisit: now, visits: 1 };
    store("readwrite").put(identity, "identity");
    const persistRequested = (await navigator.storage?.persist?.()) ?? "unsupported";
    const persisted = (await navigator.storage?.persisted?.()) ?? "unsupported";
    const estimate = await navigator.storage?.estimate?.();
    report.storage = {
      ...identity,
      previousVisit: previous?.lastVisit ?? null,
      persistRequested,
      persisted,
      quotaMb: estimate ? Math.round(estimate.quota / 1e6) : "unknown",
    };
    $("storage-id").textContent = identity.id;
    $("storage-note").textContent = `first seen ${identity.firstVisit}, ${identity.visits} visit(s), persisted: ${persisted}`;
  } catch (error) {
    report.storage = { error: String(error) };
    $("storage-note").textContent = String(error);
  }
  renderReport();
}

function saveProgress(running = null) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ tests: report.tests, running, heapMb: running ? Run.latest?.heapMb ?? 0 : 0 }));
  } catch {}
}

function renderResults() {
  const list = $("results");
  list.replaceChildren();
  for (const test of report.tests) {
    const row = list.appendChild(document.createElement("li"));
    row.className = test.pass ? "pass" : "fail";
    row.textContent = `${test.pass ? "PASS" : "FAIL"}  ${test.name} (${test.detail})`;
  }
  const failed = report.tests.filter((test) => !test.pass).length;
  $("summary").textContent = `${report.tests.length - failed} passed, ${failed} failed, ${TESTS.length - report.tests.length} not run`;
  $("continue-tests").hidden = report.tests.length === 0 || report.tests.length >= TESTS.length;
  renderReport();
}

async function runTests({ fresh }) {
  $("run-tests").disabled = $("continue-tests").disabled = true;
  if (fresh) report.tests = [];
  window.spikeDone = false;
  renderResults();

  for (const [name, test] of TESTS.slice(report.tests.length)) {
    const row = $("results").appendChild(document.createElement("li"));
    row.textContent = `… ${name}`;
    // Recorded before and during the test, so a killed tab still says what it was doing.
    saveProgress(name);
    const heartbeat = setInterval(() => saveProgress(name), 250);
    let result;
    try {
      result = await test();
    } catch (error) {
      result = { pass: false, detail: `threw: ${error}` };
    }
    clearInterval(heartbeat);
    report.tests.push({ name, ...result });
    saveProgress();
    renderResults();
  }
  $("run-tests").disabled = $("continue-tests").disabled = false;
  window.spikeReport = report;
  window.spikeDone = true;
}

function restoreProgress() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PROGRESS_KEY)); } catch {}
  if (!saved) return;
  report.tests = saved.tests ?? [];
  if (saved.running) {
    report.tests.push({ name: saved.running, pass: false, detail: `PAGE LOST during this test; last heap reading ${saved.heapMb} MB` });
    saveProgress();
  }
  renderResults();
}

// Manual console, for checking typing and input styling on real devices.
let activeRun = null;

function appendConsole(text, className) {
  const output = $("console-output");
  const span = output.appendChild(document.createElement("span"));
  span.textContent = text;
  if (className) span.className = className;
  while (output.childNodes.length > 2000) output.firstChild.remove();
  output.scrollTop = output.scrollHeight;
}

function setRunning(running, waiting = false) {
  $("run").disabled = running;
  $("stop").disabled = !running;
  $("console-input").disabled = !waiting;
  $("eof").disabled = !waiting;
  if (waiting) $("console-input").focus();
}

async function startProgram() {
  $("console-output").replaceChildren();
  setRunning(true);
  appendConsole("Starting…\n", "meta");
  activeRun = new Run({
    code: $("code").value,
    onOutput: (text, stream) => appendConsole(text, stream === 2 ? "stderr" : ""),
    onInputRequest: () => setRunning(true, true),
    onReady: (ms) => appendConsole(`Ready in ${Math.round(ms)} ms\n`, "meta"),
  });
  const result = await activeRun.finished;
  const summary = result.kind === "exit" ? `exit status ${result.status}` : `${result.kind} ${result.message ?? ""}`;
  appendConsole(`\n[${summary}]\n`, "meta");
  activeRun = null;
  setRunning(false);
}

function stopProgram() {
  if (!activeRun) return;
  activeRun.stop();
}

function submitInput(event) {
  event.preventDefault();
  if (!activeRun?.waitingForInput) return;
  const field = $("console-input");
  appendConsole(field.value + "\n", "stdin");
  activeRun.sendLine(field.value);
  field.value = "";
  setRunning(true);
}

function sendEof() {
  activeRun?.sendEof();
  setRunning(true);
}

async function copyReport() {
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = "Copied";
  } catch {
    const selection = getSelection();
    selection.selectAllChildren($("report"));
    $("copy").textContent = "Selected, copy it manually";
  }
}

function init() {
  $("status").textContent = {
    isolated: window.crossOriginIsolated ? "Cross-origin isolated: everything is available." : "Not isolated.",
    reloading: "Setting up, this page reloads once…",
    failed: "Could not enable isolation. Reload the page normally. In private mode, try a normal window.",
    "no-service-worker": "This browser or mode has no service workers, so interactive input is unavailable.",
  }[window.coiStatus];

  renderEnvironment();
  checkStorage();

  restoreProgress();

  $("run-tests").onclick = () => runTests({ fresh: true });
  $("continue-tests").onclick = () => runTests({ fresh: false });
  $("run").onclick = startProgram;
  $("stop").onclick = stopProgram;
  $("eof").onclick = sendEof;
  $("console-form").onsubmit = submitInput;
  $("copy").onclick = copyReport;

  const ready = window.crossOriginIsolated;
  $("run-tests").disabled = $("continue-tests").disabled = !ready;
  $("run").disabled = !ready;
  window.spikeReady = ready;
}

$("status").textContent = "Setting up, this page reloads once…";
window.coiReady.then(init);
