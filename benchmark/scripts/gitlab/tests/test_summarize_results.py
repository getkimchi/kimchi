#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from jsonschema import ValidationError, validate

import summarize_results

API_KEY_BUDGET_EXCEEDED = "api_key_budget_exceeded"

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


def test_find_trial_dirs_merges_harbor_and_checkpoint_layouts(tmp_path: Path) -> None:
    jobs = tmp_path / "jobs"
    harbor_trial = jobs / "run-1" / "task-a__harbor"
    checkpoint_trial = jobs / "_checkpoint-restored" / "task-b__checkpoint"
    duplicate_checkpoint = jobs / "_checkpoint-restored" / "task-a__harbor"
    for trial in (harbor_trial, checkpoint_trial, duplicate_checkpoint):
        trial.mkdir(parents=True)
        write_json(
            trial / "result.json",
            {"trial_name": trial.name, "task_name": trial.name.rsplit("__", 1)[0]},
        )

    found = summarize_results.find_trial_dirs(jobs)

    assert found == [harbor_trial, checkpoint_trial]


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

    def test_classifies_api_key_budget_with_specific_subcategory(self) -> None:
        result = self.result_with_exception(
            "NonZeroAgentExitCodeError",
            "API error: insufficient credits to complete request",
        )

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(data["error"]["type"], API_KEY_BUDGET_EXCEEDED)
        self.assertEqual(data["error_category"], "infra")
        self.assertEqual(data["error_subcategory"], API_KEY_BUDGET_EXCEEDED)
        self.assertIn("insufficient credits", data["error"]["message"])

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

    def test_scored_pass_remains_terminal_with_infra_exception(self) -> None:
        result = self.result_with_exception(
            "NonZeroAgentExitCodeError",
            "KIMCHI_INFRA_ERROR: provider transport failure; exiting with code 74",
        )
        result["verifier_result"]["rewards"]["reward"] = 1

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(data["status"], "passed")
        self.assertEqual(data["verdict"], "scored_pass")
        self.assertIsNone(data["error"])
        self.assertIsNone(data["error_category"])
        self.assertIsNone(data["error_subcategory"])

    def test_generic_exit_74_without_marker_is_not_infra_error(self) -> None:
        result = self.result_with_exception(
            "NonZeroAgentExitCodeError",
            "Command failed (exit 74): /installed-agent/bin/kimchi --print",
        )

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(data["error"]["type"], "agent_execution_failed")
        self.assertEqual(data["error_category"], "agent")
        self.assertEqual(data["error_subcategory"], "agent_execution_failed")
        self.assertIn("Command failed (exit 74)", data["error"]["message"])

    def test_classifies_kimchi_exit_error_exception(self) -> None:
        result = self.result_with_exception(
            "KimchiExitError",
            "Kimchi exited with code 74: /installed-agent/bin/kimchi --print",
        )

        self.assert_error(result, "kimchi_infra_exit", "Kimchi exited with code")

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

    def test_passed_trial_has_null_error(self) -> None:
        """Passed trials must emit error: null, not an empty object."""
        result = json.loads(json.dumps(BASE_RESULT))
        result["verifier_result"]["rewards"]["reward"] = 1

        summary = self.summarize(result)
        data = summary.to_summary_json()

        self.assertEqual(data["status"], "passed")
        self.assertIsNone(data["error"])

    def test_agent_timeout_analysis_propagates_to_summary(self) -> None:
        """agent_timeout_analysis from result.json is included in the trial summary.

        Decimal values from json.loads(parse_float=Decimal) must be converted to
        float so the final summary.json is JSON-serializable.
        """
        result = json.loads(json.dumps(BASE_RESULT))
        result["outcome"] = "agent_timeout"
        result["error_category"] = None
        result["error_subcategory"] = None
        result["agent_timeout_analysis"] = {
            "timeout_status": "inference_hang",
            "last_role": "assistant",
            "last_tool_name": None,
            "n_messages": 5,
            "time_since_last_message_sec": Decimal("123.4"),
            "time_since_last_assistant_message_sec": Decimal("123.4"),
            "timeout_duration_sec": Decimal("600.0"),
            "gap_fraction": Decimal("0.98"),
        }

        with tempfile.TemporaryDirectory() as tmp:
            trial_dir = Path(tmp) / "sample-task__abc123"
            trial_dir.mkdir()
            # Decimals must be converted to floats to write valid JSON; summarize_trial
            # reloads the file with parse_float=Decimal, reproducing the CI path.
            write_json(trial_dir / "result.json", json.loads(json.dumps(result, default=float)))

            warnings: list[str] = []
            summary = summarize_results.summarize_trial(trial_dir, 1, warnings)

        self.assertEqual(summary.outcome, "agent_timeout")

        data = summary.to_summary_json()
        self.assertIn("agent_timeout_analysis", data)
        self.assertEqual(data["agent_timeout_analysis"]["timeout_status"], "inference_hang")
        self.assertEqual(data["agent_timeout_analysis"]["timeout_duration_sec"], 600.0)
        # Ensure the summary JSON can be serialized (no Decimal values leak out).
        self.assertIsInstance(json.dumps(data), str)


