#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import summarize_results

BASE_RESULT = {
    "trial_name": "sample-task__abc123",
    "task_name": "terminal-bench/sample-task",
    "config": {"agent": {"model_name": "kimchi-dev/kimi-k2.6"}},
    "agent_execution": {
        "started_at": "2026-06-18T12:00:00Z",
        "finished_at": "2026-06-18T12:01:00Z",
    },
    "verifier": {
        "started_at": "2026-06-18T12:01:01Z",
        "finished_at": "2026-06-18T12:01:09Z",
    },
    "verifier_result": {"rewards": {"reward": 0}},
}


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def write_session(trial_dir: Path, text: str) -> None:
    sessions_dir = trial_dir / "agent" / "sessions"
    sessions_dir.mkdir(parents=True)
    entry = {
        "type": "message",
        "message": {
            "role": "toolResult",
            "content": [{"type": "text", "text": text}],
        },
    }
    (sessions_dir / "main.jsonl").write_text(json.dumps(entry) + "\n", encoding="utf-8")


class SummarizeResultsClassificationTest(unittest.TestCase):
    def summarize(self, result: dict, session_text: str | None = None, verifier_stdout: str | None = None):
        from classify import classify as _classify
        with tempfile.TemporaryDirectory() as tmp:
            trial_dir = Path(tmp) / "sample-task__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", result)
            if session_text is not None:
                write_session(trial_dir, session_text)
            if verifier_stdout is not None:
                verifier_dir = trial_dir / "verifier"
                verifier_dir.mkdir()
                (verifier_dir / "test-stdout.txt").write_text(verifier_stdout, encoding="utf-8")

            # Simulate chunk_runner.py: classify and enrich result.json before summarize_trial reads it.
            verdict = _classify(trial_dir)
            write_json(trial_dir / "result.json", {
                **verdict.raw,
                "outcome": verdict.outcome,
                "error_category": verdict.error_category,
                "error_subcategory": verdict.error_subcategory,
            })

            warnings: list[str] = []
            return summarize_results.summarize_trial(trial_dir, 1, warnings)

    def result_with_exception(self, exception_type: str, message: str) -> dict:
        result = json.loads(json.dumps(BASE_RESULT))
        result["exception_info"] = {
            "exception_type": exception_type,
            "exception_message": message,
            "exception_traceback": "Traceback omitted for test",
            "occurred_at": "2026-06-18T12:00:59Z",
        }
        return result

    def assert_error(self, result: dict, expected_type: str, expected_evidence: str, **kwargs) -> None:
        summary = self.summarize(result, **kwargs)
        data = summary.to_summary_json()
        self.assertEqual(data["error"]["type"], expected_type)
        self.assertIn(expected_evidence, data["error"]["message"])

    def test_classifies_model_catalog_unavailable_from_real_cli_text(self) -> None:
        message = """stdout: Could not load the model list right now (Failed to fetch models: The operation timed out.). Continuing; models will refresh once the service is reachable.\nNo API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key."""  # noqa: E501
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_model_catalog_unavailable", "Could not load the model list")

    def test_classifies_stale_extension_context_before_catalog_fallback(self) -> None:
        message = """stdout: Could not load the model list right now (Failed to fetch models: The operation timed out.).\nNo API key found for the selected model.\nerror: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()."""  # noqa: E501
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_stale_extension_context", "extension ctx is stale")

    def test_classifies_request_aborted(self) -> None:
        message = "stdout: Request was aborted.\nstderr: None"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_request_aborted", "Request was aborted")

    def test_prefers_session_evidence_when_session_artifact_exists(self) -> None:
        result = self.result_with_exception("NonZeroAgentExitCodeError", "stdout: Request was aborted.")

        summary = self.summarize(result, session_text="error: Request was aborted.")
        data = summary.to_summary_json()

        self.assertEqual(data["error"]["type"], "agent_request_aborted")
        self.assertEqual(data["error"]["message"], "error: Request was aborted.")

    def test_prefers_matching_wrapper_evidence_over_generic_session_noise(self) -> None:
        result = self.result_with_exception("NonZeroAgentExitCodeError", "stdout: Request was aborted.")

        summary = self.summarize(result, session_text="Traceback (most recent call last):")
        data = summary.to_summary_json()

        self.assertEqual(data["error"]["type"], "agent_request_aborted")
        self.assertEqual(data["error"]["message"], "stdout: Request was aborted.")

    def test_classifies_agent_timeout(self) -> None:
        message = "Agent execution timed out after 900.0 seconds"
        result = self.result_with_exception("AgentTimeoutError", message)

        summary = self.summarize(result)
        data = summary.to_summary_json()
        # agent_timeout verdict is self-describing; error.type falls back to exception type
        self.assertEqual(data["verdict"], "agent_timeout")
        self.assertIsNone(data["error_category"])
        self.assertIn("timed out after 900.0 seconds", data["error"]["message"])

    def test_classifies_agent_transport_error(self) -> None:
        message = "stdout: The socket connection was closed unexpectedly. For more information, pass `verbose: true`."
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_transport_error", "socket connection was closed unexpectedly")

    def test_classifies_agent_transport_connection_reset(self) -> None:
        message = (
            "stdout: proxying request: Post http://localhost:10000/v1/chat/completions: "
            "read tcp 127.0.0.1:44794->127.0.0.1:10000: read: connection reset by peer"
        )
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_transport_error", "connection reset by peer")

    def test_classifies_agent_upstream_error(self) -> None:
        message = 'stdout: {"detail":"InternalServerError: Hosted_vllmException - Server disconnected"}'
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_upstream_error", "Hosted_vllmException")

    def test_classifies_weighted_dispatch_upstream_error(self) -> None:
        message = "stdout: weighted dispatch: organization ID not found in context"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_upstream_error", "organization ID not found")

    def test_classifies_agent_command_timeout(self) -> None:
        message = "stdout: Command timed out after 300 seconds"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_command_timeout", "Command timed out after")

    def test_classifies_agent_process_killed(self) -> None:
        message = "stdout: 50 Killed | /installed-agent/bin/kimchi --print --session /logs/agent/sessions/main.jsonl"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_process_killed", "Killed")

    def test_classifies_agent_process_exit_137_as_killed(self) -> None:
        message = "Command failed (exit 137): /installed-agent/bin/kimchi --print\nstdout: None\nstderr: None"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_process_killed", "exit 137")

    def test_classifies_agent_environment_missing_system_user(self) -> None:
        message = "stdout: /usr/lib/tmpfiles.d/systemd-network.conf:10: Failed to resolve user 'systemd-network': No such process"  # noqa: E501
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_environment_error", "Failed to resolve user")

    def test_classifies_agent_environment_missing_linker_library(self) -> None:
        message = "stdout: /usr/bin/ld: cannot find -llapack: No such file or directory"
        result = self.result_with_exception("NonZeroAgentExitCodeError", message)

        self.assert_error(result, "agent_environment_error", "cannot find -llapack")

    def test_classifies_agent_exit_after_success(self) -> None:
        result = self.result_with_exception(
            "NonZeroAgentExitCodeError",
            "stdout: The socket connection was closed unexpectedly.",
        )
        result["verifier_result"]["rewards"]["reward"] = 1

        summary = self.summarize(result)
        data = summary.to_summary_json()

        # reward==1.0 → scored_pass regardless of the exception
        self.assertEqual(data["status"], "passed")
        self.assertEqual(data["verdict"], "scored_pass")

    def test_classifies_verifier_timeout_and_marks_verifier_timeout(self) -> None:
        result = self.result_with_exception("VerifierTimeoutError", "Verifier execution timed out after 900.0 seconds")
        result["exception_info"]["occurred_at"] = "2026-06-18T12:01:05Z"

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(data["error"]["type"], "verifier_timeout")
        self.assertIn("Verifier execution timed out", data["error"]["message"])
        self.assertEqual(summarize_results.verifier_summary(result).status, "timeout")

    def test_scored_fail_when_verifier_ran_and_bad_score(self) -> None:
        result = json.loads(json.dumps(BASE_RESULT))

        summary = self.summarize(
            result,
            verifier_stdout="FAILED tests/test_outputs.py::test_xss - AssertionError: alert did not trigger\n",
        )
        data = summary.to_summary_json()

        # No exception + bad score → scored_fail; error.type is empty (verdict is self-describing)
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["verdict"], "scored_fail")
        self.assertIsNone(data["error_category"])
        self.assertEqual(summarize_results.verifier_summary(result).status, "completed")

    def test_tracks_verifier_not_started(self) -> None:
        result = json.loads(json.dumps(BASE_RESULT))
        result.pop("verifier")
        result.pop("verifier_result")
        result["exception_info"] = {
            "exception_type": "NonZeroAgentExitCodeError",
            "exception_message": "Command failed during agent setup",
            "occurred_at": "2026-06-18T12:00:59Z",
        }

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(summarize_results.verifier_summary(result).status, "not_started")
        self.assertEqual(data["error"]["type"], "agent_execution_failed")


    def test_summarize_trial_reads_outcome_from_result_json(self) -> None:
        result = json.loads(json.dumps(BASE_RESULT))
        result["exception_info"] = {"exception_type": "AgentTimeoutError"}

        summary = self.summarize(result)

        self.assertEqual(summary.outcome, "agent_timeout")
        self.assertIsNone(summary.error_category)
        self.assertIsNone(summary.error_subcategory)

        data = summary.to_summary_json()
        self.assertEqual(data["verdict"], "agent_timeout")
        self.assertIsNone(data["error_category"])
        self.assertIsNone(data["error_subcategory"])

    def test_status_is_only_passed_or_failed(self) -> None:
        """status() must never return 'error' — two values only: passed or failed."""
        scenarios = [
            BASE_RESULT,
            self.result_with_exception("AgentTimeoutError", "timed out"),
            self.result_with_exception("ConnectionError", "network failure"),
            self.result_with_exception("NonZeroAgentExitCodeError", "request was aborted"),
            self.result_with_exception("AssertionError", "test failed"),
        ]
        for result in scenarios:
            summary = self.summarize(result)
            data = summary.to_summary_json()
            self.assertIn(data["status"], ("passed", "failed"), f"Unexpected status for {result.get('exception_info')}")


