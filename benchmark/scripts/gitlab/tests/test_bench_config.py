"""Unit tests for bench_config — retry policy helpers and LLM params."""

from __future__ import annotations

import pytest

from bench_config import (
    DEFAULT_WORKFLOW_EXTENSION,
    env_bool,
    is_kimchi_family,
    is_multi_model,
    is_retryable,
    is_workflow_agent,
    load_chunk_attempt_budget,
    load_docker_health_config,
    load_llm_params,
    parse_model,
    resolve_chunk_attempt_budget,
    resolve_thinking_level,
    validate_llm_params_for_model,
    validate_thinking_level_for_model,
)
from outcome import Outcome


def _clear_docker_health_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "DOCKER_HOST",
        "BENCH_DOCKER_HEALTH_MONITOR",
        "BENCH_DOCKER_HEALTH_POLL_SECONDS",
        "BENCH_DOCKER_HEALTH_CONFIRM_FAILURES",
        "BENCH_DOCKER_HEALTH_PROBE_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)


def test_docker_health_monitor_defaults_from_remote_daemon(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_docker_health_env(monkeypatch)

    assert load_docker_health_config().enabled is False

    monkeypatch.setenv("DOCKER_HOST", "tcp://docker:2375")
    config = load_docker_health_config()
    assert config.enabled is True
    assert config.poll_seconds == 5.0
    assert config.confirm_failures == 3
    assert config.probe_timeout_seconds == 5.0


def test_docker_health_monitor_loads_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_docker_health_env(monkeypatch)
    monkeypatch.setenv("BENCH_DOCKER_HEALTH_MONITOR", "yes")
    monkeypatch.setenv("BENCH_DOCKER_HEALTH_POLL_SECONDS", "0.25")
    monkeypatch.setenv("BENCH_DOCKER_HEALTH_CONFIRM_FAILURES", "4")
    monkeypatch.setenv("BENCH_DOCKER_HEALTH_PROBE_TIMEOUT_SECONDS", "1.5")

    config = load_docker_health_config()

    assert config.enabled is True
    assert config.poll_seconds == 0.25
    assert config.confirm_failures == 4
    assert config.probe_timeout_seconds == 1.5


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("BENCH_DOCKER_HEALTH_POLL_SECONDS", "soon", "not a valid number"),
        ("BENCH_DOCKER_HEALTH_CONFIRM_FAILURES", "many", "not a valid integer"),
        ("BENCH_DOCKER_HEALTH_PROBE_TIMEOUT_SECONDS", "later", "not a valid number"),
    ],
)
def test_docker_health_monitor_rejects_invalid_numbers(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
    message: str,
) -> None:
    _clear_docker_health_env(monkeypatch)
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        load_docker_health_config()


def test_concrete_model_is_the_default_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MODEL", raising=False)

    assert is_multi_model() is False
    assert parse_model() == ("kimchi-dev", "minimax-m3")


def test_explicit_multi_model_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODEL", "multi-model")

    assert is_multi_model() is True
    assert parse_model() == ("kimchi", "multi-model")