class BuildTaskVerdictsTest(unittest.TestCase):
    def _trial(
        self,
        task: str,
        attempt: int,
        outcome: summarize_results.Outcome,
        *,
        error_subcategory: str | None = None,
        start: str = "2026-06-18T12:00:00Z",
    ) -> summarize_results.TrialSummary:
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
            start=start,
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

    def test_attempts_sorted_chronologically_not_by_attempt_number(self) -> None:
        # Directory names are random suffixes; attempt numbers may be assigned
        # alphabetically. The verdict must order by real start time.
        trials = [
            self._trial("task-d", 2, summarize_results.Outcome.SCORED_FAIL, start="2026-06-18T12:02:00Z"),
            self._trial("task-d", 1, summarize_results.Outcome.AGENT_TIMEOUT, start="2026-06-18T12:01:00Z"),
            self._trial("task-d", 3, summarize_results.Outcome.SCORED_PASS, start="2026-06-18T12:03:00Z"),
        ]
        verdicts = summarize_results.build_task_verdicts(trials)
        self.assertTrue(verdicts[0].passed)
        self.assertEqual(verdicts[0].final_outcome, summarize_results.Outcome.SCORED_PASS)
        self.assertEqual(
            [t.outcome for t in verdicts[0].attempts],
            [
                summarize_results.Outcome.AGENT_TIMEOUT,
                summarize_results.Outcome.SCORED_FAIL,
                summarize_results.Outcome.SCORED_PASS,
            ],
        )


class FormatTaskTableTest(unittest.TestCase):
    def _verdict(
        self,
        task: str,
        outcomes: list[summarize_results.Outcome],
        *,
        error_subcategories: list[str | None] | None = None,
    ) -> summarize_results.TaskVerdict:
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
            for i, (o, es) in enumerate(zip(outcomes, error_subcategories, strict=False))
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


