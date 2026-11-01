#!/usr/bin/env python3
"""Builds .pytask packages for the browser IDE. Needs only the standard library.

    python tools/pytask.py build <task folder> --out ide/public/tasks

A task folder looks like this (see tests/fixtures/sum-task for a full example):

    task.toml         settings and closed test groups
    statement.ru.md   statement; at least one language is required
    statement.en.md
    assets/           images, referenced from the statement by relative paths
    starter/          optional starting files; main.py is the program
    solution.py       optional reference solution; never packaged
    tests/<group>/    closed tests: 01.in, 01.out, optionally 01.files/ and 01.expect/

Open tests are written in the statement, as fenced blocks with the language "test":
the input, a line of ---, then the expected output.
"""
import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import tomllib
import zipfile
import zlib
from io import BytesIO
from pathlib import Path

FORMAT = 1
DEFAULT_SITE = "https://shaperones0.github.io/ide/1/"
DEFAULT_TIME_LIMIT = 10
SOFT_LINK_LIMIT = 4000
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]*")
TEST_FENCE = re.compile(r"^```test[ \t]*\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)
SEPARATOR = re.compile(r"^---[ \t]*$", re.MULTILINE)
WHITESPACE = re.compile(r"[ \t\r\n\f\v]+")
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
DISPLAYS = {"listed", "collapsed", "on-fail", "hidden"}
PROTECTIONS = {"plain", "obfuscated", "hashed"}
COMPARISONS = {"exact", "lines", "tokens", "float"}


class TaskError(Exception):
    pass


def normalize(mode, text):
    """Must match normalize() in ide/src/tasks/protect.ts, or hashed tests never pass."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if mode == "exact":
        return text
    if mode == "lines":
        return "\n".join(line.rstrip(" \t") for line in text.split("\n")).rstrip("\n")
    return " ".join(token for token in WHITESPACE.split(text) if token)


def tokens_match(actual, expected, tolerance):
    actual, expected = actual.split(" "), expected.split(" ")
    if len(actual) != len(expected):
        return False
    for a, b in zip(actual, expected):
        if a == b:
            continue
        try:
            if abs(float(a) - float(b)) > tolerance:
                return False
        except ValueError:
            return False
    return True


def outputs_match(mode, actual, expected, tolerance):
    actual, expected = normalize(mode, actual), normalize(mode, expected)
    return tokens_match(actual, expected, tolerance) if mode == "float" else actual == expected


def output_hash(task_id, position, text):
    """Tied to the task and the test, so equal answers don't get equal hashes."""
    return hashlib.sha256(f"{task_id}\n{position}\n{text}".encode()).hexdigest()


def keystream(seed_text, length):
    seed = int.from_bytes(hashlib.sha256(seed_text.encode()).digest()[:4], "big") | 1
    out = bytearray(length)
    state = seed
    for i in range(length):
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        out[i] = state & 255
    return out


def seal(task_id, group_index, value):
    """Obfuscation only. It stops casual reading; the key is derived from public values."""
    compressed = zlib.compress(json.dumps(value, ensure_ascii=False).encode(), 9)
    stream = keystream(f"pytask:{task_id}:{group_index}", len(compressed))
    return base64.b64encode(bytes(a ^ b for a, b in zip(compressed, stream))).decode()


def read_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def read_tree(folder):
    if not folder.is_dir():
        return {}
    files = {}
    for path in sorted(folder.iterdir()):
        if path.is_file():
            files[path.name] = read_text(path)
    return files


def read_statements(folder):
    statements = {}
    for language in ("ru", "en"):
        path = folder / f"statement.{language}.md"
        if path.exists():
            statements[language] = read_text(path)
    if not statements:
        raise TaskError("no statement: add statement.ru.md or statement.en.md")
    return statements


def parse_open_tests(statement):
    tests = []
    for match in TEST_FENCE.finditer(statement):
        parts = SEPARATOR.split(match.group(1), maxsplit=1)
        if len(parts) != 2:
            raise TaskError("a test block needs its input, a --- line, then its output")
        tests.append({"input": parts[0].removeprefix("\n"), "output": parts[1].removeprefix("\n")})
    return tests


def open_tests_from(statements):
    per_language = {language: parse_open_tests(text) for language, text in statements.items()}
    first, *others = per_language.values()
    if any(other != first for other in others):
        raise TaskError("statements in different languages have different test blocks")
    return first


def read_closed_tests(folder):
    if not folder.is_dir():
        raise TaskError(f"test folder not found: {folder}")
    tests = []
    for input_path in sorted(folder.glob("*.in")):
        stem = input_path.stem
        output_path = folder / f"{stem}.out"
        expect_files = read_tree(folder / f"{stem}.expect")
        if not output_path.exists() and not expect_files:
            raise TaskError(f"{input_path} has no {stem}.out or {stem}.expect/")
        test = {"input": read_text(input_path)}
        if output_path.exists():
            test["output"] = read_text(output_path)
        files = read_tree(folder / f"{stem}.files")
        if files:
            test["files"] = files
        if expect_files:
            test["expectFiles"] = expect_files
        tests.append(test)
    if not tests:
        raise TaskError(f"no tests in {folder}")
    return tests


def hash_outputs(task_id, group_index, tests, mode):
    hashed = []
    for test_index, test in enumerate(tests):
        position = f"{group_index}.{test_index}"
        result = {key: value for key, value in test.items() if key not in ("output", "expectFiles")}
        if "output" in test:
            result["outputHash"] = output_hash(task_id, position, normalize(mode, test["output"]))
        if "expectFiles" in test:
            result["expectFileHashes"] = {
                name: output_hash(task_id, f"{position}:{name}", normalize(mode, text))
                for name, text in test["expectFiles"].items()
            }
        hashed.append(result)
    return hashed


def check_group_settings(settings, mode):
    display = settings.get("display", "hidden")
    protection = settings.get("protection", "obfuscated")
    if display not in DISPLAYS:
        raise TaskError(f"unknown display: {display}")
    if protection not in PROTECTIONS:
        raise TaskError(f"unknown protection: {protection}")
    if protection == "hashed" and display in ("listed", "collapsed"):
        raise TaskError(f"a {display} group shows expected output, so it can't be hashed")
    if protection == "hashed" and mode == "float":
        raise TaskError("float comparison needs the expected numbers, so it can't be hashed")
    return display, protection


def load_task(folder):
    config_path = folder / "task.toml"
    if not config_path.exists():
        raise TaskError(f"not found: {config_path}")
    config = tomllib.loads(read_text(config_path))

    task_id = config.get("id", "")
    if not ID_PATTERN.fullmatch(task_id):
        raise TaskError(f"id must use lowercase letters, digits, - and _: {task_id!r}")
    version = config.get("version")
    if not isinstance(version, int) or version < 1:
        raise TaskError("version must be a positive whole number")
    mode = config.get("comparison", "lines")
    if mode not in COMPARISONS:
        raise TaskError(f"unknown comparison: {mode}")
    uses_files = bool(config.get("uses_files", False))
    min_level = config.get("min_level", 2 if uses_files else 1)
    if uses_files and min_level < 2:
        raise TaskError("uses_files needs min_level 2, because Level 1 has no file system")

    statements = read_statements(folder)
    groups = []
    open_tests = open_tests_from(statements)
    if open_tests:
        groups.append({"name": "open", "display": "listed", "protection": "plain", "inline": True, "tests": open_tests})
    for settings in config.get("group", []):
        display, protection = check_group_settings(settings, mode)
        name = settings.get("name")
        if not name:
            raise TaskError("every [[group]] needs a name")
        tests = read_closed_tests(folder / settings.get("dir", f"tests/{name}"))
        group = {"name": name, "display": display, "protection": protection}
        group_index = len(groups)
        if protection == "plain":
            group["tests"] = tests
        elif protection == "obfuscated":
            group["sealed"] = seal(task_id, group_index, tests)
        else:
            group["sealed"] = seal(task_id, group_index, hash_outputs(task_id, group_index, tests, mode))
        group["_tests"] = tests
        groups.append(group)

    manifest = {
        "format": FORMAT,
        "id": task_id,
        "version": version,
        "title": config.get("title", task_id),
        "minLevel": min_level,
        "usesFiles": uses_files,
        "comparison": mode,
        "timeLimit": config.get("time_limit", DEFAULT_TIME_LIMIT),
    }
    if "name" in config:
        if not re.fullmatch(r"[^/\\:*?\"<>|.][^/\\:*?\"<>|]*", config["name"]):
            raise TaskError(f"name can't be used as a file name: {config['name']!r}")
        manifest["name"] = config["name"]
    if mode == "float":
        manifest["tolerance"] = config.get("tolerance", 1e-6)
    return manifest, statements, groups


def validate_solution(folder, solution, manifest, groups):
    """Runs the reference solution against every test, so a bad test can't reach students."""
    mode, tolerance = manifest["comparison"], manifest.get("tolerance", 0)
    failures = []
    count = 0
    for group in groups:
        for index, test in enumerate(group.get("_tests") or group["tests"]):
            count += 1
            label = f"{group['name']} #{index + 1}"
            with tempfile.TemporaryDirectory() as workdir:
                workdir = Path(workdir)
                for name, text in test.get("files", {}).items():
                    (workdir / name).write_text(text, encoding="utf-8")
                try:
                    done = subprocess.run(
                        [sys.executable, "-X", "utf8", str(solution.resolve())],
                        input=test["input"].encode(), capture_output=True, cwd=workdir, timeout=30,
                    )
                except subprocess.TimeoutExpired:
                    failures.append(f"{label}: timed out")
                    continue
                if done.returncode:
                    failures.append(f"{label}: exit code {done.returncode}\n{done.stderr.decode(errors='replace')}")
                    continue
                if "output" in test and not outputs_match(mode, done.stdout.decode(), test["output"], tolerance):
                    failures.append(f"{label}: wrong output\n  expected: {test['output']!r}\n  actual:   {done.stdout.decode()!r}")
                for name, text in test.get("expectFiles", {}).items():
                    produced = workdir / name
                    actual = produced.read_bytes().decode() if produced.exists() else None
                    if actual is None or not outputs_match(mode, actual, text, tolerance):
                        failures.append(f"{label}: wrong file {name}")
    if failures:
        raise TaskError("the solution failed its tests:\n" + "\n".join(failures))
    return count


def add_file(archive, name, data):
    # A fixed date keeps rebuilds byte-identical, so unchanged tasks don't show up in git.
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, data, compresslevel=9)


