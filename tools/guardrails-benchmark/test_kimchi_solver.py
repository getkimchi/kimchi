import os
import unittest
from unittest.mock import patch

from kimchi_solver import (
    build_kimchi_command,
    build_mcp_config,
    build_models_config,
    kimchi,
    scrubbed_environment,
)


class KimchiCommandTests(unittest.TestCase):
    def test_invokes_the_built_binary_headlessly_with_benchmark_tools_only(self):
        command = build_kimchi_command(
            binary="/work/dist/bin/kimchi",
            mcp_config="/tmp/sample/mcp.json",
            system_prompt="Use only the supplied tools.",
        )

        self.assertEqual(command[0], "/work/dist/bin/kimchi")
        self.assertIn("--print", command)
        self.assertIn("--no-session", command)
        self.assertIn("--no-builtin-tools", command)
        self.assertIn("--mcp-config", command)
        self.assertEqual(
            command[command.index("--mcp-config") + 1],
            "/tmp/sample/mcp.json",
        )
        self.assertIn("--model", command)
        self.assertEqual(command[command.index("--model") + 1], "inspect/inspect")
        self.assertNotIn("KIMCHI_API_KEY", command)
        self.assertNotIn("BASELINE_API_KEY", command)
        self.assertNotIn("GUARDED_API_KEY", command)

    def test_bridge_provider_uses_local_inspect_proxy_not_a_real_key(self):
        config = build_models_config(port=18181)

        provider = config["providers"]["inspect"]
        self.assertEqual(provider["baseUrl"], "http://localhost:18181/v1")
        self.assertEqual(provider["apiKey"], "inspect")
        self.assertEqual(provider["models"][0]["id"], "inspect")
        self.assertNotIn("kimi-k3", str(config))
        self.assertNotIn("deepseek", str(config))

    def test_mcp_tools_keep_the_stock_benchmark_names(self):
        config = build_mcp_config(port=18181)

        server = config["mcpServers"]["benchmark"]
        self.assertEqual(server["url"], "http://localhost:18181/mcp/benchmark")
        self.assertTrue(server["directTools"])
        self.assertEqual(server["toolPrefix"], "none")

    def test_real_provider_keys_are_blank_in_the_kimchi_subprocess(self):
        env = scrubbed_environment(
            home="/tmp/sample/home",
            package_dir="/work/dist/share/kimchi",
        )

        for name in (
            "KIMCHI_API_KEY",
            "BASELINE_API_KEY",
            "GUARDED_API_KEY",
            "GUARDRAILS_BENCHMARK_BASELINE_API_KEY",
            "GUARDRAILS_BENCHMARK_GUARDED_API_KEY",
        ):
            self.assertIn(name, env)
            self.assertEqual(env[name], "")
        self.assertEqual(env["HOME"], "/tmp/sample/home")
        self.assertEqual(env["PI_PACKAGE_DIR"], "/work/dist/share/kimchi")

    def test_accepts_a_binary_path_that_exists_only_inside_the_sandbox(self):
        with patch.dict(os.environ, {"KIMCHI_BENCH_BINARY": "/opt/kimchi/bin/kimchi"}, clear=False):
            sandbox_solver = kimchi()

        self.assertTrue(callable(sandbox_solver))


if __name__ == "__main__":
    unittest.main()
