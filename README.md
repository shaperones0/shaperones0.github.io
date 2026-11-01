# shaperones0.github.io
Website with various pages and tutorials

Currently implemented tutorials:
* https://shaperones0.github.io/python-install
* https://shaperones0.github.io/vscode-install

## Python IDE
A browser IDE for students, at https://shaperones0.github.io/ide/1/. Programs run in Pyodide, entirely in the browser.

```
npm ci
npm run dev        # development server
npm run build      # type-check and build the whole site into dist/
npx playwright install chromium firefox webkit   # once
npm test           # end-to-end tests against dist/, so build first
```

Pushing to `main` deploys through GitHub Actions (`.github/workflows/pages.yml`), so the repository's Pages source must be set to GitHub Actions.

* `ide/src/` is the IDE. `ide/public/` is served as is: the service worker that enables `SharedArrayBuffer`, the vendored Pyodide runtime, and `spike/`, a device test page.
* To add a tutorial or other static folder to the site, add it to `scripts/assemble-site.mjs`.
