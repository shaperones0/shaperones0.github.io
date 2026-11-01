import { expect, test, type Page } from "@playwright/test";

const editor = (page: Page) => page.locator(".cm-content");
const terminal = (page: Page) => page.locator(".terminal");
const runButton = (page: Page) => page.getByRole("button", { name: /Запустить|Run/ });
const stopButton = (page: Page) => page.getByRole("button", { name: /Стоп|Stop/ });
const consoleInput = (page: Page) => page.locator(".terminal-input");

async function open(page: Page, path = "/ide/1/") {
  await page.goto(path);
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
}

async function setCode(page: Page, code: string) {
  const isNarrowOnConsole = await page.getByRole("tab", { name: "Код" }).isVisible();
  if (isNarrowOnConsole) await page.getByRole("tab", { name: "Код" }).click();
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
}

async function runCode(page: Page, code: string) {
  await setCode(page, code);
  await runButton(page).click();
}

async function waitForFinish(page: Page) {
  await expect(runButton(page)).toBeVisible({ timeout: 60_000 });
}

test("runs a program and reports how it ended", async ({ page }) => {
  await open(page);
  await runCode(page, 'print("Привет")\nraise SystemExit(3)');
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("Привет");
  await expect(terminal(page)).toContainText("с кодом 3");
});

test("typed input sits after the prompt, in green italic", async ({ page }) => {
  await open(page);
  await runCode(page, 'name = input("Имя: ")\nprint("Привет,", name)');
  await expect(terminal(page)).toContainText("Имя: ", { timeout: 60_000 });
  await consoleInput(page).fill("Мир");
  await consoleInput(page).press("Enter");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("Имя: Мир\nПривет, Мир");
  const style = await page.locator(".terminal-stdin").evaluate((element) => {
    const { color, fontStyle } = getComputedStyle(element);
    return { color, fontStyle };
  });
  expect(style.fontStyle).toBe("italic");
  const [r, g, b] = style.color.match(/\d+/g)!.map(Number);
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
});

test("lines typed ahead of input() are used in order", async ({ page }) => {
  await open(page);
  await runCode(page, 'import time\ntime.sleep(1)\nprint(int(input()) + int(input()))');
  await consoleInput(page).fill("2");
  await consoleInput(page).press("Enter");
  await consoleInput(page).fill("40");
  await consoleInput(page).press("Enter");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("42");
});

test("Stop ends a program waiting for input, and a busy one", async ({ page }) => {
  await open(page);
  await runCode(page, 'print("go")\ninput()');
  await expect(terminal(page)).toContainText("go", { timeout: 60_000 });
  await stopButton(page).click();
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("остановлена");
  await expect(terminal(page)).not.toContainText("KeyboardInterrupt");

  await runCode(page, 'print("busy")\nwhile True: pass');
  await expect(terminal(page)).toContainText("busy", { timeout: 60_000 });
  await stopButton(page).click();
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("остановлена");
});

test("an error shows a clean traceback and marks the failing line", async ({ page }) => {
  await open(page);
  await runCode(page, "a = 1\nb = 0\nprint(a / b)\nprint('after')");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText('File "main.py", line 3');
  await expect(terminal(page)).toContainText("ZeroDivisionError");
  await expect(terminal(page)).not.toContainText("_run");
  await page.getByRole("tab", { name: "Код" }).click({ timeout: 500 }).catch(() => {});
  await expect(page.locator(".cm-errorLine")).toHaveText("print(a / b)");

  await editor(page).click();
  await page.keyboard.insertText("#");
  await expect(page.locator(".cm-errorLine")).toHaveCount(0);
});

test("a syntax error marks its line too", async ({ page }) => {
  await open(page);
  await runCode(page, "a = 1\nif a\n    print(a)");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("SyntaxError");
  await page.getByRole("tab", { name: "Код" }).click({ timeout: 500 }).catch(() => {});
  await expect(page.locator(".cm-errorLine")).toHaveText("if a");
});

test("memory and stack crashes leave the next run working", async ({ page }) => {
  await open(page);
  await runCode(page, "a = []\nwhile True:\n    a.append(bytearray(10**7))");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("MemoryError");

  await runCode(page, "import sys\nsys.setrecursionlimit(10**8)\ndef f(n):\n    return f(n + 1)\nf(0)");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("перезапустить");

  await runCode(page, 'print("alive")');
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("alive");
});

test("numpy can be imported, and a missing package fails normally", async ({ page }) => {
  await open(page);
  await runCode(page, "import numpy as np\nprint(np.arange(5).sum())");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("10\n");

  await runCode(page, "import requests");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("Error");
  await expect(terminal(page)).toContainText("с кодом 1");
});