class WriteSummaryMissingTasksTest(unittest.TestCase):
    def test_write_summary_fails_when_expected_task_has_no_trial(self) -> None:
        """write_summary returns 1 when an expected task never produced a result.json.

        Simulates a chunk that exhausted all retries due to infra errors — the
        task never ran, so no trial directory exists for it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            # Only one trial exists, but two tasks are expected.
            trial_dir = results_dir / "ran-task__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": "ran-task__abc123",
                "task_name": "terminal-bench/ran-task",
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
                "parameters": {"selected_tasks": ["ran-task", "missing-task"]},
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 1)

    def test_write_summary_succeeds_when_all_expected_tasks_ran(self) -> None:
        """write_summary returns 0 when every expected task has at least one trial,
        even if the trial failed.
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            for task in ("task-a", "task-b"):
                trial_dir = results_dir / f"{task}__abc123"
                trial_dir.mkdir()
                write_json(trial_dir / "result.json", {
                    **BASE_RESULT,
                    "trial_name": f"{task}__abc123",
                    "task_name": f"terminal-bench/{task}",
                    "outcome": "scored_fail",
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
                "parameters": {"selected_tasks": ["task-a", "task-b"]},
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 0)

    def test_write_summary_fails_when_task_has_fewer_than_configured_attempts(self) -> None:
        """A GCS-only summary must not publish a partial pass@k sample."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "_checkpoint-restored"
            results_dir.mkdir(parents=True)

            trial_dir = results_dir / "task-a__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": trial_dir.name,
                "task_name": "terminal-bench/task-a",
                "outcome": "scored_pass",
                "error_category": None,
                "error_subcategory": None,
            })

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir.parent),
                "parameters": {
                    "selected_tasks": ["task-a"],
                    "attempts": "2",
                },
            })

            output_path = tmp_path / "summary.json"
            err_buf = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(err_buf):
                rc = summarize_results.write_summary(
                    metadata_path,
                    output_path,
                    results_dir_override=results_dir.parent,
                )

            self.assertEqual(rc, 1)
            self.assertIn("configured attempts", err_buf.getvalue())
            self.assertIn("task-a (1/2 final)", err_buf.getvalue())

    def test_retryable_trials_do_not_fill_attempt_slots_without_exhaustion(self) -> None:
        """Raw retryable checkpoints must not make a partial pass@k publishable."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "_checkpoint-restored"
            results_dir.mkdir(parents=True)

            for index in range(2):
                trial_dir = results_dir / f"task-a__retryable-{index}"
                trial_dir.mkdir()
                write_json(trial_dir / "result.json", {
                    **BASE_RESULT,
                    "trial_name": trial_dir.name,
                    "task_name": "terminal-bench/task-a",
                    "verifier_result": None,
                    "exception_info": {
                        "exception_type": "ConnectionError",
                        "exception_message": "connection reset by peer",
                        "exception_traceback": "",
                        "occurred_at": "2026-01-01T00:00:00Z",
                    },
                })

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir.parent),
                "parameters": {
                    "selected_tasks": ["task-a"],
                    "attempts": "2",
                },
            })

            output_path = tmp_path / "summary.json"
            err_buf = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(err_buf):
                rc = summarize_results.write_summary(
                    metadata_path,
                    output_path,
                    results_dir_override=results_dir.parent,
                )

            self.assertEqual(rc, 1)
            self.assertIn("task-a (0/2 final)", err_buf.getvalue())

    def test_write_summary_accepts_incomplete_attempts_after_chunk_exhaustion(self) -> None:
        """A terminal chunk may publish fewer than k trials with exhaustion metadata."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs"
            trial_dir = results_dir / "run-1" / "task-a__abc123"
            trial_dir.mkdir(parents=True)
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": trial_dir.name,
                "task_name": "terminal-bench/task-a",
                "outcome": "error",
                "error_category": "infra",
                "error_subcategory": "infra_network_error",
            })
            chunk_meta_dir = results_dir / "chunk-meta"
            chunk_meta_dir.mkdir()
            write_json(chunk_meta_dir / "chunk-0.json", {
                "chunk_index": 0,
                "chunk_attempt": 3,
                "exit_code": 0,
                "needs_retry": ["task-a"],
            })

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
                "parameters": {
                    "selected_tasks": ["task-a"],
                    "attempts": "2",
                },
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                rc = summarize_results.write_summary(
                    metadata_path,
                    output_path,
                    results_dir_override=results_dir,
                )

            self.assertEqual(rc, 0)
            summary = json.loads(output_path.read_text())
            self.assertEqual(summary["chunks_exhausted_retries"], ["chunk-0"])

    def test_write_summary_records_no_verdict_for_exhausted_task_without_trial(self) -> None:
        """Exhaustion metadata makes a never-produced trial an explicit unknown."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs"
            chunk_meta_dir = results_dir / "chunk-meta"
            chunk_meta_dir.mkdir(parents=True)
            write_json(chunk_meta_dir / "chunk-0.json", {
                "chunk_index": 0,
                "chunk_attempt": 3,
                "exit_code": 0,
                "needs_retry": ["task-a"],
            })

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
                "parameters": {
                    "selected_tasks": ["task-a"],
                    "attempts": "2",
                },
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                rc = summarize_results.write_summary(
                    metadata_path,
                    output_path,
                    results_dir_override=results_dir,
                )

            self.assertEqual(rc, 0)
            summary = json.loads(output_path.read_text())
            self.assertEqual(summary["totals"]["tasks"]["no_verdict"], 1)


