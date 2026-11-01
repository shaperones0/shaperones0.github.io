"""Tests for tools/pytask.py. Run with: python -m unittest tests/test_pytask.py"""
import sys
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "tools"))
import pytask  # noqa: E402

STATEMENT = "Текст\n\n```test\n1\n---\n2\n```\n"


def write_task(folder, toml, statement=STATEMENT, solution=None, tests=None):
    (folder / "task.toml").write_text(toml, encoding="utf-8")
    (folder / "statement.ru.md").write_text(statement, encoding="utf-8")
    if solution is not None:
        (folder / "solution.py").write_text(solution, encoding="utf-8")
    for path, text in (tests or {}).items():
        target = folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")


BASE = 'id = "t"\nversion = 1\n'
SECRET_GROUP = '[[group]]\nname = "g"\ndisplay = "hidden"\nprotection = "hashed"\n'
SECRET_TESTS = {"tests/g/01.in": "1\n", "tests/g/01.out": "SECRET-ANSWER\n"}


class TaskFolderTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name) / "task"
        self.folder.mkdir()
        self.out = Path(temp.name) / "out"

    def build(self):
        pytask.build(Namespace(folder=str(self.folder), out=str(self.out), site=pytask.DEFAULT_SITE))
        return (self.out / "t.pytask").read_bytes()

    def assert_rejected(self, fragment, *args, **kwargs):
        write_task(self.folder, *args, **kwargs)
        with self.assertRaises(pytask.TaskError) as caught:
            pytask.load_task(self.folder)
        self.assertIn(fragment, str(caught.exception))

    def test_rejects_ids_that_could_escape_the_tasks_folder(self):
        self.assert_rejected("id must", 'id = "../evil"\nversion = 1\n')

    def test_rejects_hashing_a_group_that_shows_expected_output(self):
        self.assert_rejected("can't be hashed", BASE + '[[group]]\nname = "g"\ndisplay = "listed"\nprotection = "hashed"\n', tests=SECRET_TESTS)

    def test_rejects_hashing_float_comparison(self):
        self.assert_rejected("can't be hashed", BASE + 'comparison = "float"\n' + SECRET_GROUP, tests=SECRET_TESTS)

    def test_rejects_file_tasks_on_level_one(self):
        self.assert_rejected("min_level", BASE + "uses_files = true\nmin_level = 1\n")

    def test_rejects_statements_with_different_tests(self):
        (self.folder / "statement.en.md").write_text("```test\n9\n---\n9\n```\n", encoding="utf-8")
        self.assert_rejected("different test blocks", BASE)

    def test_a_failing_solution_stops_the_build(self):
        write_task(self.folder, BASE, solution="print(3)\n")
        with self.assertRaises(pytask.TaskError):
            self.build()
        self.assertFalse((self.out / "t.pytask").exists())

    def test_a_correct_solution_passes_and_is_never_packaged(self):
        write_task(self.folder, BASE, solution="# reference\nprint(2)\n")
        data = self.build()
        with zipfile.ZipFile(self.out / "t.pytask") as archive:
            self.assertNotIn("solution.py", archive.namelist())
        self.assertNotIn(b"reference", data)

    def test_hashed_answers_are_not_recoverable_by_unsealing(self):
        write_task(self.folder, BASE + SECRET_GROUP, tests=SECRET_TESTS)
        _, _, groups = pytask.load_task(self.folder)
        secret = next(group for group in groups if group["name"] == "g")
        self.assertNotIn("SECRET", secret["sealed"])
        tests = pytask.hash_outputs("t", 1, secret["_tests"], "lines")
        self.assertNotIn("output", tests[0])
        self.assertEqual(len(tests[0]["outputHash"]), 64)

    def test_equal_answers_get_different_hashes(self):
        self.assertNotEqual(pytask.output_hash("t", "0.0", "YES"), pytask.output_hash("t", "0.1", "YES"))

    def test_rebuilding_is_byte_identical(self):
        write_task(self.folder, BASE)
        self.assertEqual(self.build(), self.build())

    def test_comparison_modes(self):
        self.assertTrue(pytask.outputs_match("lines", "a  \nb\n\n", "a\nb", 0))
        self.assertFalse(pytask.outputs_match("lines", " a", "a", 0))
        self.assertTrue(pytask.outputs_match("tokens", "a\n  b", "a b", 0))
        self.assertFalse(pytask.outputs_match("exact", "a\n", "a", 0))
        self.assertTrue(pytask.outputs_match("float", "1.0000001", "1", 1e-6))
        self.assertFalse(pytask.outputs_match("float", "1.1", "1", 1e-6))


if __name__ == "__main__":
    unittest.main()