test("a second run starts from a warm interpreter with a clean state", async ({ page }) => {
  await open(page, "/ide/1/?debug");
  await runCode(page, "x = 1\nprint(x)");
  await waitForFinish(page);
  await runCode(page, "print('x' in globals())");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("False");
  await page.waitForTimeout(6000);
  await runCode(page, 'print("warm")');
  await waitForFinish(page);
  const wait = await page.locator(".debug-line").textContent();
  expect(Number(/run wait (\d+) ms/.exec(wait!)![1])).toBeLessThan(500);
});

test("code and file name survive a reload", async ({ page }) => {
  await open(page);
  await setCode(page, "print('сохранено')");
  await page.getByRole("button", { name: "main.py" }).click();
  await page.getByRole("textbox", { name: "Переименовать файл" }).fill("задача");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "задача.py" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.reload();
  await expect(editor(page)).toContainText("print('сохранено')", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "задача.py" })).toBeVisible();

  await runCode(page, "1 / 0");
  await waitForFinish(page);
  await expect(terminal(page)).toContainText('File "задача.py", line 1');
});

test("editing follows IDLE's indentation rules, without completion", async ({ page, isMobile }) => {
  test.skip(isMobile, "uses a hardware keyboard");
  await open(page);
  await editor(page).click();
  await page.keyboard.type("def f():\nif True:\nreturn 1\nprint(2)");
  await expect.poll(() => editor(page).innerText()).toBe("def f():\n    if True:\n        return 1\n    print(2)");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("x");
  await expect.poll(() => editor(page).innerText()).toContain("\nx");
  await page.keyboard.press("Home");
  await page.keyboard.press("Tab");
  await expect.poll(() => editor(page).innerText()).toContain("\n    x");

  await page.keyboard.press("Alt+3");
  await expect.poll(() => editor(page).innerText()).toContain("\n##    x");
  await page.keyboard.press("Alt+4");
  await expect.poll(() => editor(page).innerText()).toContain("\n    x");
});

test("find panel opens in Russian", async ({ page, isMobile }) => {
  test.skip(isMobile, "uses a hardware keyboard");
  await open(page);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+F");
  await expect(page.getByRole("textbox", { name: "Найти" })).toBeVisible();
});

test("Ctrl+S confirms a browser save, without downloading", async ({ page, isMobile }) => {
  test.skip(isMobile, "uses a hardware keyboard");
  await open(page);
  await setCode(page, "print(1)");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.locator(".toast")).toHaveText("Сохранено в браузере");
});

async function pressFileAction(page: Page, name: string) {
  const more = page.getByRole("button", { name: "Ещё" });
  if (await more.isVisible()) await more.click();
  await page.getByRole("button", { name }).click();
}

test("saves to disk under the file's name, and opens a file with undo", async ({ page, isMobile }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (Window.prototype as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await open(page);
  await setCode(page, "print('на диск')");
  const downloading = page.waitForEvent("download");
  await pressFileAction(page, "Сохранить на диск");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("main.py");

  const choosing = page.waitForEvent("filechooser");
  await pressFileAction(page, "Открыть файл");
  const chooser = await choosing;
  await chooser.setFiles({ name: "старый.py", mimeType: "text/plain", buffer: Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]) });
  await expect(editor(page)).toContainText("привет");
  await expect(page.getByRole("button", { name: "старый.py" })).toBeVisible();

  test.skip(isMobile, "undo uses a hardware keyboard");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(editor(page)).toContainText("на диск");
});

const LIGHT = "rgb(246, 247, 248)";
const DARK = "rgb(21, 24, 27)";

test.describe("with a dark system theme", () => {
  test.use({ colorScheme: "dark" });

  test("theme and language default sensibly, switch, and persist", async ({ page }) => {
    await open(page);
    const background = () => page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    // Under Playwright, Firefox loses the emulated scheme when isolation swaps its process.
    const systemIsDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    expect(await background()).toBe(systemIsDark ? DARK : LIGHT);

    await pressFileAction(page, "Тема: системная");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await background()).toBe(LIGHT);

    await pressFileAction(page, "Тема: светлая");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await background()).toBe(DARK);

    await pressFileAction(page, "Language: English");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(runButton(page)).toHaveText(/Run/);

    await page.reload();
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(await background()).toBe(DARK);
  });
});