class WriteSummarySweBenchProTaskNamesTest(unittest.TestCase):
    """SWE-bench Pro task names contain multiple '__' segments.

    The trial directory name truncates the full task name (Harbor uses a
    short prefix + random suffix). The task field must be derived from
    result.json's task_name, not from splitting the directory name on '__',
    so that selected_tasks matching works and distinct tasks aren't collapsed.
    """

    def test_swe_bench_pro_task_with_double_underscore_matches_selected_tasks(self) -> None:
        """write_summary returns 0 when a swe-bench-pro task with '__' in its name ran."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            full_task = "instance_ansible__ansible-4c5ce5a1a9e79a845-v1055803c3a812189"
            trial_dir = results_dir / "instance_ansible__ansible__BYQTNFe"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": "instance_ansible__ansible__BYQTNFe",
                "task_name": full_task,
                "outcome": "scored_fail",
                "error_category": None,
                "error_subcategory": None,
            })
            sessions_dir = trial_dir / "agent" / "sessions"
            sessions_dir.mkdir(parents=True)
            (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "swe-bench-pro",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
                "selected_tasks": [full_task],
            })

            output_path = tmp_path / "summary.json"
            err_buf = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(err_buf):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 0)
            self.assertNotIn("never produced a trial", err_buf.getvalue())

            summary = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["totals"]["tasks"]["expected"], 1)
            self.assertEqual(summary["totals"]["trials"]["recorded"], 1)

    def test_two_distinct_swe_bench_pro_tasks_not_collapsed(self) -> None:
        """Two tasks with the same repo family but different full names must not be merged."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            task_a = "instance_flipt-io__flipt-abc123-vdef456"
            task_b = "instance_flipt-io__flipt-xyz789-vghi012"
            for task in (task_a, task_b):
                trial_dir = results_dir / f"instance_flipt-io__flipt__{task[-6:]}"
                trial_dir.mkdir()
                write_json(trial_dir / "result.json", {
                    **BASE_RESULT,
                    "trial_name": trial_dir.name,
                    "task_name": task,
                    "outcome": "scored_fail",
                    "error_category": None,
                    "error_subcategory": None,
                })
                sessions_dir = trial_dir / "agent" / "sessions"
                sessions_dir.mkdir(parents=True)
                (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "swe-bench-pro",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
                "selected_tasks": [task_a, task_b],
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 0)

            summary = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["totals"]["tasks"]["expected"], 2)
            self.assertEqual(len(summary["trials"]), 2)
            trial_tasks = {t["task"] for t in summary["trials"]}
            self.assertEqual(trial_tasks, {task_a, task_b})


