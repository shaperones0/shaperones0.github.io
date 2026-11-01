import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SOLUTION = "print(int(input()) + int(input()))";
// Four open tests, then one collapsed, two shown on failure and two hidden.
const OPEN_TESTS = 4;
const SUM_TESTS = OPEN_TESTS + 5;
const editor = (page: Page) => page.locator(".cm-content");
const runButton = (page: Page) => page.getByRole("button", { name: /Запустить|Run/ });
const checkButton = (page: Page) => page.getByRole("button", { name: /Проверить|Check/ });
const stopButton = (page: Page) => page.getByRole("button", { name: /Стоп|Stop/ });
const statement = (page: Page) => page.locator(".statement");
const summary = (page: Page) => page.locator(".check-summary");
const fileName = (page: Page) => page.locator(".file-name");

async function openTask(page: Page, id = "sum-task") {
  await page.goto(`/ide/1/?task=${id}`);
  await expect(statement(page)).toBeVisible({ timeout: 30_000 });
}

async function showCode(page: Page) {
  const tab = page.getByRole("tab", { name: "Код" });
  if (await tab.isVisible()) await tab.click();
}

async function setCode(page: Page, code: string) {
  await showCode(page);
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
}

async function checkCode(page: Page, code: string) {
  await setCode(page, code);
  await checkButton(page).click();
  await expect(runButton(page)).toBeVisible({ timeout: 80_000 });
}

function packageLink(id: string) {
  const encoded = readFileSync(`dist/ide/tasks/${id}.pytask`).toString("base64url");
  return `/ide/1/#pkg=${encoded}`;
}

