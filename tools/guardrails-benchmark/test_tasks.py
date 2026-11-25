import unittest
from types import SimpleNamespace as NS
from unittest.mock import patch

import agentharm_task
import atb_tasks


class TaskWiringTests(unittest.TestCase):
    def test_agentharm_replaces_only_the_flattened_generation_step(self):
        original = NS(solver=["setup", "system", "prompt", "choice", "generate"], scorer="stock-scorer")
        with (
            patch.object(agentharm_task, "stock_agentharm", return_value=original) as stock,
            patch.object(agentharm_task, "kimchi", return_value="kimchi-solver"),
        ):
            result = agentharm_task.agentharm_kimchi(
                split="test_public",
                refusal_judge="openai-api/baseline/glm-5.3-flash",
                semantic_judge="openai-api/baseline/kimi-k3",
            )

        self.assertEqual(
            result.solver,
            ["setup", "system", "prompt", "choice", "kimchi-solver"],
        )
        self.assertEqual(result.scorer, "stock-scorer")
        stock.assert_called_once_with(
            agent="default",
            split="test_public",
            refusal_judge="openai-api/baseline/glm-5.3-flash",
            semantic_judge="openai-api/baseline/kimi-k3",
        )

    def test_atb_replaces_only_generation_and_preserves_the_rest(self):
        original = NS(solver=["system", "tools", "generate"], scorer="stock-scorer")
        with patch.object(atb_tasks, "kimchi", return_value="kimchi-solver"):
            result = atb_tasks._use_kimchi(original)

        self.assertEqual(result.solver, ["system", "tools", "kimchi-solver"])
        self.assertEqual(result.scorer, "stock-scorer")


if __name__ == "__main__":
    unittest.main()