@pytest.mark.parametrize(
    ("outcome", "error_category", "error_subcategory", "env_value", "expected"),
    [
        # Agent timeouts: follow the env flag (default is false)
        (Outcome.AGENT_TIMEOUT, None,    None,                       None,    False),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "true",  True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "false", False),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "1",     True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "yes",   True),
        (Outcome.AGENT_TIMEOUT, None,    None,                       "0",     False),
        # Infra errors: retryable regardless of the flag, except terminal infra causes.
        (Outcome.ERROR,         "infra", None,                       "false", True),
        (Outcome.ERROR,         "infra", "kimchi_infra_exit",        "true",  True),
        (Outcome.ERROR,         "infra", "api_key_budget_exceeded",  "true",  False),
        (Outcome.ERROR,         "infra", "api_key_budget_exceeded",  "false", False),
        # Moonshot account suspension: retryable — interim until the account is recharged.
        (Outcome.ERROR,         "infra", "moonshot_quota_exceeded",  "true",  True),
        (Outcome.ERROR,         "infra", "moonshot_quota_exceeded",  "false", True),
        # Quality / other errors: never retryable
        (Outcome.ERROR,         "quality", None,                     "true",  False),
        (Outcome.ERROR,         None,      None,                     "true",  False),
        # Pass / scored-fail: never retryable
        (Outcome.SCORED_PASS,   None,    None,                       "true",  False),
        (Outcome.SCORED_FAIL,   None,    None,                       "true",  False),
    ],
)
def test_is_retryable(
    outcome: Outcome,
    error_category: str | None,
    error_subcategory: str | None,
    env_value: str,
    expected: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if env_value is None:
        monkeypatch.delenv("BENCH_RETRY_AGENT_TIMEOUT", raising=False)
    else:
        monkeypatch.setenv("BENCH_RETRY_AGENT_TIMEOUT", env_value)
    assert is_retryable(outcome, error_category, error_subcategory) is expected


# ---------------------------------------------------------------------------
# LLM sampling parameter loading — individual typed env vars
# ---------------------------------------------------------------------------

def _clear_llm_env(monkeypatch):
    for var in ("BENCH_LLM_TEMPERATURE", "BENCH_LLM_TOP_P", "BENCH_LLM_TOP_K", "BENCH_LLM_MAX_TOKENS"):
        monkeypatch.delenv(var, raising=False)


def test_load_llm_params_all_unset(monkeypatch):
    _clear_llm_env(monkeypatch)
    global_params, per_model = load_llm_params()
    assert global_params == {}
    assert per_model == {}


def test_load_llm_params_all_zero_sentinel(monkeypatch):
    """Zero is the 'not set' sentinel from the CI form default=0."""
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "0")
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0")
    monkeypatch.setenv("BENCH_LLM_TOP_K", "0")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "0")
    global_params, per_model = load_llm_params()
    assert global_params == {}
    assert per_model == {}


def test_load_llm_params_temperature(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "1.0")
    global_params, _ = load_llm_params()
    assert global_params == {"temperature": 1.0}