test.describe("opening", () => {
  test("by ID: statement, suggested file name and starter code", async ({ page, isMobile }) => {
    await openTask(page);
    await expect(statement(page)).toContainText("Сумма двух чисел");
    await expect(fileName(page)).toHaveText("summa.py");
    await expect(checkButton(page)).toBeVisible();
    await showCode(page);
    await expect(editor(page)).toContainText("Напишите решение");
    const name = await fileName(page).evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(name).toBe(true);
    if (!isMobile) {
      const statementBox = (await page.locator(".statement-pane").boundingBox())!;
      const editorBox = (await page.locator(".editor-pane").boundingBox())!;
      expect(statementBox.x + statementBox.width).toBeLessThanOrEqual(editorBox.x);
    }
  });

  test("from a link carrying the package; a reload still works", async ({ page }) => {
    await page.route("**/tasks/tiny-task.pytask", (route) => route.fulfill({ status: 404 }));
    await page.goto(packageLink("tiny-task"));
    await expect(statement(page)).toContainText("Выведите число", { timeout: 30_000 });
    await expect(page).toHaveURL(/\?task=tiny-task$/);
    await page.reload();
    await expect(statement(page)).toContainText("Выведите число", { timeout: 30_000 });
  });

  test("by dropping a package file on the page", async ({ page, isMobile }) => {
    test.skip(isMobile, "dragging is a desktop feature");
    await page.goto("/ide/1/");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    const bytes = readFileSync("dist/ide/tasks/sum-task.pytask").toString("base64");
    await page.evaluate((base64) => {
      const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], "sum-task.pytask"));
      const target = document.querySelector(".cm-content")!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }
    }, bytes);
    await expect(statement(page)).toContainText("Сумма двух чисел");
    await expect(page.locator(".drop-overlay")).toHaveCount(0);
  });

  test("through the dialog, by ID or link, rejecting nonsense", async ({ page }) => {
    await page.goto("/ide/1/");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    const openDialog = async () => {
      const more = page.getByRole("button", { name: "Ещё" });
      if (await more.isVisible()) await more.click();
      await page.getByRole("button", { name: "Открыть задачу" }).click();
    };
    await openDialog();
    const field = page.getByLabel("Номер задачи или ссылка на неё");
    await field.fill("не задача!");
    await page.getByRole("button", { name: "Открыть", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await field.fill("sum-task");
    await page.getByRole("button", { name: "Открыть", exact: true }).click();
    await expect(statement(page)).toContainText("Сумма двух чисел");

    await openDialog();
    await field.fill(`https://shaperones0.github.io${packageLink("tiny-task")}`);
    await page.getByRole("button", { name: "Открыть", exact: true }).click();
    await expect(statement(page)).toContainText("Выведите число");
  });

  test("unknown and malformed IDs explain themselves and leave the page working", async ({ page }) => {
    await page.goto("/ide/1/?task=no-such-task");
    await expect(page.locator(".toast")).toContainText("не найдена", { timeout: 30_000 });
    await page.goto("/ide/1/?task=..%2F..%2Fpython-install%2Findex");
    await expect(page.locator(".toast")).toContainText("не найдена", { timeout: 30_000 });
    await expect(editor(page)).toBeVisible();
  });

  test("an update keeps the student's code, and an old link can't downgrade the task", async ({ page }) => {
    const buildVersion = (version: number) => {
      const folder = mkdtempSync(join(tmpdir(), "pytask-"));
      const task = join(folder, "task");
      mkdirSync(task);
      writeFileSync(join(task, "task.toml"), `id = "versioned"\nversion = ${version}\ntitle = "Версия ${version}"\n`);
      writeFileSync(join(task, "statement.ru.md"), `Условие ${version}.\n`);
      execFileSync("python", ["tools/pytask.py", "build", task, "--out", folder], { stdio: "pipe" });
      return `/ide/1/#pkg=${readFileSync(join(folder, "versioned.pytask")).toString("base64url")}`;
    };
    const opened = async (link: string) => {
      await page.goto("about:blank");
      await page.goto(link);
      await expect(statement(page)).toBeVisible({ timeout: 30_000 });
    };

    await opened(buildVersion(1));
    await expect(statement(page)).toContainText("Условие 1");
    await setCode(page, "print('моё')");
    await page.waitForTimeout(500);

    await opened(buildVersion(2));
    await expect(statement(page)).toContainText("Условие 2");
    await showCode(page);
    await expect(editor(page)).toContainText("моё");

    await opened(buildVersion(1));
    await expect(statement(page)).toContainText("Условие 2");
  });

  test("a broken package is refused", async ({ page }) => {
    await page.goto(`/ide/1/#pkg=${Buffer.from("not a zip").toString("base64url")}`);
    await expect(page.locator(".toast")).toContainText("Не удалось прочитать", { timeout: 30_000 });
  });

  test("a task above this level is refused with a reason", async ({ page }) => {
    await page.goto("/ide/1/?task=files-task");
    await expect(page.getByRole("alertdialog")).toContainText("уровень 2", { timeout: 30_000 });
    await page.getByRole("button", { name: "Понятно" }).click();
    await expect(statement(page)).toHaveCount(0);
  });
});

