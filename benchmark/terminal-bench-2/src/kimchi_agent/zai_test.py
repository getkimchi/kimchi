"""Tests for the static Z.AI provider configuration."""

import pytest

from kimchi_agent import zai


def test_is_zai_model_detects_prefixed_names() -> None:
    assert zai.is_zai_model("zai/glm-5.2") is True
    assert zai.is_zai_model("zai/glm-4.6") is True
    assert zai.is_zai_model("openrouter/z-ai/glm-5.2") is False
    assert zai.is_zai_model("kimchi-dev/glm-5.2-fp8") is False
    assert zai.is_zai_model(None) is False
    assert zai.is_zai_model("") is False


def test_split_zai_model_extracts_id() -> None:
    assert zai.split_zai_model("zai/glm-5.2") == "glm-5.2"
    with pytest.raises(ValueError, match="must include a model id"):
        zai.split_zai_model("zai/")
    with pytest.raises(ValueError, match="expected a zai/ model"):
        zai.split_zai_model("moonshotai/kimi-k3")
    with pytest.raises(ValueError, match="provider/model format"):
        zai.split_zai_model(None)


@pytest.mark.parametrize(
    ("override", "expected"),
    [
        (None, "https://api.z.ai/api/paas/v4"),
        ("", "https://api.z.ai/api/paas/v4"),
        ("  ", "https://api.z.ai/api/paas/v4"),
        (" https://zai.example.test/v4/ ", "https://zai.example.test/v4"),
    ],
)
def test_resolve_zai_endpoint(override: str | None, expected: str) -> None:
    assert zai.resolve_zai_endpoint(override) == expected


@pytest.mark.parametrize(
    ("override", "expected"),
    [
        (None, "https://api.z.ai/api/anthropic"),
        ("", "https://api.z.ai/api/anthropic"),
        (" https://zai.example.test/anthropic/ ", "https://zai.example.test/anthropic"),
    ],
)
def test_resolve_zai_anthropic_base_url(override: str | None, expected: str) -> None:
    assert zai.resolve_zai_anthropic_base_url(override) == expected


def test_unknown_model_raises_with_known_ids() -> None:
    with pytest.raises(ValueError, match="not in the static metadata table"):
        zai.build_models_config("glm-4.5")
    with pytest.raises(ValueError, match=r"glm-5\.2"):
        zai.zai_model("missing")


def test_build_models_config_shape() -> None:
    config = zai.build_models_config("glm-5.2")

    provider = config["providers"]["zai"]
    assert provider["api"] == "openai-completions"
    assert provider["baseUrl"] == "https://api.z.ai/api/paas/v4"
    assert provider["authHeader"] is True
    # Placeholder only — the real key must never land in artifacts.
    assert provider["apiKey"] == "$ZAI_API_KEY"

    model = provider["models"][0]
    assert model["id"] == "glm-5.2"
    assert model["name"] == "GLM-5.2"
    assert model["reasoning"] is True
    assert model["input"] == ["text"]
    assert model["contextWindow"] == 1_000_000
    assert model["maxTokens"] == 131_072
    assert model["provider"] == "zai"
    assert model["compat"] == {"supportsReasoningEffort": True}
    # Only high and max reach the model distinctly; clamped levels are nulled.
    assert model["thinkingLevelMap"] == {
        "minimal": None,
        "low": None,
        "medium": None,
        "high": "high",
        "xhigh": None,
        "max": "max",
    }


def test_build_models_config_can_omit_api_key() -> None:
    config = zai.build_models_config("glm-5.2", include_api_key=False)
    assert "apiKey" not in config["providers"]["zai"]


def test_build_models_config_uses_endpoint_override() -> None:
    config = zai.build_models_config("glm-5.2", endpoint=" https://zai.example.test/v4/ ")
    assert config["providers"]["zai"]["baseUrl"] == "https://zai.example.test/v4"


def test_supported_thinking_levels_are_off_high_max() -> None:
    model = zai.zai_model("glm-5.2")
    assert model.supported_thinking_levels == ("off", "high", "max")


@pytest.mark.parametrize("level", ["high", "max", "off", None])
def test_thinking_level_accepted(level: str | None) -> None:
    config = zai.build_models_config("glm-5.2", thinking_level=level)
    assert config["providers"]["zai"]["models"][0]["id"] == "glm-5.2"


@pytest.mark.parametrize("level", ["minimal", "low", "medium", "xhigh"])
def test_thinking_level_pi_would_clamp_is_rejected(level: str) -> None:
    with pytest.raises(ValueError, match="silently clamp"):
        zai.build_models_config("glm-5.2", thinking_level=level)


def test_glm_5_3_config_shape() -> None:
    config = zai.build_models_config("glm-5.3")

    model = config["providers"]["zai"]["models"][0]
    assert model["id"] == "glm-5.3"
    assert model["name"] == "GLM-5.3"
    assert model["reasoning"] is True
    assert model["input"] == ["text"]
    assert model["contextWindow"] == 1_000_000
    assert model["maxTokens"] == 131_072
    assert model["provider"] == "zai"
    assert model["compat"] == {"supportsReasoningEffort": True}
    # low, high, and max reach the model distinctly; the rest are nulled.
    assert model["thinkingLevelMap"] == {
        "minimal": None,
        "low": "low",
        "medium": None,
        "high": "high",
        "xhigh": None,
        "max": "max",
    }


def test_glm_5_3_supported_thinking_levels() -> None:
    # GLM-5.3 cannot disable reasoning, so "off" is not offered.
    model = zai.zai_model("glm-5.3")
    assert model.supported_thinking_levels == ("low", "high", "max")


@pytest.mark.parametrize("level", ["low", "high", "max", None])
def test_glm_5_3_thinking_level_accepted(level: str | None) -> None:
    config = zai.build_models_config("glm-5.3", thinking_level=level)
    assert config["providers"]["zai"]["models"][0]["id"] == "glm-5.3"


@pytest.mark.parametrize("level", ["minimal", "medium", "xhigh", "off"])
def test_glm_5_3_thinking_level_pi_would_clamp_is_rejected(level: str) -> None:
    with pytest.raises(ValueError, match="silently clamp"):
        zai.build_models_config("glm-5.3", thinking_level=level)
