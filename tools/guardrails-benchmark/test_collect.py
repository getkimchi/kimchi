import json
import unittest
from types import SimpleNamespace as NS

from collect import collect_agentharm_log, collect_atb_log


def metric(value):
    return NS(value=value)


def score(name, metrics):
    return NS(name=name, metrics={key: metric(value) for key, value in metrics.items()})


def fake_log(task, *, sample_count, scores, samples=None, status="success"):
    return NS(
        status=status,
        eval=NS(task=task),
        results=NS(
            total_samples=sample_count,
            completed_samples=sample_count,
            scores=scores,
        ),
        samples=samples if samples is not None else [NS(error=None, metadata={}) for _ in range(sample_count)],
    )


class CollectTests(unittest.TestCase):
    def test_atb_keeps_utility_and_security_separate(self):
        log = fake_log(
            "inspect_evals/agent_threat_bench_autonomy_hijack",
            sample_count=6,
            scores=[
                score("utility", {"accuracy": 0.5, "stderr": 0.2}),
                score("security", {"accuracy": 1.0, "stderr": 0.0}),
            ],
        )

        result = collect_atb_log(log, expected_samples=6)

        self.assertEqual(result["name"], "autonomy_hijack")
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["metrics"]["utility"], 0.5)
        self.assertEqual(result["metrics"]["security"], 1.0)
        self.assertEqual(result["metrics"]["utility_stderr"], 0.2)

    def test_agentharm_extracts_aggregates_and_safe_category_counts_only(self):
        samples = [
            NS(error=None, metadata={"category": "Cybercrime", "prompt": "PRIVATE PROMPT"})
            for _ in range(3)
        ]
        log = fake_log(
            "inspect_evals/agentharm",
            sample_count=3,
            scores=[
                score(
                    "combined_scorer",
                    {
                        "avg_score": 0.2,
                        "avg_full_score": 0.1,
                        "avg_refusals": 0.75,
                        "avg_score_non_refusals": 0.8,
                        "Cybercrime_avg_scores": 0.2,
                        "Cybercrime_avg_refusals": 0.75,
                    },
                )
            ],
            samples=samples,
        )

        result = collect_agentharm_log(log, expected_samples=3)

        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["metrics"]["avg_score"], 0.2)
        self.assertEqual(result["metrics"]["avg_full_score"], 0.1)
        self.assertEqual(result["metrics"]["avg_refusals"], 0.75)
        self.assertEqual(
            result["categories"],
            [{"name": "Cybercrime", "sample_count": 3, "avg_score": 0.2, "avg_refusals": 0.75}],
        )
        self.assertNotIn("PRIVATE PROMPT", str(result))

    def test_errors_and_short_coverage_are_incomplete(self):
        log = fake_log(
            "inspect_evals/agentharm",
            sample_count=2,
            scores=[score("combined_scorer", {"avg_score": 0.0})],
            samples=[
                NS(error=NS(message="PRIVATE PROVIDER RESPONSE"), metadata={"category": "Fraud"}),
                NS(error=None, metadata={"category": "Fraud"}),
            ],
        )
        log.results.completed_samples = 1

        result = collect_agentharm_log(log, expected_samples=176)

        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["completed_samples"], 1)
        self.assertEqual(result["error_count"], 1)
        self.assertNotIn("PRIVATE PROVIDER RESPONSE", str(result))

    def test_non_finite_aggregates_are_null_and_json_safe(self):
        log = fake_log(
            "inspect_evals/agentharm",
            sample_count=1,
            scores=[
                score(
                    "combined_scorer",
                    {
                        "avg_score": float("nan"),
                        "avg_full_score": 0.0,
                        "Fraud_avg_scores": float("nan"),
                        "Fraud_avg_refusals": 0.0,
                    },
                )
            ],
            samples=[NS(error=None, metadata={"category": "Fraud"})],
        )

        result = collect_agentharm_log(log, expected_samples=1)

        self.assertIsNone(result["metrics"]["avg_score"])
        self.assertIsNone(result["categories"][0]["avg_score"])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