test.describe("statement", () => {
  test("is sanitized, and only packaged images load", async ({ page }) => {
    await openTask(page);
    const image = statement(page).locator("img");
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    await expect(statement(page).locator("script")).toHaveCount(0);
    await expect(statement(page).getByText("плохая ссылка")).not.toHaveAttribute("href", /./);
    await expect(statement(page).getByRole("link", { name: "хорошая ссылка" })).toHaveAttribute("rel", /noopener/);
  });

  test("prose can't be selected, but code can", async ({ page, isMobile }) => {
    await openTask(page);
    const selected = () => page.evaluate(() => getSelection()?.toString() ?? "");
    await statement(page).locator("p").first().click({ clickCount: 3, position: { x: 30, y: 8 } });
    expect(await selected()).not.toContain("Даны");
    await statement(page).locator(".code-block code").first().click({ clickCount: 3, position: { x: 30, y: 28 } });
    expect(await selected()).toContain("a = int(input())");

    test.skip(isMobile, "uses a hardware keyboard");
    await statement(page).locator("h1").click();
    await page.keyboard.press("ControlOrMeta+A");
    expect(await selected()).not.toContain("Даны");
  });

  test("open tests form tables, merging only neighbours", async ({ page }) => {
    await openTask(page);
    const tables = statement(page).locator("> div").first().locator(".tests-table");
    await expect(tables).toHaveCount(3);
    await expect(tables.nth(0).locator("tbody tr")).toHaveCount(1);
    await expect(tables.nth(1).locator("tbody tr")).toHaveCount(2);
    await expect(tables.nth(2).locator("tbody tr")).toHaveCount(1);
    await expect(tables.nth(1).locator("thead th")).toHaveText(["Ввод", "Вывод"]);
    await expect(tables.nth(1).locator("tbody tr").nth(1).locator("td").nth(0)).toContainText("1\n1");
    await expect(tables.nth(1).locator("tbody tr").nth(1).locator("td").nth(1)).toContainText("2");
    await expect(statement(page).getByText("---")).toHaveCount(0);
  });

  test("closed tests show according to their display", async ({ page }) => {
    await openTask(page);
    const collapsed = statement(page).locator("details.test-group");
    await expect(collapsed).toHaveCount(1);
    await expect(collapsed.locator("pre").first()).toBeHidden();
    await collapsed.locator("summary").click();
    await expect(collapsed.locator(".tests-table")).toContainText("30");
    await expect(statement(page)).not.toContainText("100");
    await expect(statement(page)).not.toContainText("42");
  });

  test("math renders, inline and as blocks, leaving other dollars alone", async ({ page }) => {
    await openTask(page);
    const text = statement(page);
    await expect(text.locator("p .katex").first()).toBeVisible();
    await expect(text.locator("p").first().locator(".katex")).toHaveCount(3);
    await expect(text.locator("p").first()).toContainText("каждое на своей строке");
    await expect(text.locator(".katex-display")).toHaveCount(2);
    await expect(text.locator("p .katex-display")).toHaveCount(1);
    await expect(text.locator(".katex-display").first()).toContainText("∑");
    await expect(text).not.toContainText("$a$");
    await expect(text).not.toContainText("$$");
    await expect(text).toContainText("Цена билета $5 или $6");
    expect(await text.locator("p code", { hasText: "$x" }).textContent()).toContain("$x$");
    await expect(text).toContainText("Экранированный знак: $7");
    await expect(text.locator(".katex-error")).toHaveCount(0);
    expect(await text.locator(".katex").first().evaluate((element) => getComputedStyle(element).fontFamily)).toContain("KaTeX");
  });

  test("math in a statement can't run scripts", async ({ page }) => {
    const statementSource = "Текст $\\href{javascript:window.pwned=1}{x}$ и $<img src=x onerror=window.pwned=1>$\n";
    const folder = mkdtempSync(join(tmpdir(), "pytask-"));
    const task = join(folder, "task");
    mkdirSync(task);
    writeFileSync(join(task, "task.toml"), 'id = "math-attack"\nversion = 1\ntitle = "x"\n');
    writeFileSync(join(task, "statement.ru.md"), statementSource);
    execFileSync("python", ["tools/pytask.py", "build", task, "--out", folder], { stdio: "pipe" });
    await page.goto(`/ide/1/#pkg=${readFileSync(join(folder, "math-attack.pytask")).toString("base64url")}`);
    await expect(statement(page)).toBeVisible({ timeout: 30_000 });
    await expect(statement(page).locator(".katex").first()).toBeVisible();
    await expect(statement(page).locator('a[href^="javascript"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  });

  test("python blocks are highlighted, with line numbers on longer ones", async ({ page }) => {
    await openTask(page);
    const blocks = statement(page).locator(".code-block");
    const python = blocks.nth(0);
    await expect(python.locator(".code-numbers")).toHaveText("1\n2\n3\n4");
    const fontSize = (selector: string) => python.locator(selector).evaluate((element) => getComputedStyle(element).fontSize);
    expect(await fontSize(".code-numbers")).toBe(await fontSize("code"));
    const colors = await python.locator("code span").evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
    expect(new Set(colors).size).toBeGreaterThan(1);

    const plain = blocks.nth(1);
    await expect(plain.locator(".code-numbers")).toHaveText("1\n2");
    await expect(plain.locator("code span")).toHaveCount(0);

    await expect(blocks.nth(2).locator(".code-numbers")).toHaveCount(0);
  });

  test("copying code by hand leaves out line numbers, with no stray whitespace", async ({ page, context, browserName, isMobile }) => {
    test.skip(isMobile || browserName === "webkit", "needs a real clipboard and a mouse");
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTask(page);
    const box = (await statement(page).locator(".code-block").first().boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + box.height - 8, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press("Control+C");
    await editor(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+V");
    await expect
      .poll(() => page.locator(".cm-line").allTextContents())
      .toEqual(["# Пример", "a = int(input())", "", 'b = "строка"']);
  });

  test("long code lines scroll inside their block", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 700 });
    const folder = mkdtempSync(join(tmpdir(), "pytask-"));
    const task = join(folder, "task");
    mkdirSync(task);
    writeFileSync(join(task, "task.toml"), 'id = "long-code"\nversion = 1\ntitle = "x"\n');
    writeFileSync(join(task, "statement.ru.md"), `\`\`\`python\nx = "${"a".repeat(300)}"\ny = 1\n\`\`\`\n`);
    execFileSync("python", ["tools/pytask.py", "build", task, "--out", folder], { stdio: "pipe" });
    await page.goto(`/ide/1/#pkg=${readFileSync(join(folder, "long-code.pytask")).toString("base64url")}`);
    const code = statement(page).locator(".code-block code");
    await expect(code).toBeVisible({ timeout: 30_000 });
    expect(await code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await expect(statement(page).locator(".code-block .copy-button")).toHaveCount(1);
  });

  test("copy buttons fade in on hover, and copy just the block's text", async ({ page, isMobile }) => {
    await page.addInitScript(() => {
      const state = window as unknown as { copied?: string };
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            state.copied = text;
          },
        },
      });
    });
    await openTask(page);
    const copied = () => page.evaluate(() => (window as unknown as { copied?: string }).copied);
    const code = statement(page).locator(".code-block").first();
    const button = code.locator(".copy-button");
    await expect(statement(page).locator("p code .copy-button")).toHaveCount(0);

    if (isMobile) {
      await expect(button).toHaveCSS("opacity", "0.7");
    } else {
      await expect(button).toHaveCSS("opacity", "0");
      await code.hover();
      await expect(button).toHaveCSS("opacity", "1");
    }
    await button.click();
    expect(await copied()).toBe('# Пример\na = int(input())\n\nb = "строка"');
    await expect(button).toHaveAttribute("data-copied", "true");

    const cells = statement(page).locator(".tests-table").nth(1).locator("tbody tr").first().locator("td");
    await cells.nth(0).hover();
    await cells.nth(0).locator(".copy-button").click();
    expect(await copied()).toBe("2\n3");
    await cells.nth(1).hover();
    await cells.nth(1).locator(".copy-button").click();
    expect(await copied()).toBe("5");

    const collapsed = statement(page).locator("details.test-group");
    await collapsed.locator("summary").click();
    await collapsed.locator("pre").first().hover();
    await collapsed.locator(".copy-button").first().click();
    expect(await copied()).toBe("10\n20");
  });

  test("follows the interface language", async ({ page }) => {
    await openTask(page);
    const more = page.getByRole("button", { name: "Ещё" });
    if (await more.isVisible()) await more.click();
    await page.getByRole("button", { name: "Language: English" }).click();
    await expect(statement(page)).toContainText("Sum of two numbers");
    await expect(statement(page)).toContainText("its own line");
  });
});

