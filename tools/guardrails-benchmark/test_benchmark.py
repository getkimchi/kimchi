import unittest

from benchmark import (
    INSPECT_EVALS_REVISION,
    INSPECT_VERSION,
    build_inspect_command,
    build_matrix,
    provider_config,
    select_models,
)


class ModelSelectionTests(unittest.TestCase):
    def test_selects_each_model_and_both_in_declared_order(self):
        self.assertEqual(select_models("kimi-k3"), ["kimi-k3"])
        self.assertEqual(
            select_models("deepseek-v4.1-flash-1017"),
            ["deepseek-v4.1-flash-1017"],
        )
        self.assertEqual(
            select_models("both"),
            ["kimi-k3", "deepseek-v4.1-flash-1017"],
        )

    def test_rejects_unknown_model(self):
        with self.assertRaisesRegex(ValueError, "unknown model selection"):
            select_models("latest")

    def test_matrix_runs_each_route_independently_for_each_model(self):
        self.assertEqual(
            build_matrix("kimi-k3"),
            [
                {"label": "kimi-k3", "model_id": "kimi-k3", "route": "baseline"},
                {"label": "kimi-k3", "model_id": "kimi-k3", "route": "guarded"},
            ],
        )
        both = build_matrix("both")
        self.assertEqual(len(both), 4)
        self.assertEqual(
            {(entry["label"], entry["route"]) for entry in both},
            {
                ("kimi-k3", "baseline"),
                ("kimi-k3", "guarded"),
                ("deepseek-v4.1-flash-1017", "baseline"),
                ("deepseek-v4.1-flash-1017", "guarded"),
            },
        )


class ProviderSeparationTests(unittest.TestCase):
    def test_guarded_target_never_changes_the_unguarded_graders(self):
        config = provider_config("guarded", "kimi-k3")

        self.assertEqual(config["target_model"], "openai-api/guarded/kimi-k3")
        self.assertEqual(config["target_api_key_env"], "GUARDED_API_KEY")
        self.assertEqual(config["target_base_url_env"], "GUARDED_BASE_URL")
        self.assertEqual(config["refusal_judge"], "openai-api/baseline/glm-5.3-flash")
        self.assertEqual(config["semantic_judge"], "openai-api/baseline/kimi-k3")
        self.assertEqual(config["judge_api_key_env"], "BASELINE_API_KEY")

    def test_baseline_target_and_graders_share_only_the_baseline_route(self):
        config = provider_config("baseline", "deepseek-v4.1-flash-1017")

        self.assertEqual(
            config["target_model"],
            "openai-api/baseline/deepseek-v4.1-flash-1017",
        )
        self.assertEqual(config["target_api_key_env"], "BASELINE_API_KEY")
        self.assertEqual(config["judge_api_key_env"], "BASELINE_API_KEY")

    def test_inspect_arguments_never_contain_credentials(self):
        config = provider_config("guarded", "kimi-k3")
        secrets = {
            "GUARDED_API_KEY": "guarded-secret-value",
            "BASELINE_API_KEY": "baseline-secret-value",
        }
        command = build_inspect_command(
            suite="agentharm",
            task_file="tools/guardrails-benchmark/agentharm_task.py",
            provider=config,
            log_dir="/tmp/agentharm-logs",
        )

        joined = " ".join(command)
        self.assertIn("openai-api/guarded/kimi-k3", command)
        self.assertIn("semantic_judge=openai-api/baseline/kimi-k3", command)
        self.assertIn("refusal_judge=openai-api/baseline/glm-5.3-flash", command)
        self.assertIn("split=test_public", command)
        for secret in secrets.values():
            self.assertNotIn(secret, joined)
        self.assertNotIn("--api-key", joined)

    def test_benchmark_versions_and_full_coverage_flags_are_pinned(self):
        config = provider_config("baseline", "kimi-k3")
        atb = build_inspect_command(
            suite="agent_threat_bench",
            task_file="tools/guardrails-benchmark/atb_tasks.py",
            provider=config,
            log_dir="/tmp/atb-logs",
        )

        self.assertEqual(INSPECT_VERSION, "0.3.277")
        self.assertEqual(
            INSPECT_EVALS_REVISION,
            "eb5383efecd8ac6d23fd276757b811f3db05a1f5",
        )
        for command in (
            atb,
            build_inspect_command(
                suite="agentharm",
                task_file="tools/guardrails-benchmark/agentharm_task.py",
                provider=config,
                log_dir="/tmp/agentharm-logs",
            ),
        ):
            self.assertIn("--epochs", command)
            self.assertEqual(command[command.index("--epochs") + 1], "1")
            self.assertIn("--max-connections", command)
            self.assertEqual(command[command.index("--max-connections") + 1], "8")
            self.assertIn("--message-limit", command)
            self.assertEqual(command[command.index("--message-limit") + 1], "20")


if __name__ == "__main__":
    unittest.main()