class TestWriteSummaryAllErroredTasks(unittest.TestCase):
    """Tasks that ran but only produced error/infra verdicts should warn, not fail."""

    def test_write_summary_succeeds_when_task_only_has_error_trials(self) -> None:
        """write_summary returns 0 when a task was attempted but all trials errored.

        The task has trial dirs with result.json containing infra errors — there
        is evidence it ran. A warning is printed but exit code is 0.
        """
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            trial_dir = results_dir / "errored-task__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": "errored-task__abc123",
                "task_name": "terminal-bench/errored-task",
                "outcome": "error",
                "error_category": "infra",
                "error_subcategory": "agent_process_killed",
            })
            sessions_dir = trial_dir / "agent" / "sessions"
            sessions_dir.mkdir(parents=True)
            (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")
            chunk_meta_dir = results_dir / "chunk-meta"
            chunk_meta_dir.mkdir()
            write_json(chunk_meta_dir / "chunk-0.json", {
                "chunk_index": 0,
                "chunk_attempt": 3,
                "exit_code": 0,
                "needs_retry": ["errored-task"],
                "exhausted": True,
            })

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "results_dir": str(results_dir),
                "parameters": {"selected_tasks": ["errored-task"]},
            })

            output_path = tmp_path / "summary.json"
            err_buf = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(err_buf):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 0)
            self.assertIn("WARNING", err_buf.getvalue())
            self.assertIn("errored-task", err_buf.getvalue())

    def test_write_summary_no_warning_when_task_has_scored_trials(self) -> None:
        """No warning when a task has at least one scored_pass or scored_fail trial."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            trial_dir = results_dir / "task-a__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "trial_name": "task-a__abc123",
                "task_name": "terminal-bench/task-a",
                "outcome": "scored_fail",
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
                "parameters": {"selected_tasks": ["task-a"]},
            })

            output_path = tmp_path / "summary.json"
            err_buf = io.StringIO()
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(err_buf):
                rc = summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)
            self.assertEqual(rc, 0)
            self.assertNotIn("WARNING", err_buf.getvalue())


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

            captured.getvalue()
    def test_write_summary_orders_attempts_chronologically(self) -> None:
        """Random directory suffixes must not reorder attempts alphabetically."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            def _make_trial(name: str, start: str, outcome: str, reward: int) -> Path:
                trial_dir = results_dir / name
                trial_dir.mkdir()
                result = {
                    **BASE_RESULT,
                    "agent_execution": {"started_at": start, "finished_at": start},
                    "verifier_result": {"rewards": {"reward": reward}},
                    "outcome": outcome,
                    "error_category": None,
                    "error_subcategory": None,
                }
                if outcome != "scored_pass":
                    result["exception_info"] = {
                        "exception_type": (
                            "AgentTimeoutError"
                            if outcome == "agent_timeout"
                            else "NonZeroAgentExitCodeError"
                        ),
                        "exception_message": "timeout" if outcome == "agent_timeout" else "fail",
                        "occurred_at": start,
                    }
                write_json(trial_dir / "result.json", result)
                sessions_dir = trial_dir / "agent" / "sessions"
                sessions_dir.mkdir(parents=True)
                (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")
                return trial_dir

            # Alphabetically, "z..." comes before "a...", but chronologically
            # the "a..." trial ran first and the "z..." trial ran last.
            _make_trial("sample-task__zzz", "2026-06-18T12:03:00Z", "scored_pass", 1)
            _make_trial("sample-task__aaa", "2026-06-18T12:01:00Z", "agent_timeout", 0)
            _make_trial("sample-task__mmm", "2026-06-18T12:02:00Z", "scored_fail", 0)

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
                summarize_results.write_summary(
                    metadata_path,
                    output_path,
                    results_dir_override=results_dir,
                )

            stdout = captured.getvalue()
            # Table must list attempts in chronological order, not alphabetical.
            self.assertIn("agent_timeout → scored_fail → scored_pass", stdout)

            # Totals summary is printed before the task table.
            self.assertIn("Benchmark totals", stdout)
            self.assertIn("Trials:  recorded=  3 / expected=  1", stdout)
            self.assertIn("Tasks:   expected=  1", stdout)
            self.assertIn("Tasks with retryable outcome:", stdout)

            summary = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["totals"]["trials"]["recorded"], 3)
            self.assertEqual(summary["totals"]["trials"]["scored_pass"], 1)
            self.assertEqual(summary["totals"]["trials"]["agent_timeout"], 1)
            self.assertEqual(summary["totals"]["trials"]["scored_fail"], 1)
            self.assertEqual(summary["totals"]["tasks"]["expected"], 1)
            self.assertEqual(summary["totals"]["tasks"]["scored_pass"], 1)
            self.assertNotIn("expected", summary["totals"])