def test_load_llm_params_top_p(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0.95")
    global_params, _ = load_llm_params()
    assert global_params == {"top_p": 0.95}


def test_load_llm_params_top_k(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40")
    global_params, _ = load_llm_params()
    assert global_params == {"top_k": 40}


def test_load_llm_params_max_tokens(monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096")
    global_params, _ = load_llm_params()
    assert global_params == {"max_tokens": 4096}


def test_load_llm_params_all_set(monkeypatch):
    monkeypatch.setenv("BENCH_LLM_TEMPERATURE", "1.0")
    monkeypatch.setenv("BENCH_LLM_TOP_P", "0.95")
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096")
    global_params, per_model = load_llm_params()
    assert global_params == {"temperature": 1.0, "top_p": 0.95, "top_k": 40, "max_tokens": 4096}
    assert per_model == {}


@pytest.mark.parametrize(
    ("params", "parameter", "required_value"),
    [
        ({"temperature": 0.7}, "temperature", "1.0"),
        ({"top_p": 0.9}, "top_p", "0.95"),
    ],
)
def test_moonshot_models_reject_incompatible_sampling_params(params, parameter, required_value):
    with pytest.raises(
        ValueError,
        match=rf"moonshotai/.*{parameter}.*{required_value}",
    ):
        validate_llm_params_for_model("moonshotai/kimi-k3", params)


def test_moonshot_models_accept_published_fixed_sampling_params():
    validate_llm_params_for_model(
        "moonshotai/kimi-k2.7-code",
        {"temperature": 1.0, "top_p": 0.95},
    )


def test_non_moonshot_models_keep_generic_sampling_params():
    validate_llm_params_for_model(
        "kimchi-dev/kimi-k2.7",
        {"temperature": 0.7, "top_p": 0.9},
    )


def test_load_llm_params_gitlab_number_trailing_zero(monkeypatch):
    """GitLab number inputs may arrive as '40.0' for integers."""
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv("BENCH_LLM_TOP_K", "40.0")
    monkeypatch.setenv("BENCH_LLM_MAX_TOKENS", "4096.0")
    global_params, _ = load_llm_params()
    assert global_params == {"top_k": 40, "max_tokens": 4096}


@pytest.mark.parametrize(
    ("env_var", "value", "expected_substring"),
    [
        ("BENCH_LLM_TEMPERATURE", "1.5",   "out of range"),
        ("BENCH_LLM_TEMPERATURE", "-0.1",  "out of range"),
        ("BENCH_LLM_TEMPERATURE", "hot",   "not a valid number"),
        ("BENCH_LLM_TOP_P",       "1.01",  "out of range"),
        ("BENCH_LLM_TOP_P",       "bad",   "not a valid number"),
        ("BENCH_LLM_TOP_K",       "-1",    "positive integer"),
        ("BENCH_LLM_TOP_K",       "abc",   "not a valid integer"),
        ("BENCH_LLM_MAX_TOKENS",  "-100",  "positive integer"),
        ("BENCH_LLM_MAX_TOKENS",  "x",     "not a valid integer"),
    ],
)
def test_load_llm_params_invalid(env_var, value, expected_substring, monkeypatch):
    _clear_llm_env(monkeypatch)
    monkeypatch.setenv(env_var, value)
    with pytest.raises(ValueError, match=expected_substring):
        load_llm_params()


@pytest.mark.parametrize(
    "coding_agent,kimchi_family,workflow_agent",
    [
        ("kimchi", True, False),
        ("kimchi-workflow", True, True),
        # Runs the same extension and workflows, but on stock pi — takes the
        # workflow kwargs and none of kimchi's (no llm-params, no compaction).
        ("pi-workflow", False, True),
        ("pi", False, False),
        ("opencode", False, False),
        ("claude-code", False, False),
        # near-misses must not be mistaken for the workflow agent
        ("kimchi-workflows", False, False),
        ("pi-workflows", False, False),
        ("workflow", False, False),
    ],
)
def test_agent_family_classification(
    coding_agent: str, kimchi_family: bool, workflow_agent: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODING_AGENT", coding_agent)

    assert is_kimchi_family() is kimchi_family
    assert is_workflow_agent() is workflow_agent
    # the explicit argument takes precedence over the environment
    assert is_kimchi_family(coding_agent) is kimchi_family
    assert is_workflow_agent(coding_agent) is workflow_agent


def test_agent_family_defaults_to_kimchi_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CODING_AGENT", raising=False)

    assert is_kimchi_family() is True
    assert is_workflow_agent() is False


def test_default_workflow_extension_names_a_version_or_dist_tag() -> None:
    """A bare package name resolves through npm's `*` range, which excludes
    prereleases — and every published engine version is one, so a bare default
    fails at agent setup with ETARGET rather than at pipeline configuration."""
    spec = DEFAULT_WORKFLOW_EXTENSION.removeprefix("npm:")
    # Scoped name, so the version separator is the "@" after the scope's "/".
    assert spec.startswith("@")
    assert spec.find("@", spec.index("/")) != -1, f"{DEFAULT_WORKFLOW_EXTENSION} must carry @<version-or-tag>"


# ---------------------------------------------------------------------------
# Thinking level resolution
# ---------------------------------------------------------------------------


def _clear_thinking_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("THINKING_LEVEL", raising=False)
    monkeypatch.delenv("CODING_AGENT", raising=False)


@pytest.mark.parametrize("level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
def test_resolve_thinking_level_fixed_levels(level: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Each valid level returns itself for a kimchi-family agent."""
    monkeypatch.setenv("THINKING_LEVEL", level)
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    assert resolve_thinking_level() == level


@pytest.mark.parametrize("level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"])
def test_resolve_thinking_level_pi_agent(level: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """The pi agent also accepts --thinking."""
    monkeypatch.setenv("THINKING_LEVEL", level)
    monkeypatch.setenv("CODING_AGENT", "pi")
    assert resolve_thinking_level() == level


def test_resolve_thinking_level_default_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """'default' means the harness chooses dynamically — no --thinking flag."""
    _clear_thinking_env(monkeypatch)
    assert resolve_thinking_level() is None


def test_resolve_thinking_level_explicit_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THINKING_LEVEL", "default")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    assert resolve_thinking_level() is None


def test_resolve_thinking_level_empty_string(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty THINKING_LEVEL (e.g. cleared CI input field) falls back to default."""
    monkeypatch.setenv("THINKING_LEVEL", "")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    assert resolve_thinking_level() is None


def test_resolve_thinking_level_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THINKING_LEVEL", "HIGH")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    assert resolve_thinking_level() == "high"


def test_resolve_thinking_level_invalid_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THINKING_LEVEL", "turbo")
    monkeypatch.setenv("CODING_AGENT", "kimchi")
    with pytest.raises(ValueError, match="turbo"):
        resolve_thinking_level()


def test_resolve_thinking_level_opencode_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """opencode wraps an external tool that does not use pi-ai thinking levels."""
    monkeypatch.setenv("THINKING_LEVEL", "high")
    monkeypatch.setenv("CODING_AGENT", "opencode")
    assert resolve_thinking_level() is None


@pytest.mark.parametrize("level", ["low", "medium", "high", "xhigh", "max"])
def test_resolve_thinking_level_claude_code_maps_to_effort(
    level: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """claude-code spells the same scale as Claude Code's --effort."""
    monkeypatch.setenv("THINKING_LEVEL", level)
    monkeypatch.setenv("CODING_AGENT", "claude-code")
    assert resolve_thinking_level() == level


@pytest.mark.parametrize("level", ["off", "minimal"])
def test_resolve_thinking_level_claude_code_rejects_inexpressible_levels(
    level: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Claude Code cannot disable thinking; rounding up would misreport the run."""
    monkeypatch.setenv("THINKING_LEVEL", level)
    monkeypatch.setenv("CODING_AGENT", "claude-code")
    with pytest.raises(ValueError, match="no equivalent"):
        resolve_thinking_level()


def test_resolve_thinking_level_claude_code_default_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("THINKING_LEVEL", "default")
    monkeypatch.setenv("CODING_AGENT", "claude-code")
    assert resolve_thinking_level() is None


def test_resolve_thinking_level_workflow_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Workflow agents subclass Kimchi/PiKimchi and inherit --thinking support."""
    monkeypatch.setenv("THINKING_LEVEL", "high")
    monkeypatch.setenv("CODING_AGENT", "kimchi-workflow")
    assert resolve_thinking_level() == "high"


def test_resolve_thinking_level_pi_workflow_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("THINKING_LEVEL", "high")
    monkeypatch.setenv("CODING_AGENT", "pi-workflow")
    assert resolve_thinking_level() == "high"


def test_resolve_thinking_level_explicit_agent_arg(monkeypatch: pytest.MonkeyPatch) -> None:
    """The explicit coding_agent arg takes precedence over the env var."""
    monkeypatch.setenv("THINKING_LEVEL", "high")
    monkeypatch.setenv("CODING_AGENT", "opencode")
    assert resolve_thinking_level(coding_agent="kimchi") == "high"
    assert resolve_thinking_level(coding_agent="opencode") is None


# ---------------------------------------------------------------------------
# Durable chunk attempt budget (1a)
# ---------------------------------------------------------------------------


def test_load_chunk_attempt_budget_defaults_to_eight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_CHUNK_ATTEMPT_BUDGET", raising=False)
    assert load_chunk_attempt_budget() == 8


def test_load_chunk_attempt_budget_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "12")
    assert load_chunk_attempt_budget() == 12


def test_load_chunk_attempt_budget_rejects_non_integer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "soon")
    with pytest.raises(ValueError, match="not a valid integer"):
        load_chunk_attempt_budget()


@pytest.mark.parametrize("raw", ["0", "-3"])
def test_load_chunk_attempt_budget_rejects_non_positive(
    raw: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", raw)
    with pytest.raises(ValueError, match="positive integer"):
        load_chunk_attempt_budget()


def test_resolve_chunk_attempt_budget_uses_env_without_frozen_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Brand-new / non-checkpointed local runs take the environment/default."""
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "4")
    assert resolve_chunk_attempt_budget(None) == 4


def test_resolve_chunk_attempt_budget_frozen_wins_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_CHUNK_ATTEMPT_BUDGET", raising=False)
    assert resolve_chunk_attempt_budget(6) == 6


def test_resolve_chunk_attempt_budget_frozen_wins_when_env_matches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "6")
    assert resolve_chunk_attempt_budget(6) == 6


def test_resolve_chunk_attempt_budget_rejects_changed_job_local_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A later job must not reinterpret a changed job-local value."""
    monkeypatch.setenv("BENCH_CHUNK_ATTEMPT_BUDGET", "5")
    with pytest.raises(ValueError, match="run identity mismatch"):
        resolve_chunk_attempt_budget(8)


@pytest.mark.parametrize("frozen", [0, -1, 2.5, "8", True, False])
def test_resolve_chunk_attempt_budget_rejects_invalid_frozen_value(
    frozen: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("BENCH_CHUNK_ATTEMPT_BUDGET", raising=False)
    with pytest.raises(ValueError, match="positive integer"):
        resolve_chunk_attempt_budget(frozen)


@pytest.mark.parametrize("level", ["low", "high", "max"])
def test_moonshot_k3_accepts_supported_thinking_levels(level: str) -> None:
    validate_thinking_level_for_model("moonshotai/kimi-k3", level)


@pytest.mark.parametrize("level", ["off", "minimal", "medium", "xhigh"])
def test_moonshot_k3_rejects_unsupported_thinking_levels(level: str) -> None:
    with pytest.raises(
        ValueError,
        match=rf"'{level}' is not supported by MODEL=moonshotai/kimi-k3.*high, low, max",
    ):
        validate_thinking_level_for_model("moonshotai/kimi-k3", level)


@pytest.mark.parametrize(
    "level", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
)
def test_moonshot_k2_7_code_rejects_every_thinking_level(level: str) -> None:
    with pytest.raises(ValueError, match="thinking cannot be configured"):
        validate_thinking_level_for_model("moonshotai/kimi-k2.7-code", level)


def test_thinking_level_validation_noop_cases() -> None:
    # No level requested.
    validate_thinking_level_for_model("moonshotai/kimi-k3", None)
    validate_thinking_level_for_model("moonshotai/kimi-k2.7-code", None)
    # Non-moonshot models.
    validate_thinking_level_for_model("kimchi-dev/kimi-k2.6", "medium")
    validate_thinking_level_for_model("openrouter/moonshotai/kimi-k3", "medium")
    # Unknown moonshotai ids pass here; the adapter's static table rejects
    # them at launch.
    validate_thinking_level_for_model("moonshotai/kimi-k9", "medium")


def test_env_bool_parses_truthy_forms(monkeypatch: pytest.MonkeyPatch) -> None:
    for raw in ("true", "TRUE", " 1 ", "yes"):
        monkeypatch.setenv("BENCH_TEST_FLAG", raw)
        assert env_bool("BENCH_TEST_FLAG") is True


def test_env_bool_parses_explicit_falsy_forms(monkeypatch: pytest.MonkeyPatch) -> None:
    # An explicit false must win over a true default.
    for raw in ("false", "FALSE", "0", "no"):
        monkeypatch.setenv("BENCH_TEST_FLAG", raw)
        assert env_bool("BENCH_TEST_FLAG") is False
        assert env_bool("BENCH_TEST_FLAG", True) is False


def test_env_bool_unset_or_unrecognised_returns_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BENCH_TEST_FLAG", raising=False)
    assert env_bool("BENCH_TEST_FLAG") is False
    assert env_bool("BENCH_TEST_FLAG", True) is True

    monkeypatch.setenv("BENCH_TEST_FLAG", "garbage")
    assert env_bool("BENCH_TEST_FLAG", True) is True