class BuildTaskVerdictsTest(unittest.TestCase):
    def _trial(self, task: str, attempt: int, outcome: summarize_results.Outcome, *, error_subcategory: str | None = None) -> summarize_results.TrialSummary:
        return summarize_results.TrialSummary(
            task=task,
            trial_id=f"{task}__{attempt}",
            attempt=attempt,
            solved=outcome == summarize_results.Outcome.SCORED_PASS,
            reward=1.0 if outcome == summarize_results.Outcome.SCORED_PASS else 0.0,
            exception=None,
            exception_message=None,
            total_time_seconds=60,
            models=[],
            trial_dir=Path("/tmp"),
            start="2026-06-18T12:00:00Z",
            end="2026-06-18T12:01:00Z",
            outcome=outcome,
            error_subcategory=error_subcategory,
        )

    def test_passes_if_any_attempt_passes(self) -> None:
        trials = [
            self._trial("task-a", 1, summarize_results.Outcome.SCORED_FAIL),
            self._trial("task-a", 2, summarize_results.Outcome.SCORED_PASS),
        ]
        verdicts = summarize_results.build_task_verdicts(trials)
        self.assertEqual(len(verdicts), 1)
        self.assertTrue(verdicts[0].passed)
        self.assertEqual(verdicts[0].final_outcome, summarize_results.Outcome.SCORED_PASS)

    def test_fails_with_last_attempt_outcome(self) -> None:
        trials = [
            self._trial("task-b", 1, summarize_results.Outcome.AGENT_TIMEOUT),
            self._trial("task-b", 2, summarize_results.Outcome.SCORED_FAIL),
        ]
        verdicts = summarize_results.build_task_verdicts(trials)
        self.assertFalse(verdicts[0].passed)
        self.assertEqual(verdicts[0].final_outcome, summarize_results.Outcome.SCORED_FAIL)

    def test_error_subcategory_carried_into_verdict(self) -> None:
        trials = [
            self._trial("task-c", 1, summarize_results.Outcome.ERROR, error_subcategory="infra_network_error"),
        ]
        verdicts = summarize_results.build_task_verdicts(trials)
        self.assertFalse(verdicts[0].passed)
        self.assertEqual(verdicts[0].final_outcome, summarize_results.Outcome.ERROR)
        self.assertEqual(verdicts[0].attempts[0].error_subcategory, "infra_network_error")


