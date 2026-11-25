import copy
import tempfile
import unittest
from pathlib import Path

from report import generate_reports, render_step_summary


CONTEXT = {
    "commit_sha": "0123456789abcdef0123456789abcdef01234567",
    "harness_version": "1.2.3",
    "inspect_ai": "0.3.277",
    "inspect_evals": "0.24.1.dev17+geb5383efe",
    "inspect_evals_revision": "eb5383efecd8ac6d23fd276757b811f3db05a1f5",
    "agentharm_dataset_revision": "e23b3fe60a0da9037314b88e5ee3a0c054970dad",
}


def fixture_run(route="baseline", label="kimi-k3"):
    return {
        "schema_version": 1,
        "route": route,
        "label": label,
        "model_id": label,
        "context": copy.deepcopy(CONTEXT),
        "run_config": {
            "epochs": 1,
            "max_connections": 8,
            "message_limit": 20,
            "harness_invocation": "dist/bin/kimchi --print via Inspect sandbox_agent_bridge",
            "split": "test_public",
            "refusal_judge": "glm-5.3-flash",
            "semantic_judge": "kimi-k3",
            "grader_route": "baseline",
        },
        "suites": {
            "agent_threat_bench": {
                "status": "complete",
                "expected_samples": 24,
                "total_samples": 24,
                "completed_samples": 24,
                "error_count": 0,
                "metrics": {"utility": 0.875, "security": 0.916667},
                "tasks": [
                    {
                        "name": "memory_poison",
                        "status": "complete",
                        "expected_samples": 10,
                        "total_samples": 10,
                        "completed_samples": 10,
                        "error_count": 0,
                        "metrics": {
                            "utility": 1.0,
                            "utility_stderr": 0.0,
                            "security": 1.0,
                            "security_stderr": 0.0,
                        },
                    },
                    {
                        "name": "autonomy_hijack",
                        "status": "complete",
                        "expected_samples": 6,
                        "total_samples": 6,
                        "completed_samples": 6,
                        "error_count": 0,
                        "metrics": {
                            "utility": 0.833333,
                            "utility_stderr": 0.166667,
                            "security": 0.833333,
                            "security_stderr": 0.166667,
                        },
                    },
                    {
                        "name": "data_exfil",
                        "status": "complete",
                        "expected_samples": 8,
                        "total_samples": 8,
                        "completed_samples": 8,
                        "error_count": 0,
                        "metrics": {
                            "utility": 0.75,
                            "utility_stderr": 0.125,
                            "security": 0.875,
                            "security_stderr": 0.125,
                        },
                    },
                ],
            },
            "agentharm": {
                "status": "complete",
                "expected_samples": 176,
                "total_samples": 176,
                "completed_samples": 176,
                "error_count": 0,
                "metrics": {
                    "avg_score": 0.19504255,
                    "avg_full_score": 0.13068182,
                    "avg_refusals": 0.76704545,
                    "avg_score_non_refusals": 0.75301974,
                },
                "categories": [
                    {"name": "Cybercrime", "sample_count": 28, "avg_score": 0.0785714, "avg_refusals": 0.85},
                    {"name": "Fraud", "sample_count": 24, "avg_score": 0.1666667, "avg_refusals": 0.7916667},
                ],
            },
        },
    }


class MarkdownReportTests(unittest.TestCase):
    def test_reports_include_every_selected_model_suite_and_metadata_without_raw_content(self):
        baseline = fixture_run("baseline", "kimi-k3")
        guarded = fixture_run("guarded", "kimi-k3")
        baseline_deepseek = fixture_run("baseline", "deepseek-v4.1-flash-1017")
        guarded_deepseek = fixture_run("guarded", "deepseek-v4.1-flash-1017")
        guarded["suites"]["agentharm"]["metrics"]["avg_score"] = 0.1
        baseline["raw_transcript"] = "RAW PRIVATE TRANSCRIPT"
        baseline["api_key"] = "DO-NOT-PRINT-KEY"

        with tempfile.TemporaryDirectory() as temporary:
            summary = Path(temporary) / "summary.md"
            failures = generate_reports(
                [baseline, guarded, baseline_deepseek, guarded_deepseek],
                selection="both",
                out_dir=Path(temporary) / "reports",
                step_summary_path=summary,
            )
            baseline_text = (Path(temporary) / "reports" / "baseline.md").read_text()
            guarded_text = (Path(temporary) / "reports" / "guarded.md").read_text()
            summary_text = summary.read_text()

        self.assertEqual(failures, [])
        self.assertIn("# Guardrails benchmark — baseline", baseline_text)
        self.assertIn("# Guardrails benchmark — guarded", guarded_text)
        for text in (baseline_text, guarded_text):
            self.assertIn("kimi-k3", text)
            self.assertIn("deepseek-v4.1-flash-1017", text)
            self.assertIn("AgentThreatBench", text)
            self.assertIn("AgentHarm", text)
            self.assertIn("24/24", text)
            self.assertIn("176/176", text)
            self.assertIn(CONTEXT["commit_sha"], text)
            self.assertIn(CONTEXT["inspect_evals_revision"], text)
            self.assertIn("Cybercrime", text)
            self.assertNotIn("RAW PRIVATE TRANSCRIPT", text)
            self.assertNotIn("DO-NOT-PRINT-KEY", text)
        self.assertIn("0.195", baseline_text)
        self.assertIn("0.100", guarded_text)
        self.assertIn("Baseline", summary_text)
        self.assertIn("Guarded", summary_text)
        self.assertIn("−0.095", summary_text)

    def test_missing_and_incomplete_runs_are_explicit_and_fail_validation(self):
        complete = fixture_run("baseline", "kimi-k3")
        incomplete = fixture_run("guarded", "kimi-k3")
        incomplete["suites"]["agentharm"].update(
            {"status": "incomplete", "completed_samples": 100, "error_count": 2}
        )

        with tempfile.TemporaryDirectory() as temporary:
            failures = generate_reports(
                [complete, incomplete],
                selection="both",
                out_dir=Path(temporary),
                step_summary_path=None,
            )
            guarded_text = (Path(temporary) / "guarded.md").read_text()
            summary_text = render_step_summary(
                [complete, incomplete], selection="both"
            )

        self.assertTrue(failures)
        self.assertIn("INCOMPLETE", guarded_text)
        self.assertIn("MISSING", guarded_text)
        self.assertIn("Errors: 2", guarded_text)
        self.assertIn("100/176", guarded_text)
        self.assertIn("INCOMPLETE", summary_text)
        self.assertIn("MISSING", summary_text)


if __name__ == "__main__":
    unittest.main()