test("the console pane hides until the first run, and can be reopened", async ({ page, isMobile }) => {
  test.skip(isMobile, "wide layout");
  await open(page);
  await expect(terminal(page)).toBeHidden();
  await runCode(page, 'print("x")');
  await waitForFinish(page);
  await expect(terminal(page)).toBeVisible();
  await page.getByRole("button", { name: "Скрыть консоль" }).click();
  await expect(terminal(page)).toBeHidden();
  await page.getByRole("button", { name: "Консоль" }).click();
  await expect(terminal(page)).toBeVisible();
});

test("narrow screens use tabs, and Run moves to the console", async ({ page, isMobile }) => {
  test.skip(!isMobile, "narrow layout");
  await open(page);
  await expect(page.getByRole("tab", { name: "Консоль" })).toBeVisible();
  await expect(terminal(page)).toBeHidden();
  await runCode(page, 'print("x")');
  await expect(page.getByRole("tab", { name: "Консоль" })).toHaveAttribute("aria-selected", "true");
  await expect(terminal(page)).toBeVisible();
  await expect(editor(page)).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the key bar types into the editor and keeps its focus", async ({ page, isMobile }) => {
  test.skip(!isMobile, "touch only");
  await open(page);
  await expect(page.locator(".key-bar")).toBeHidden();
  await editor(page).click();
  await page.keyboard.insertText("x");
  await page.locator(".key-bar").getByRole("button", { name: "=", exact: true }).click();
  await page.locator(".key-bar").getByRole("button", { name: "Tab", exact: true }).click();
  await expect(editor(page)).toContainText("x=");
  await expect(page.locator(".key-bar")).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.className)).toContain("cm-content");
});

test("the runtime is kept in a permanent cache", async ({ page }) => {
  await open(page);
  await runCode(page, 'print("x")');
  await waitForFinish(page);
  await expect
    .poll(() => page.evaluate(() => caches.match("/ide/pyodide/314.0.7/pyodide.asm.wasm").then(Boolean)))
    .toBe(true);
});

test("the short address keeps query and hash, and the page recovers isolation", async ({ page }) => {
  await page.goto("/ide/?task=a#pkg=abc");
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/ide\/1\/\?task=a#pkg=abc$/);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("tutorial pages stay outside the service worker", async ({ page }) => {
  await open(page);
  await page.goto("/python-install/");
  await expect(page.locator("body")).not.toBeEmpty();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(false);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});

// Holds back the page's own download of the runtime, or fails it, until told otherwise.
function controlRuntimeDownload(page: Page, mode: "delay" | "fail") {
  return page.addInitScript((mode) => {
    const realFetch = window.fetch;
    const state = window as unknown as { releaseDownload(): void };
    const released = new Promise<void>((resolve) => (state.releaseDownload = resolve));
    window.fetch = async (input, init) => {
      if (String(input).includes("/pyodide/")) {
        if (mode === "fail") {
          state.releaseDownload();
          window.fetch = realFetch;
          throw new TypeError("offline");
        }
        await released;
      }
      return realFetch(input, init);
    };
  }, mode);
}

test("the first visit shows download progress, and Run waits for it", async ({ page }) => {
  await controlRuntimeDownload(page, "delay");
  await open(page);
  await expect(page.locator(".toolbar-status")).toHaveText("Загрузка Python: 0%");
  await runCode(page, 'print("after download")');
  await expect(stopButton(page)).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseDownload(): void }).releaseDownload());
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("after download");
});

test("Stop cancels a run that is still waiting for the download", async ({ page }) => {
  await controlRuntimeDownload(page, "delay");
  await open(page);
  await runCode(page, 'print("should not print")');
  await stopButton(page).click();
  await page.evaluate(() => (window as unknown as { releaseDownload(): void }).releaseDownload());
  await waitForFinish(page);
  await expect(terminal(page)).toContainText("остановлена");
  await expect(terminal(page)).not.toContainText("should not print");
});

test("a failed download explains itself, and Run tries again", async ({ page }) => {
  await controlRuntimeDownload(page, "fail");
  await open(page);
  await runCode(page, 'print("recovered")');
  await waitForFinish(page);
  await expect(terminal(page)).toContainText(/recovered|интернет/);
  if ((await terminal(page).textContent())!.includes("интернет")) {
    await runCode(page, 'print("recovered")');
    await waitForFinish(page);
    await expect(terminal(page)).toContainText("recovered");
  }
});

test("the spike test page still runs programs", async ({ page }) => {
  await page.goto("/ide/spike/");
  await expect(page.locator("#status")).toContainText("Cross-origin isolated", { timeout: 30_000 });
  await page.locator("#code").fill('print("spike ok")');
  await page.locator("#run").click();
  await expect(page.locator("#console-output")).toContainText("spike ok", { timeout: 60_000 });
});
