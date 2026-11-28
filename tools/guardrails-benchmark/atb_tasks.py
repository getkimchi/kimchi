"""AgentThreatBench tasks with only their generation loop replaced by Kimchi."""

from inspect_ai import Task, task

from inspect_evals.agent_threat_bench.agent_threat_bench import (
    agent_threat_bench_autonomy_hijack,
    agent_threat_bench_data_exfil,
    agent_threat_bench_memory_poison,
)
from kimchi_solver import kimchi


def _use_kimchi(original: Task) -> Task:
    # The upstream tasks end in generate(tool_calls="loop"). Preserve their
    # dataset, public system prompt, tool setup, limits, version and scorer.
    original.solver = [*original.solver[:-1], kimchi()]
    return original


@task
def agent_threat_bench_memory_poison_kimchi() -> Task:
    return _use_kimchi(agent_threat_bench_memory_poison())


@task
def agent_threat_bench_autonomy_hijack_kimchi() -> Task:
    return _use_kimchi(agent_threat_bench_autonomy_hijack())


@task
def agent_threat_bench_data_exfil_kimchi() -> Task:
    return _use_kimchi(agent_threat_bench_data_exfil())
