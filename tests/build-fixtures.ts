// Builds the fixture tasks with the real CLI, so the tests cover what authors actually publish.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

export default function buildFixtures() {
  for (const name of readdirSync("tests/fixtures")) {
    execFileSync("python", ["tools/pytask.py", "build", `tests/fixtures/${name}`, "--out", "dist/ide/tasks"], { stdio: "pipe" });
  }
}
