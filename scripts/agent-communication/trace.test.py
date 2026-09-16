import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("communication_trace", Path(__file__).with_name("trace.py"))
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


def exchange(tool, args, receipt, call_id="call", error=False):
    return [
        {"type": "message", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "id": call_id, "name": tool, "arguments": args}
        ]}},
        {"type": "message", "message": {"role": "toolResult", "toolCallId": call_id,
            "toolName": tool, "isError": error, "timestamp": 123,
            "content": [{"type": "text", "text": json.dumps(receipt)}]}},
    ]


class TraceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def capture(self, name, rows):
        path = self.root / f"{name}.jsonl"
        path.write_text("\n".join(json.dumps(row) for row in [
            {"type": "session", "id": name, **({"parentSession": "parent.jsonl"} if name != "parent" else {})}, *rows
        ]) + "\n")
        return path

    def test_hints_and_titles_are_not_body_reads(self):
        rows = [{"type": "message", "message": {"role": "custom", "content": "latest_id=bd-1"}}]
        rows += exchange("list_agent_contacts", {}, {"board": {"total": 1, "latestId": "bd-1"}})
        rows += exchange("read_agent_board", {}, {"ok": True, "entries": [{"id": "bd-1", "title": "found"}]}, "read")
        report = trace.analyze([self.capture("reader", rows)])
        self.assertEqual(report["summary"]["board_body_returns"], 0)
        self.assertEqual(len(report["warnings"]), 1)

    def test_repeated_reads_are_distinct_from_unique_entries_and_own_posts(self):
        entries = [{"id": "bd-1", "authorAgentId": "peer", "body": "fact"},
                   {"id": "bd-2", "authorAgentId": "reader-agent", "body": "own"}]
        rows = exchange("read_agent_board", {}, {"ok": True, "entries": entries})
        rows += exchange("read_agent_board", {}, {"ok": True, "entries": entries}, "again")
        reader = self.capture("reader", rows)
        parent = self.capture("parent", [{"customType": "subagents:record", "data": {
            "id": "reader-agent", "sessionFile": str(reader)}}])
        summary = trace.analyze([reader, parent])["summary"]
        self.assertEqual(summary["board_body_returns"], 4)
        self.assertEqual(summary["unique_reader_entry_pairs"], 2)
        self.assertEqual(summary["known_peer_body_returns"], 2)
        self.assertEqual(summary["unclassified_body_returns"], 0)

    def test_unknown_identity_is_not_assumed_to_be_a_peer(self):
        path = self.capture("reader", exchange("read_agent_board", {}, {"ok": True, "entries": [
            {"id": "bd-1", "authorAgentId": "peer", "body": "fact"}]}))
        summary = trace.analyze([path])["summary"]
        self.assertEqual(summary["known_peer_body_returns"], 0)
        self.assertEqual(summary["unclassified_body_returns"], 1)

    def test_parent_read_is_distinct_from_a_peer_read(self):
        path = self.capture("parent", exchange("read_agent_board", {}, {"ok": True, "entries": [
            {"id": "bd-1", "authorAgentId": "peer", "body": "fact"}]}))
        summary = trace.analyze([path])["summary"]
        self.assertEqual(summary["parent_body_returns"], 1)
        self.assertEqual(summary["known_peer_body_returns"], 0)
        self.assertEqual(summary["unclassified_body_returns"], 0)

    def test_failed_reads_and_unlinked_results_do_not_count(self):
        receipt = {"ok": True, "entries": [{"id": "bd-1", "body": "fact"}]}
        rows = exchange("read_agent_board", {}, receipt, error=True)
        rows += exchange("read_agent_board", {}, receipt, "orphan")[1:]
        report = trace.analyze([self.capture("reader", rows)])
        self.assertEqual(report["summary"]["board_body_returns"], 0)
        self.assertEqual(len(report["warnings"]), 1)

    def test_duplicate_results_do_not_inflate_reads(self):
        rows = exchange("read_agent_board", {}, {"ok": True, "entries": [{"id": "bd-1", "body": "fact"}]})
        rows.append(rows[-1])
        report = trace.analyze([self.capture("reader", rows)])
        self.assertEqual(report["summary"]["board_body_returns"], 1)
        self.assertEqual(len(report["warnings"]), 1)

    def test_question_reply_correlation_uses_accepted_receipts_only(self):
        sender = self.capture("sender", exchange("send_agent_message", {"payload": {"kind": "question"}},
            {"status": "queued_for_running_session", "messageId": "q1"}))
        for status, error, expected in [("queued_for_running_session", False, 1),
                                      ("rejected", False, 0), ("queued_for_running_session", True, 0)]:
            with self.subTest(status=status, error=error):
                receiver = self.capture("receiver", exchange("send_agent_message", {
                    "payload": {"kind": "answer", "reply_to": "q1"}}, {"status": status}, error=error))
                summary = trace.analyze([sender, receiver])["summary"]
                self.assertEqual(summary["accepted_questions"], 1)
                self.assertEqual(summary["questions_with_recorded_accepted_reply"], expected)

    def test_parent_reply_and_same_tool_id_in_another_session(self):
        sender = self.capture("sender", exchange("send_agent_message", {"payload": {"kind": "question"}},
            {"status": "queued_for_parent", "messageId": "q1"}))
        parent = self.capture("parent", exchange("reply_to_agent_message", {"message_id": "q1"},
            {"status": "resume_attempt_completed", "messageId": "q1"}))
        summary = trace.analyze([sender, parent])["summary"]
        self.assertEqual(summary["questions_with_recorded_accepted_reply"], 1)

    def test_usage_includes_parent_worker_and_evaluator_without_guessing_roles(self):
        paths = [self.capture(name, [{"type": "message", "message": {"role": "assistant", "content": [],
            "usage": {"input": 10, "output": 2, "cacheRead": 8}}}]) for name in ["parent", "worker", "evaluator"]]
        self.assertEqual(trace.analyze(paths)["usage"], {"input": 30, "output": 6, "cacheRead": 24, "cacheWrite": 0})

    def test_incomplete_capture_fails_instead_of_silently_undercounting(self):
        path = self.capture("reader", [])
        with path.open("a") as stream:
            stream.write('{"type":')
        with self.assertRaisesRegex(ValueError, "capture may be incomplete"):
            trace.analyze([path])

    def test_duplicate_session_captures_are_rejected(self):
        one = self.capture("reader", [])
        two = self.root / "copy.jsonl"
        two.write_bytes(one.read_bytes())
        with self.assertRaisesRegex(ValueError, "Duplicate capture"):
            trace.analyze([one, two])

    def test_bodies_and_commands_are_not_copied_into_report(self):
        rows = exchange("read_agent_board", {}, {"ok": True, "entries": [{"id": "bd-1", "body": "secret-canary"}]})
        rows += exchange("bash", {"command": "echo secret-canary"}, {}, "check")
        report = trace.analyze([self.capture("reader", rows)])
        self.assertNotIn("secret-canary", json.dumps(report))
        self.assertEqual(report["artifact_actions"][0]["tool"], "bash")
        self.assertIn("not proof", report["scope"])


if __name__ == "__main__":
    unittest.main()
