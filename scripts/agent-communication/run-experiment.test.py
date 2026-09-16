import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("run_experiment", Path(__file__).with_name("run-experiment.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "sessions").mkdir()

    def session(self, name, entries, parent=None):
        path = self.root / "sessions" / f"{name}.jsonl"
        path.write_text("\n".join(json.dumps(row) for row in [
            {"type": "session", "id": name, "parentSession": parent}, *entries]) + "\n")
        return path

    def test_parent_answer_before_worker_completion_is_not_final(self):
        self.session("parent", [
            {"customType": "subagents:record", "data": {"id": "worker", "visibility": "user", "status": "completed", "completedAt": 200}},
            {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "timestamp": 100}},
        ])
        self.assertFalse(runner.sample(self.root)["settled"])

    def test_live_worker_prevents_completion_even_after_parent_answer(self):
        self.session("parent", [
            {"customType": "subagents:record", "data": {"id": "worker", "visibility": "user", "status": "running"}},
            {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "timestamp": 300}},
        ])
        self.assertFalse(runner.sample(self.root)["workers_terminal"])

    def test_worker_session_without_terminal_record_prevents_completion(self):
        self.session("parent", [
            {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "timestamp": 300}},
        ])
        self.session("worker", [], parent="parent")
        self.assertFalse(runner.sample(self.root)["workers_terminal"])

    def test_accepted_launch_prevents_completion_before_child_session_exists(self):
        self.session("parent", [
            {"type": "message", "message": {"role": "toolResult", "toolName": "Agent", "details": {"agentId": "worker"}}},
            {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "timestamp": 300}},
        ])
        self.assertFalse(runner.sample(self.root)["workers_terminal"])

    def test_only_parent_settlement_after_latest_request_finishes_the_run(self):
        self.session("parent", [
            {"type": "message", "message": {"role": "assistant", "stopReason": "error", "timestamp": 300}},
        ])
        audit = self.root / "audit.jsonl"
        events = []
        for event, expected in [
            ({"kind": "request", "sessionId": "parent"}, False),
            ({"kind": "settled", "sessionId": "child"}, False),
            ({"kind": "settled", "sessionId": "parent"}, True),
            ({"kind": "request", "sessionId": "parent"}, False),
        ]:
            events.append(event)
            audit.write_text("".join(json.dumps(row) + "\n" for row in events))
            self.assertEqual(runner.sample(self.root, audit)["settled"], expected)

    def test_missing_lifecycle_audit_does_not_establish_completion(self):
        self.session("parent", [
            {"type": "message", "message": {"role": "assistant", "stopReason": "stop", "timestamp": 300}},
        ])
        self.assertFalse(runner.sample(self.root, self.root / "absent.jsonl")["settled"])

    def test_usage_includes_cached_input_and_every_session(self):
        for name, parent in [("parent", None), ("worker", "parent")]:
            self.session(name, [{"type": "message", "message": {"role": "assistant", "usage": {
                "input": 10, "output": 2, "cacheRead": 40, "cacheWrite": 3}}}], parent)
        self.assertEqual(runner.sample(self.root)["usage"], {"input": 20, "output": 4, "cacheRead": 80, "cacheWrite": 6})

    def test_partial_tail_is_tolerated_only_while_being_written(self):
        path = self.session("parent", [])
        with path.open("a") as stream:
            stream.write('{"type":')
        self.assertEqual(len(runner.rows(path)), 1)
        with path.open("a") as stream:
            stream.write("\n")
        with self.assertRaises(json.JSONDecodeError):
            runner.rows(path)

    def test_snapshot_preserves_source_named_sessions_and_publishes_once_complete(self):
        (self.root / "src/sessions").mkdir(parents=True)
        (self.root / "src/sessions/index.ts").write_text("export const active = true")
        (self.root / "sessions/private.jsonl").write_text("{}")
        destination = self.root.parent / (self.root.name + "-snapshot")
        self.addCleanup(shutil.rmtree, destination, True)
        runner.snapshot(self.root, destination)
        self.assertTrue((destination / "src/sessions/index.ts").exists())
        self.assertFalse((destination / "sessions").exists())
        self.assertFalse(destination.with_name(destination.name + ".copying").exists())


if __name__ == "__main__":
    unittest.main()
