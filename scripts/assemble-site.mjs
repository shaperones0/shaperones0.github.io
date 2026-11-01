// Adds the static tutorial pages next to the built IDE, so dist/ is the whole site.
import { cp } from "node:fs/promises";

for (const path of ["data", "python-install", "vscode-install"]) {
  await cp(path, `dist/${path}`, { recursive: true });
}