def build_package(folder, manifest, statements, groups):
    tests = [{key: value for key, value in group.items() if key != "_tests"} for group in groups]
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        add_file(archive, "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        add_file(archive, "tests.json", json.dumps(tests, ensure_ascii=False))
        for language, text in statements.items():
            add_file(archive, f"statement.{language}.md", text)
        for name, text in read_tree(folder / "starter").items():
            add_file(archive, f"starter/{name}", text)
        assets = folder / "assets"
        if assets.is_dir():
            for path in sorted(assets.iterdir()):
                if path.suffix.lower() not in IMAGE_TYPES:
                    raise TaskError(f"not a supported image: {path.name}")
                add_file(archive, f"assets/{path.name}", path.read_bytes())
    return buffer.getvalue()


def task_link(data, site):
    encoded = base64.urlsafe_b64encode(data).rstrip(b"=").decode()
    return f"{site}#pkg={encoded}"


def build(args):
    folder = Path(args.folder)
    manifest, statements, groups = load_task(folder)

    solution = folder / "solution.py"
    if solution.exists():
        count = validate_solution(folder, solution, manifest, groups)
        print(f"solution passed {count} test(s)")
    else:
        print("note: no solution.py, so the tests were not validated")

    data = build_package(folder, manifest, statements, groups)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{manifest['id']}.pytask"
    target.write_bytes(data)
    print(f"wrote {target} ({len(data)} bytes)")
    print(f"by id: {args.site}?task={manifest['id']}")

    link = task_link(data, args.site)
    if (folder / "assets").is_dir():
        print("link: skipped, because this task has images; use the file or the id")
    elif len(link) > SOFT_LINK_LIMIT:
        print(f"link: {link}")
        print(f"warning: the link is {len(link)} characters, and messengers may cut it; send the file instead")
    else:
        print(f"link: {link}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Builds .pytask packages for the browser IDE.")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("build", help="check a task folder and build its package")
    command.add_argument("folder")
    command.add_argument("--out", default="ide/public/tasks")
    command.add_argument("--site", default=DEFAULT_SITE, help="address of the IDE page, for the printed links")
    command.set_defaults(run=build)
    args = parser.parse_args()
    try:
        args.run(args)
    except TaskError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