class BuildRunRetryAgentTimeoutTest(unittest.TestCase):
    """build_run must surface parameters.retry_agent_timeout into the GCS-uploaded summary.json."""

    GENERATED_AT = "2026-06-25T00:00:00Z"

    def _metadata(self, retry_value):
        return {
            "benchmark": "terminal-bench-2",
            "coding_agent": "kimchi",
            "model": "kimchi-dev/kimi-k2.6",
            "configuration": "single-model",
            "parameters": {"retry_agent_timeout": retry_value},
            "gitlab": {"pipeline_id": "42", "target_commit_sha": "deadbeef"},
            "gcs": {"run_id": "gitlab-p42"},
        }

    def test_retry_agent_timeout_true_propagates(self) -> None:
        run = summarize_results.build_run(self._metadata(True), None, None, self.GENERATED_AT)
        self.assertIs(run["retry_agent_timeout"], True)

    def test_retry_agent_timeout_false_propagates(self) -> None:
        run = summarize_results.build_run(self._metadata(False), None, None, self.GENERATED_AT)
        self.assertIs(run["retry_agent_timeout"], False)

    def test_retry_agent_timeout_accepts_string_true(self) -> None:
        # YAML may surface the input as "true"/"false" strings; helper must coerce.
        run = summarize_results.build_run(self._metadata("true"), None, None, self.GENERATED_AT)
        self.assertIs(run["retry_agent_timeout"], True)

    def test_retry_agent_timeout_falls_back_to_env_when_missing(self) -> None:
        metadata = self._metadata(0)  # non-bool, non-string: default kicks in
        run = summarize_results.build_run(metadata, None, None, self.GENERATED_AT)
        # Falls back to should_retry_agent_timeout() — default True when env unset.
        self.assertIsInstance(run["retry_agent_timeout"], bool)


SCHEMA_PATH = Path(__file__).resolve().parents[3] / "schemas" / "benchmark-summary-v2.schema.json"


class SummarySchemaValidationTest(unittest.TestCase):
    def test_summary_validates_against_v2_schema(self):
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
                "configuration": "single-model",
                "results_dir": str(results_dir),
                "gitlab": {
                    "target_ref": "main",
                    "target_commit_sha": "deadbeef",
                },
                "gcs": {"run_id": "gitlab-p42"},
                "parameters": {"selected_tasks": ["sample-task"]},
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()):
                summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)

            summary = json.loads(output_path.read_text(encoding="utf-8"))
            schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
            try:
                validate(instance=summary, schema=schema)
            except ValidationError as exc:
                self.fail(f"summary.json does not validate against v2 schema: {exc.message} at {list(exc.path)}")


