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
python -m unittest tests/test_pytask.py   # task builder tests
```

Pushing to `main` deploys through GitHub Actions (`.github/workflows/pages.yml`), so the repository's Pages source must be set to GitHub Actions.

* `ide/src/` is the IDE. `ide/public/` is served as is: the service worker that enables `SharedArrayBuffer`, the vendored Pyodide runtime, and `spike/`, a device test page.
* To add a tutorial or other static folder to the site, add it to `scripts/assemble-site.mjs`.

## Tasks
Task sources can live anywhere, including a private repository. `tools/pytask.py` needs only Python 3.11+. `tests/fixtures/sum-task` is a complete example, and the top of the script describes the folder layout.

```
python tools/pytask.py build <task folder> --out ide/public/tasks
```

The build fails if `solution.py` exists and doesn't pass every test. It never packages that file. It prints the task's links:

* **By ID**, for homework: commit the `.pytask` file in `ide/public/tasks/` and push. The link is `/ide/1/?task=<id>`.
* **Inside a link**, for quick tasks: nothing to publish, but it can't be updated after sending, and images aren't supported.
* **As a file**, for classroom use: send the `.pytask` file, and the student drops it on the page or uses Open task.

To update a published task, raise its `version` and rebuild. Students keep their code and get the new statement and tests.

`task.toml` settings:

| Setting | Values | Default |
|---|---|---|
| `id` | lowercase letters, digits, `-`, `_`; don't change it later, because students' code is stored under it | required |
| `version` | whole number | required |
| `title` | text, or `[title]` with `ru` and `en` | the ID |
| `name` | suggested file name, without `.py` | `main` |
| `min_level` | 1 or 2 | 1, or 2 with `uses_files` |
| `uses_files` | `true` or `false` | `false` |
| `comparison` | `lines` ignores trailing spaces and blank lines; `exact`; `tokens` ignores all whitespace differences; `float` compares numbers; `script` runs `check.py` | `lines` |
| `tolerance` | allowed difference for `float` | `1e-6` |
| `time_limit` | seconds per test | 10 |

With `comparison = "script"`, `check.py` in the task folder decides each result. It's packaged in obfuscated form and never runs alongside student code:

```python
def check(output, input):  # the input parameter is optional
    return int(output) > 1 and int(input) % int(output) == 0
```

It gets the program's printed output exactly as is, and returns whether it's correct. Sample outputs are still shown to students, and the build fails if the script rejects them. Tests can skip their `.out` file unless their group is `listed` or `collapsed`, and script tasks can't use `hashed` or `.expect` folders.

Statements are Markdown, plus `$inline$` and `$$block$$` math. Python code blocks get syntax highlighting, and any code block longer than one line gets line numbers. Neighbouring `test` blocks merge into one table.

Closed tests go in `[[group]]` entries with a `name`, `display` and `protection`, and read from `tests/<name>/`:

| `display` | What students see |
|---|---|
| `listed` | input and expected output, under the statement |
| `collapsed` | the same, in a collapsed section |
| `on-fail` | only the group's first failure: input, program output, and expected output unless hashed |
| `hidden` | only pass or fail, plus the kind of failure |

| `protection` | What's in the package |
|---|---|
| `plain` | readable text |
| `obfuscated` | scrambled, to stop casual reading; this is the default |
| `hashed` | inputs scrambled, expected outputs replaced with hashes. Can't use `listed`, `collapsed` or `float` |

All of this only deters. A determined student can always extract test inputs, and anyone can read the published packages.