test.describe("checking", () => {
  test("a correct program passes every test", async ({ page }) => {
    await openTask(page);
    await checkCode(page, SOLUTION);
    await expect(summary(page)).toHaveText(`Все тесты пройдены: ${SUM_TESTS}`);
    await expect(page.locator(".result .mark-fail")).toHaveCount(0);
  });

  test("a wrong program fails, revealing only what each group allows", async ({ page }) => {
    await openTask(page);
    await checkCode(page, "print(int(input()) * int(input()))");
    await expect(summary(page)).toHaveText(`Пройдено тестов: 0 из ${SUM_TESTS}`);
    const results = page.locator(".check-results");

    // Open and collapsed groups show everything.
    await expect(results).toContainText("200");
    await expect(page.locator(".result").nth(0)).toContainText("Ожидаемый вывод");

    // on-fail shows only its first failure.
    const firstShown = OPEN_TESTS + 1;
    await expect(page.locator(".result").nth(firstShown)).toContainText(`Закрытый тест ${firstShown + 1}`);
    await expect(page.locator(".result").nth(firstShown).locator("pre")).toHaveCount(3);
    await expect(page.locator(".result").nth(firstShown + 1).locator("details")).toHaveCount(0);
    await expect(results).not.toContainText("100");

    // Hidden shows only the verdict.
    await expect(page.locator(".result").nth(SUM_TESTS - 2)).toHaveText(new RegExp(`Закрытый тест ${SUM_TESTS - 1}: неверный ответ`));
    await expect(page.locator(".result").nth(SUM_TESTS - 2).locator("pre")).toHaveCount(0);
    await expect(results).not.toContainText("41");
    await expect(results).not.toContainText("42");
  });

  test("hashed tests really do compare correctly", async ({ page }) => {
    await openTask(page);
    await checkCode(page, "a = int(input())\nb = int(input())\nprint(a + b if a in (41, -5) else 0)");
    const results = await page.locator(".result").allTextContents();
    expect(results[SUM_TESTS - 2]).toContain("пройден");
    expect(results[SUM_TESTS - 1]).toContain("пройден");
    expect(results[0]).toContain("неверный");
  });

  test("a prompt in input() counts as output", async ({ page }) => {
    await openTask(page);
    await checkCode(page, 'print(int(input("a")) + int(input("b")))');
    await expect(summary(page)).toHaveText(`Пройдено тестов: 0 из ${SUM_TESTS}`);
  });

  test("an error is reported as one, and its traceback stays hidden for closed tests", async ({ page }) => {
    await openTask(page);
    await checkCode(page, 'raise ValueError("сломалось " + input())');
    await expect(page.locator(".result").nth(0)).toContainText("ошибка при выполнении");
    await expect(page.locator(".result").nth(0)).toContainText("ValueError");
    await expect(page.locator(".result").nth(SUM_TESTS - 1)).not.toContainText("ValueError");
  });

  test("tests can't see each other's state", async ({ page }) => {
    await openTask(page);
    await checkCode(
      page,
      [
        "import builtins, os, sys",
        'assert not os.path.exists("leak.txt"), "file leaked"',
        'open("leak.txt", "w").close()',
        'assert not hasattr(builtins, "leak"), "builtin leaked"',
        "builtins.leak = 1",
        'assert "my_module" not in sys.modules, "module leaked"',
        'sys.modules["my_module"] = sys',
        "assert sys.getrecursionlimit() < 100000, 'limit leaked'",
        "sys.setrecursionlimit(100000)",
        "a = int(input())",
        "b = int(sys.stdin.readline())",
        "print(a + b)",
        'sys.stdout = None',
      ].join("\n"),
    );
    await expect(summary(page)).toHaveText(/Все тесты пройдены|Пройдено тестов: \d+ из \d+/);
    const errors = await page.locator(".check-results").textContent();
    expect(errors).not.toContain("leaked");
  });

  test("unread input doesn't reach the next test", async ({ page }) => {
    await openTask(page);
    await checkCode(page, "first = input()\nprint(int(first) + int(input()))\n");
    await expect(summary(page)).toHaveText(`Все тесты пройдены: ${SUM_TESTS}`);
    await checkCode(page, 'import sys\nlines = sys.stdin.readlines()\nprint(sum(int(x) for x in lines))');
    await expect(summary(page)).toHaveText(`Все тесты пройдены: ${SUM_TESTS}`);
  });

  test("an endless loop times out, and the remaining tests still run", async ({ page }) => {
    test.setTimeout(120_000);
    await openTask(page);
    await checkCode(page, "a = int(input())\nb = int(input())\nwhile a == 7: pass\nprint(a + b)");
    await expect(summary(page)).toHaveText(`Пройдено тестов: ${SUM_TESTS - 1} из ${SUM_TESTS}`);
    await expect(page.locator(".result").nth(OPEN_TESTS + 1)).toContainText("слишком долго");
  });

  test("a crash on one test doesn't stop the others", async ({ page }) => {
    await openTask(page);
    await checkCode(page, [
      "import sys",
      "a = int(input())",
      "b = int(input())",
      "if a == 7:",
      "    sys.setrecursionlimit(10**8)",
      "    def f(n):",
      "        return f(n + 1)",
      "    f(0)",
      "print(a + b)",
    ].join("\n"));
    await expect(summary(page)).toHaveText(`Пройдено тестов: ${SUM_TESTS - 1} из ${SUM_TESTS}`);
    // Using up the heap can outlast this task's short time limit, and either verdict is fair.
    await expect(page.locator(".result").nth(OPEN_TESTS + 1)).toContainText(/памят|слишком долго/);
  });

  test("Stop cancels a check", async ({ page }) => {
    await openTask(page);
    await setCode(page, "import time\ntime.sleep(1)\nprint(0)");
    await checkButton(page).click();
    await stopButton(page).click();
    await expect(runButton(page)).toBeVisible({ timeout: 10_000 });
    await expect(checkButton(page)).toBeVisible();
    await setCode(page, 'print("after")');
    await runButton(page).click();
    await expect(page.locator(".terminal")).toContainText("after", { timeout: 60_000 });
  });

  test("Check is absent without tests, and on Scratch", async ({ page }) => {
    await page.goto("/ide/1/");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await expect(runButton(page)).toBeVisible();
    await expect(checkButton(page)).toHaveCount(0);
  });

  test("expected answers never reach the student's worker", async ({ page }) => {
    await openTask(page);
    await setCode(page, [
      "import js, sys",
      "seen = [str(x) for x in [js.self.location.href]]",
      "print(input() and input() and 0)",
      'print("42" in repr(dir(js)), file=sys.stderr)',
    ].join("\n"));
    const sent: unknown[] = [];
    await page.exposeFunction("recordMessage", (text: string) => sent.push(text));
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message: unknown, transfer?: never) {
        const { type, files, collect } = message as { type: string; files?: unknown; collect?: unknown };
        if (type === "run") (window as unknown as { recordMessage(text: string): void }).recordMessage(JSON.stringify({ keys: Object.keys(message as object), files, collect }));
        return original.call(this, message, transfer as never);
      };
    });
    await checkButton(page).click();
    await expect(runButton(page)).toBeVisible({ timeout: 80_000 });
    expect(sent.length).toBe(SUM_TESTS);
    for (const message of sent as string[]) {
      expect(JSON.parse(message).keys.sort()).toEqual(["collect", "entry", "files", "stdin", "type"]);
      expect(message).not.toContain("expected");
      expect(message).not.toContain('"output');
    }
  });
});