class BuildRunLLMParametersTest(unittest.TestCase):
    """build_run must surface LLM sampling parameters into the summary's run.parameters."""

    GENERATED_AT = "2026-06-26T00:00:00Z"

    def test_build_run_includes_llm_parameters(self) -> None:
        metadata = {
            "benchmark": "terminal-bench-2",
            "coding_agent": "kimchi",
            "model": "kimchi-dev/kimi-k2.6",
            "configuration": "multi-mode",
            "parameters": {
                "llm_params": {"temperature": 0.7},
                "llm_per_model_params": {"kimchi-dev/kimi-k2.6": {"max_tokens": 8192}},
                "thinking_level": "high",
            },
            "gitlab": {"ref": "benchmarks", "commit_sha": "abc123"},
        }
        run = summarize_results.build_run(
            metadata,
            "2026-06-26T00:00:00Z",
            "2026-06-26T01:00:00Z",
            "2026-06-26T01:00:00Z",
        )
        self.assertEqual(run["parameters"]["llm_params"], {"temperature": 0.7})
        self.assertEqual(run["parameters"]["llm_per_model_params"], {"kimchi-dev/kimi-k2.6": {"max_tokens": 8192}})
        self.assertEqual(run["parameters"]["thinking_level"], "high")

    def test_build_run_defaults_llm_parameters_to_empty(self) -> None:
        metadata = {
            "benchmark": "terminal-bench-2",
            "coding_agent": "kimchi",
            "model": "kimchi-dev/kimi-k2.6",
            "configuration": "single-model",
            "parameters": {},
            "gitlab": {"ref": "benchmarks", "commit_sha": "abc123"},
        }
        run = summarize_results.build_run(metadata, None, None, self.GENERATED_AT)
        self.assertEqual(run["parameters"]["llm_params"], {})
        self.assertEqual(run["parameters"]["llm_per_model_params"], {})
        self.assertIsNone(run["parameters"]["thinking_level"])

    def test_build_run_llm_params_with_decimal_values_are_json_serializable(self) -> None:
        """Reproduce CI failure: metadata loaded with parse_float=Decimal.

        When run-metadata.json contains llm_params with float values like
        temperature and top_p, load_json() (which uses parse_float=Decimal)
        produces Decimal objects.  build_run must convert them to native
        floats so json.dumps(summary) does not raise TypeError.
        """
        metadata = {
            "benchmark": "terminal-bench-2",
            "coding_agent": "kimchi",
            "model": "kimchi-dev/glm-5.2-fp8",
            "configuration": "multi-mode",
            "parameters": {
                "llm_params": {
                    "temperature": Decimal("0.7"),
                    "top_p": Decimal("0.95"),
                    "max_tokens": 4096,
                },
                "llm_per_model_params": {
                    "kimchi-dev/glm-5.2-fp8": {"temperature": Decimal("0.8")}
                },
            },
            "gitlab": {"ref": "benchmarks", "commit_sha": "abc123"},
        }
        run = summarize_results.build_run(
            metadata, "2026-06-26T00:00:00Z", "2026-06-26T01:00:00Z", self.GENERATED_AT
        )
        # Must not raise TypeError: Object of type Decimal is not JSON serializable
        serialized = json.dumps(run)
        deserialized = json.loads(serialized)
        self.assertEqual(deserialized["parameters"]["llm_params"]["temperature"], 0.7)
        self.assertEqual(deserialized["parameters"]["llm_params"]["top_p"], 0.95)
        self.assertEqual(
            deserialized["parameters"]["llm_per_model_params"]["kimchi-dev/glm-5.2-fp8"]["temperature"],
            0.8,
        )


