"""Tests for the moonshotai/* static metadata and models.json generation."""

import pytest

from kimchi_agent.moonshot import (
    MOONSHOT_ANTHROPIC_BASE_URL,
    MOONSHOT_API_KEY_ENV,
    MOONSHOT_BASE_URL,
    MOONSHOT_PROVIDER,
    MoonshotModel,
    build_models_config,
    is_moonshot_model,
    moonshot_metadata,
    split_moonshot_model,
)


def _synthetic_model(**overrides: object) -> MoonshotModel:
    """A MoonshotModel with filler metadata, for states no catalogued model hits."""
    fields = {
        "id": "test-model",
        "display_name": "Test Model",
        "context_window": 128_000,
        "max_output_tokens": 8_192,
        "max_tokens_field": "max_tokens",
        "thinking_format": "openai",
        "cost_input": 1.0,
        "cost_output": 2.0,
        "anthropic_model_id": "test-model",
    }
    fields.update(overrides)
    return MoonshotModel(**fields)


def test_is_moonshot_model_detects_prefixed_names() -> None:
    assert is_moonshot_model("moonshotai/kimi-k3") is True
    assert is_moonshot_model("moonshotai/kimi-k2.7-code") is True
    assert is_moonshot_model("openrouter/moonshotai/kimi-k3") is False
    assert is_moonshot_model("kimchi-dev/kimi-k3") is False
    assert is_moonshot_model("multi-model") is False
    assert is_moonshot_model(None) is False
    assert is_moonshot_model("") is False


def test_split_moonshot_model_extracts_id() -> None:
    assert split_moonshot_model("moonshotai/kimi-k3") == "kimi-k3"
    with pytest.raises(ValueError, match="must include a model id"):
        split_moonshot_model("moonshotai/")
    with pytest.raises(ValueError, match="expected a moonshotai/ model"):
        split_moonshot_model("anthropic/claude-sonnet-5")
    with pytest.raises(ValueError, match="provider/model format"):
        split_moonshot_model(None)


def test_moonshot_metadata_rejects_unknown_models() -> None:
    with pytest.raises(ValueError, match=r"'kimi-k9'.*Known models: kimi-k2\.7-code, kimi-k3"):
        moonshot_metadata("kimi-k9")


def test_k2_7_code_metadata_matches_published_limits_and_pricing() -> None:
    model = moonshot_metadata("kimi-k2.7-code")
    assert model.context_window == 262_144
    assert model.max_output_tokens == 32_768
    assert model.cost_input == pytest.approx(0.95)
    assert model.cost_output == pytest.approx(4.0)
    assert model.cost_cache_read == pytest.approx(0.19)
    assert model.supported_efforts == ()
    assert model.thinking_required is True
    assert model.anthropic_model_id == "kimi-k2.7-code"


def test_k3_metadata_matches_published_limits_and_pricing() -> None:
    model = moonshot_metadata("kimi-k3")
    assert model.context_window == 1_048_576
    assert model.cost_input == pytest.approx(3.0)
    assert model.cost_output == pytest.approx(15.0)
    assert model.cost_cache_read == pytest.approx(0.30)
    assert model.supported_efforts == ("low", "high", "max")
    # Claude Code selects K3's 1M window via the [1m] suffix.
    assert model.anthropic_model_id == "kimi-k3[1m]"


def test_k3_models_config_maps_pi_thinking_levels_to_efforts() -> None:
    config = build_models_config("kimi-k3")

    provider = config["providers"][MOONSHOT_PROVIDER]
    assert provider["api"] == "openai-completions"
    assert provider["baseUrl"] == MOONSHOT_BASE_URL
    assert provider["authHeader"] is True
    assert provider["apiKey"] == f"${MOONSHOT_API_KEY_ENV}"

    (entry,) = provider["models"]
    assert entry["id"] == "kimi-k3"
    assert entry["provider"] == MOONSHOT_PROVIDER
    assert entry["contextWindow"] == 1_048_576
    assert entry["reasoning"] is True
    assert entry["compat"]["supportsReasoningEffort"] is True
    assert entry["compat"]["maxTokensField"] == "max_completion_tokens"
    # K3 accepts top-level reasoning_effort, but not K2's thinking object.
    assert entry["compat"]["thinkingFormat"] == "openai"
    assert entry["thinkingLevelMap"] == {
        "off": None,
        "minimal": None,
        "low": "low",
        "medium": None,
        "high": "high",
        "xhigh": None,
        "max": "max",
    }


