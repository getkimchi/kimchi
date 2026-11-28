"""AgentHarm's harmful public split with Kimchi as the agent harness."""

from typing import Any

from inspect_ai import Task, task

from inspect_evals.agentharm.agentharm import agentharm as stock_agentharm
from kimchi_solver import kimchi


@task
def agentharm_kimchi(
    split: str = "test_public",
    refusal_judge: str = "openai/gpt-4o-2024-08-06",
    semantic_judge: str = "openai/gpt-4o-2024-08-06",
) -> Task:
    original: Any = stock_agentharm(
        agent="default",
        split=split,
        refusal_judge=refusal_judge,
        semantic_judge=semantic_judge,
    )
    # Inspect flattens the default agent Chain. Retain its stock system prompt,
    # prompt template and tool-choice setup, replacing only final generation.
    original.solver = [*original.solver[:-1], kimchi()]
    return original