class ScanSessionFileTokenDedupTest(unittest.TestCase):
    """Claude Code splits a single API response into two JSONL entries
    (e.g. a thinking block followed by a tool_use block) that carry identical
    usage objects. scan_session_file must not double-count these duplicates.
    """

    def _write_session(self, path: Path, entries: list[dict]) -> None:
        sessions_dir = path / "agent" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        with open(sessions_dir / "main.jsonl", "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry) + "\n")

    def _assistant_entry(
        self,
        usage: dict,
        content: list | None = None,
        model: str = "anthropic/claude-sonnet-5",
    ) -> dict:
        return {
            "type": "assistant",
            "uuid": f"{id(usage)}-{id(content)}",
            "timestamp": "2026-07-29T12:00:00Z",
            "message": {
                "role": "assistant",
                "model": model,
                "usage": usage,
                "content": content or [],
            },
        }

    def test_dedupes_consecutive_identical_usage_from_claude_code(self):
        """Two assistant entries with identical usage (thinking + tool_use split)
        should count tokens once but accumulate tool calls from both entries.
        """
        with tempfile.TemporaryDirectory() as tmp:
            trial_dir = Path(tmp) / "task__abc"
            trial_dir.mkdir()
            usage = {
                "input_tokens": 2610,
                "cache_read_input_tokens": 987029,
                "cache_creation_input_tokens": 52256,
                "output_tokens": 35723,
            }
            self._write_session(trial_dir, [
                self._assistant_entry(usage, [{"type": "thinking", "thinking": "..."}]),
                self._assistant_entry(usage, [{
                    "type": "toolCall",
                    "name": "bash",
                }]),
                self._assistant_entry(
                    {**usage, "input_tokens": 3000, "output_tokens": 500},
                    [{"type": "toolCall", "name": "read"}],
                ),
            ])

            warnings: list[str] = []
            scan = summarize_results.scan_session_file(
                trial_dir / "agent" / "sessions" / "main.jsonl", warnings
            )
            self.assertEqual(warnings, [])
            # 3 assistant entries but only 2 have distinct usage → 2 rounds
            stats = next(iter(scan.models.values()))
            self.assertEqual(stats.llm_rounds, 2)
            self.assertEqual(stats.input_tokens, 2610 + 3000)
            self.assertEqual(stats.cache_read_tokens, 987029 + 987029)
            self.assertEqual(stats.cache_write_tokens, 52256 + 52256)
            self.assertEqual(stats.output_tokens, 35723 + 500)
            # Tool calls from ALL entries (including duplicates) are counted
            self.assertEqual(stats.tool_calls["bash"], 1)
            self.assertEqual(stats.tool_calls["read"], 1)

    def test_does_not_dedupe_kimchi_incremental_usage(self):
        """Kimchi writes one entry per API call with incremental usage.
        No deduplication should occur when usage values differ.
        """
        with tempfile.TemporaryDirectory() as tmp:
            trial_dir = Path(tmp) / "task__abc"
            trial_dir.mkdir()
            self._write_session(trial_dir, [
                self._assistant_entry({
                    "input": 12, "cacheRead": 14336, "cacheWrite": 0, "output": 154,
                }),
                self._assistant_entry({
                    "input": 235, "cacheRead": 14336, "cacheWrite": 0, "output": 81,
                }),
                self._assistant_entry({
                    "input": 614, "cacheRead": 14336, "cacheWrite": 0, "output": 100,
                }),
            ])

            warnings: list[str] = []
            scan = summarize_results.scan_session_file(
                trial_dir / "agent" / "sessions" / "main.jsonl", warnings
            )
            self.assertEqual(warnings, [])
            stats = next(iter(scan.models.values()))
            self.assertEqual(stats.llm_rounds, 3)
            self.assertEqual(stats.input_tokens, 12 + 235 + 614)
            self.assertEqual(stats.cache_read_tokens, 14336 * 3)
            self.assertEqual(stats.output_tokens, 154 + 81 + 100)

    def test_dedupes_across_model_boundary(self):
        """Dedup state is per-model: a duplicate after a model_change still
        counts if a different model's entry appeared in between.
        """
        with tempfile.TemporaryDirectory() as tmp:
            trial_dir = Path(tmp) / "task__abc"
            trial_dir.mkdir()
            usage_a = {
                "input_tokens": 100,
                "cache_read_input_tokens": 500,
                "cache_creation_input_tokens": 50,
                "output_tokens": 10,
            }
            usage_b = {
                "input_tokens": 200,
                "cache_read_input_tokens": 1000,
                "cache_creation_input_tokens": 100,
                "output_tokens": 20,
            }
            self._write_session(trial_dir, [
                self._assistant_entry(
                    usage_a, [{"type": "thinking", "thinking": "..."}], model="anthropic/claude-sonnet-5"
                ),
                self._assistant_entry(
                    usage_a, [{"type": "toolCall", "name": "bash"}], model="anthropic/claude-sonnet-5"
                ),
                self._assistant_entry(
                    usage_b, [{"type": "text", "text": "..."}], model="kimchi-dev/glm-5.2-fp8"
                ),
                self._assistant_entry(usage_b, [{"type": "toolCall", "name": "read"}], model="kimchi-dev/glm-5.2-fp8"),
            ])

            warnings: list[str] = []
            scan = summarize_results.scan_session_file(
                trial_dir / "agent" / "sessions" / "main.jsonl", warnings
            )
            self.assertEqual(warnings, [])
            self.assertEqual(len(scan.models), 2)
            sonnet_stats = scan.models[("anthropic", "claude-sonnet-5")]
            glm_stats = scan.models[("kimchi-dev", "glm-5.2-fp8")]
            self.assertEqual(sonnet_stats.llm_rounds, 1)
            self.assertEqual(sonnet_stats.input_tokens, 100)
            self.assertEqual(glm_stats.llm_rounds, 1)
            self.assertEqual(glm_stats.input_tokens, 200)


if __name__ == "__main__":
    unittest.main()