def test_k2_7_code_models_config_sends_no_reasoning_effort() -> None:
    config = build_models_config("kimi-k2.7-code")

    (entry,) = config["providers"][MOONSHOT_PROVIDER]["models"]
    assert entry["id"] == "kimi-k2.7-code"
    assert entry["compat"]["supportsReasoningEffort"] is False
    assert entry["compat"]["maxTokensField"] == "max_tokens"
    assert entry["compat"]["thinkingFormat"] == "deepseek"
    assert entry["maxTokens"] == 32_768
    # Thinking is mandatory: every level is null so pi rejects disabling or
    # configuring it.
    assert all(value is None for value in entry["thinkingLevelMap"].values())


def test_models_config_can_omit_api_key_from_artifacts() -> None:
    config = build_models_config("kimi-k3", include_api_key=False)
    assert "apiKey" not in config["providers"][MOONSHOT_PROVIDER]


def test_build_models_config_validates_thinking_level() -> None:
    # K3 accepts exactly its published efforts.
    for level in ("low", "high", "max"):
        build_models_config("kimi-k3", thinking_level=level)
    for level in ("off", "minimal", "medium", "xhigh"):
        with pytest.raises(ValueError, match=rf"thinking level '{level}'.+Supported: low, high, max"):
            build_models_config("kimi-k3", thinking_level=level)

    # K2.7 Code has no configurable thinking at all.
    with pytest.raises(ValueError, match="thinking cannot be configured"):
        build_models_config("kimi-k2.7-code", thinking_level="high")
    with pytest.raises(ValueError, match="thinking cannot be configured"):
        build_models_config("kimi-k2.7-code", thinking_level="off")

    # No level is always fine.
    build_models_config("kimi-k3", thinking_level=None)
    build_models_config("kimi-k2.7-code", thinking_level=None)


def test_supported_thinking_levels_mirror_pi_validation() -> None:
    assert moonshot_metadata("kimi-k3").supported_thinking_levels == ("low", "high", "max")
    assert moonshot_metadata("kimi-k2.7-code").supported_thinking_levels == ()


def test_optional_thinking_without_efforts_uses_pi_default_handling() -> None:
    model = _synthetic_model(thinking_required=False, supported_efforts=())

    # No map: pi's default handling allows off, passes non-opt-in levels
    # through, and caps opt-in levels — exactly what is advertised.
    assert model.thinking_level_map is None
    assert model.supported_thinking_levels == ("off", "minimal", "low", "medium", "high")
    assert "thinkingLevelMap" not in model.to_pi_config()


def test_optional_thinking_with_efforts_maps_only_supported_levels() -> None:
    model = _synthetic_model(thinking_required=False, supported_efforts=("low", "high"))

    # off is absent (pi reads that as "thinking can be disabled"); every
    # non-effort level is nulled so pi rejects it.
    expected_map = {
        "minimal": None,
        "low": "low",
        "medium": None,
        "high": "high",
        "xhigh": None,
        "max": None,
    }
    assert model.thinking_level_map == expected_map
    assert model.supported_thinking_levels == ("off", "low", "high")
    assert model.to_pi_config()["thinkingLevelMap"] == expected_map


def test_anthropic_base_url_constant_targets_anthropic_surface() -> None:
    # Claude Code appends /v1/messages to ANTHROPIC_BASE_URL itself.
    assert MOONSHOT_ANTHROPIC_BASE_URL == "https://api.moonshot.ai/anthropic"