class FormatTaskTableTest(unittest.TestCase):
    def _verdict(self, task: str, outcomes: list[summarize_results.Outcome], *, error_subcategories: list[str | None] | None = None) -> summarize_results.TaskVerdict:
        if error_subcategories is None:
            error_subcategories = [None] * len(outcomes)
        attempts = [
            summarize_results.TrialSummary(
                task=task,
                trial_id=f"{task}__{i + 1}",
                attempt=i + 1,
                solved=o == summarize_results.Outcome.SCORED_PASS,
                reward=1.0 if o == summarize_results.Outcome.SCORED_PASS else 0.0,
                exception=None,
                exception_message=None,
                total_time_seconds=60,
                models=[],
                trial_dir=Path("/tmp"),
                start="2026-06-18T12:00:00Z",
                end="2026-06-18T12:01:00Z",
                outcome=o,
                error_subcategory=es,
            )
            for i, (o, es) in enumerate(zip(outcomes, error_subcategories))
        ]
        passed = any(t.outcome == summarize_results.Outcome.SCORED_PASS for t in attempts)
        final = summarize_results.Outcome.SCORED_PASS if passed else attempts[-1].outcome
        return summarize_results.TaskVerdict(task=task, attempts=attempts, final_outcome=final, passed=passed)

    def test_table_includes_tasks_attempts_and_final_verdict(self) -> None:
        verdicts = [
            self._verdict("task-a", [summarize_results.Outcome.SCORED_FAIL, summarize_results.Outcome.SCORED_PASS]),
            self._verdict("task-b", [summarize_results.Outcome.AGENT_TIMEOUT]),
            self._verdict("task-c", [summarize_results.Outcome.ERROR], error_subcategories=["infra_network_error"]),
        ]
        table = summarize_results.format_task_table(verdicts)
        self.assertIn("task-a", table)
        self.assertIn("scored_fail → scored_pass", table)
        self.assertIn("task-b", table)
        self.assertIn("agent_timeout", table)
        self.assertIn("task-c", table)
        self.assertIn("error (infra_network_error)", table)
        self.assertIn("passed", table)
        self.assertIn("failed", table)

    def test_empty_verdicts_returns_friendly_message(self) -> None:
        self.assertEqual(summarize_results.format_task_table([]), "No task results to display.")


class WriteSummaryPrintsTableTest(unittest.TestCase):
    def test_write_summary_prints_task_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            trial_dir = results_dir / "sample-task__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "outcome": "scored_pass",
                "error_category": None,
                "error_subcategory": None,
            })
            sessions_dir = trial_dir / "agent" / "sessions"
            sessions_dir.mkdir(parents=True)
            (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
            })

            output_path = tmp_path / "summary.json"

            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)

            stdout = captured.getvalue()
            self.assertIn("sample-task", stdout)
            self.assertIn("scored_pass", stdout)
            self.assertIn("passed", stdout)
            self.assertIn("Final verdict", stdout)


if __name__ == "__main__":
    unittest.main()