test.describe("check scripts", () => {
  test("accept any valid answer, using the input", async ({ page }) => {
    await openTask(page, "check-task");
    await checkCode(page, "n = int(input())\nfor d in range(2, n + 1):\n    if n % d == 0:\n        print(d)\n        break");
    await expect(summary(page)).toHaveText("Все тесты пройдены: 3");
    await checkCode(page, "print(int(input()))");
    await expect(summary(page)).toHaveText("Все тесты пройдены: 3");
  });

  test("reject wrong answers", async ({ page }) => {
    await openTask(page, "check-task");
    await checkCode(page, "input()\nprint(1)");
    await expect(summary(page)).toHaveText("Пройдено тестов: 0 из 3");
    await expect(page.locator(".result").first()).toContainText("неверный ответ");
  });

  test("a failing script is reported as the task's fault, without leaking its details", async ({ page }) => {
    await openTask(page, "check-task");
    await checkCode(page, 'print("сломай проверку")');
    await expect(page.locator(".result").first()).toContainText("ошибка в проверке задачи");
    await expect(page.locator(".check-results")).not.toContainText("секрет проверки");
  });

  test("a hanging script doesn't hang the check", async ({ page }) => {
    test.setTimeout(120_000);
    await openTask(page, "check-task");
    await checkCode(page, 'print("зависни")');
    await expect(page.locator(".result").last()).toContainText("ошибка в проверке задачи");
  });

  test("programs that fail aren't sent to the script, and can't reach it", async ({ page }) => {
    await openTask(page, "check-task");
    const sent: string[] = [];
    await page.exposeFunction("recordFiles", (names: string) => sent.push(names));
    await page.evaluate(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message: unknown, transfer?: never) {
        const { type, files } = message as { type: string; files?: Record<string, string> };
        if (type === "run") (window as unknown as { recordFiles(names: string): void }).recordFiles(Object.keys(files!).sort().join(","));
        return original.call(this, message, transfer as never);
      };
    });
    await checkCode(page, "import os\nprint(int(input()))\nprint(os.listdir('.'), flush=True)\nraise SystemExit(0 if len(os.listdir('.')) == 1 else 5)");
    const programs = sent.filter((names) => !names.includes("check.py"));
    expect(programs.length).toBe(3);
    expect(programs.every((names) => !names.includes("check"))).toBe(true);
    await expect(page.locator(".check-results")).not.toContainText("ошибка при выполнении");
  });
});

test.describe("workspaces", () => {
  async function openWorkspaceSwitcher(page: Page, isMobile: boolean | undefined) {
    if (isMobile) await page.getByRole("button", { name: "Задачи" }).click();
  }

  async function pickWorkspace(page: Page, name: string, isMobile: boolean | undefined) {
    await openWorkspaceSwitcher(page, isMobile);
    await (isMobile ? page.locator(".curtain-item", { hasText: name }) : page.getByRole("tab", { name })).click();
  }

  test("Scratch and tasks keep separate code; a new task starts fresh", async ({ page, isMobile }) => {
    await page.goto("/ide/1/");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await setCode(page, "print('черновик')");
    await page.waitForTimeout(500);

    await page.goto("/ide/1/?task=sum-task");
    await expect(statement(page)).toBeVisible({ timeout: 30_000 });
    await showCode(page);
    await expect(editor(page)).toContainText("Напишите решение");
    await expect(editor(page)).not.toContainText("черновик");
    await setCode(page, "print('решение')");

    await pickWorkspace(page, "Черновик", isMobile);
    await expect(editor(page)).toContainText("черновик");
    await expect(fileName(page)).toHaveText("main.py");
    await expect(statement(page)).toHaveCount(0);

    await pickWorkspace(page, "Сумма двух чисел", isMobile);
    await showCode(page);
    await expect(editor(page)).toContainText("решение");
    await expect(fileName(page)).toHaveText("summa.py");
  });

  test("reopening the link resumes the work, and a reload restores the tabs", async ({ page }) => {
    await openTask(page);
    await setCode(page, "print('моё решение')");
    await page.waitForTimeout(500);
    await openTask(page);
    await showCode(page);
    await expect(editor(page)).toContainText("моё решение");

    await page.goto("/ide/1/");
    await expect(statement(page)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\?task=sum-task$/);
    await showCode(page);
    await expect(editor(page)).toContainText("моё решение");
  });

  test("closing keeps the work, and Recent brings it back", async ({ page, isMobile }) => {
    await openTask(page);
    await setCode(page, "print('сохранится')");
    await page.waitForTimeout(500);
    if (isMobile) {
      await page.getByRole("button", { name: "Задачи" }).click();
      await page.getByRole("button", { name: /Закрыть/ }).click();
      await page.locator(".curtain-backdrop").click({ position: { x: 380, y: 300 } });
    } else {
      await page.getByRole("button", { name: /Закрыть/ }).click();
    }
    await expect(statement(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/task=/);

    if (isMobile) await page.getByRole("button", { name: "Задачи" }).click();
    else await page.locator(".recent-menu summary").click();
    await page.locator(".recent-open", { hasText: "Сумма двух чисел" }).click();
    await expect(statement(page)).toBeVisible();
    await showCode(page);
    await expect(editor(page)).toContainText("сохранится");
  });

  test("deleting from Recent removes the code, after confirming", async ({ page, isMobile }) => {
    await openTask(page);
    await setCode(page, "print('удалится')");
    await page.waitForTimeout(500);
    if (isMobile) {
      await page.getByRole("button", { name: "Задачи" }).click();
      await page.getByRole("button", { name: /Закрыть/ }).click();
    } else {
      await page.getByRole("button", { name: /Закрыть/ }).click();
      await page.locator(".recent-menu summary").click();
    }
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /^Удалить/ }).click();
    await expect(page.locator(".recent-open")).toHaveCount(0);
    await openTask(page);
    await showCode(page);
    await expect(editor(page)).toContainText("Напишите решение");
  });

  test("switching away stops a running program", async ({ page, isMobile }) => {
    await openTask(page);
    await setCode(page, 'print("работает")\nwhile True: pass');
    await runButton(page).click();
    await expect(page.locator(".terminal")).toContainText("работает", { timeout: 60_000 });
    await pickWorkspace(page, "Черновик", isMobile);
    await expect(runButton(page)).toBeVisible({ timeout: 5000 });
    await showCode(page);
    await expect(editor(page)).not.toContainText("работает");
  });

  test("each workspace has its own undo history", async ({ page, isMobile }) => {
    test.skip(isMobile, "undo uses a hardware keyboard");
    await page.goto("/ide/1/");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await editor(page).click();
    await page.keyboard.insertText("scratch");
    await page.goto("/ide/1/?task=sum-task");
    await expect(statement(page)).toBeVisible({ timeout: 30_000 });
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(editor(page)).toContainText("Напишите решение");
  });

  test("the starting code can be restored, and that can be undone", async ({ page, isMobile }) => {
    await openTask(page);
    await setCode(page, "print('мой код')");
    const more = page.getByRole("button", { name: "Ещё" });
    if (await more.isVisible()) await more.click();
    await page.getByRole("button", { name: "Вернуть начальный код" }).click();
    await expect(editor(page)).toContainText("Напишите решение");
    test.skip(isMobile, "undo uses a hardware keyboard");
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(editor(page)).toContainText("мой код");
  });

  test("several files stay main.py, run together and save as a zip", async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      delete (Window.prototype as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await openTask(page, "multi-task");
    await expect(fileName(page)).toHaveText("main.py");
    await checkButton(page).click();
    await expect(summary(page)).toHaveText("Все тесты пройдены: 1", { timeout: 60_000 });
    const more = page.getByRole("button", { name: "Ещё" });
    if (await more.isVisible()) await more.click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Сохранить на диск" }).click();
    expect((await downloading).suggestedFilename()).toBe("multi.zip");
  });

  test("a task's file saves under its suggested name", async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
      delete (Window.prototype as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    await openTask(page);
    const more = page.getByRole("button", { name: "Ещё" });
    if (await more.isVisible()) await more.click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Сохранить на диск" }).click();
    expect((await downloading).suggestedFilename()).toBe("summa.py");
  });
});

test.describe("narrow screens", () => {
  test("open on the statement, with the check results in their own tab", async ({ page, isMobile }) => {
    test.skip(!isMobile, "narrow layout");
    await openTask(page);
    await expect(page.getByRole("tab", { name: "Условие" })).toHaveAttribute("aria-selected", "true");
    await expect(editor(page)).toBeHidden();
    await expect(page.getByRole("tab", { name: "Проверка" })).toHaveCount(0);
    await checkCode(page, SOLUTION);
    await expect(page.getByRole("tab", { name: "Проверка" })).toHaveAttribute("aria-selected", "true");
    await expect(summary(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("list workspaces in a side curtain, not a second row of tabs", async ({ page, isMobile }) => {
    test.skip(!isMobile, "narrow layout");
    await openTask(page);
    await expect(page.locator(".workspace-tabs")).toHaveCount(0);
    await page.getByRole("button", { name: "Задачи" }).click();
    const items = page.locator(".curtain-item");
    await expect(items).toHaveText(["Черновик", "Сумма двух чисел"]);
    await items.first().click();
    await expect(page.locator(".curtain")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Условие" })).toHaveCount(0);
    await expect(editor(page)).toBeVisible();
  });
});
