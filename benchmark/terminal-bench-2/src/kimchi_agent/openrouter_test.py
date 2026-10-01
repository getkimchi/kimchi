import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from tenacity import wait_none

from kimchi_agent import openrouter
from kimchi_agent.openrouter import ModelLimits, OpenRouterClient, OpenRouterModel


def _models(*entries: dict) -> AsyncMock:
    """Stub the raw /models payload the client parses."""
    return AsyncMock(return_value={"data": list(entries)})


def _preset_body(model: str, only: list[str] | None = None) -> dict:
    config: dict = {"model": model}
    if only is not None:
        config["provider"] = {"only": only, "allow_fallbacks": False}
    return {"data": {"designated_version": {"config": config}}}


def _stub_get(monkeypatch: pytest.MonkeyPatch, routes: dict[str, object]) -> list[str]:
    """Route client GETs by path prefix, recording the paths requested."""
    requested: list[str] = []

    async def fake_get(self, path: str, *, authed: bool = False) -> object:
        requested.append(path)
        for prefix, payload in routes.items():
            if path.startswith(prefix):
                return payload
        raise AssertionError(f"unexpected path {path!r}")

    monkeypatch.setattr(OpenRouterClient, "_get", fake_get)
    return requested


def test_split_openrouter_model_extracts_id() -> None:
    assert openrouter.split_openrouter_model("openrouter/z-ai/glm-5.2") == "z-ai/glm-5.2"
    assert openrouter.split_openrouter_model("openrouter/@preset/glm-5-2-zai") == "@preset/glm-5-2-zai"
    with pytest.raises(ValueError, match="must include a model id"):
        openrouter.split_openrouter_model("openrouter/")
    with pytest.raises(ValueError, match="expected a openrouter/ model"):
        openrouter.split_openrouter_model("zai/glm-5.2")
    with pytest.raises(ValueError, match="provider/model format"):
        openrouter.split_openrouter_model(None)


async def test_build_models_config_maps_live_metadata_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        OpenRouterClient,
        "_fetch_models",
        AsyncMock(
            return_value=(
                OpenRouterModel.model_validate(
                    {
                        "id": "z-ai/glm-5.2",
                        "name": "Z.ai: GLM 5.2",
                        "reasoning": {
                            "mandatory": False,
                            "default_enabled": True,
                            "supported_efforts": ["xhigh", "high"],
                        },
                        "supported_parameters": ["reasoning", "reasoning_effort", "tools"],
                        "architecture": {"input_modalities": ["text"]},
                        "context_length": 1_048_576,
                        "top_provider": {"max_completion_tokens": 128_000},
                        "pricing": {
                            "prompt": "0.0000006993",
                            "completion": "0.0000021978",
                            "input_cache_read": "0.00000012987",
                        },
                    }
                ),
            )
        ),
    )

    config = await OpenRouterClient().build_models_config("z-ai/glm-5.2")

    assert config["providers"]["openrouter"] == {
        "api": "openai-completions",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "$OPENROUTER_API_KEY",
        "authHeader": True,
        "models": [
            {
                "id": "z-ai/glm-5.2",
                "name": "Z.ai: GLM 5.2",
                "reasoning": True,
                "input": ["text"],
                "contextWindow": 1_048_576,
                "maxTokens": 128_000,
                "cost": {
                    "input": 0.6993,
                    "output": 2.1978,
                    "cacheRead": 0.12987,
                    "cacheWrite": 0,
                },
                "provider": "openrouter",
                "compat": {"supportsReasoningEffort": True},
                # pi gates xhigh/max on the key existing, and reads null as
                # "unsupported" — so the levels OpenRouter omits are nulled.
                "thinkingLevelMap": {
                    "minimal": None,
                    "low": None,
                    "medium": None,
                    "high": "high",
                    "xhigh": "xhigh",
                    "max": None,
                },
            }
        ],
    }


async def test_discovery_is_shared_by_concurrent_trials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Trials run concurrently in one process and must not each fetch /models."""
    get = _models({"id": "z-ai/glm-5.2"}, {"id": "anthropic/claude-opus-5-fast"})
    monkeypatch.setattr(OpenRouterClient, "_get", get)

    first, second = await asyncio.gather(
        OpenRouterClient().build_models_config("z-ai/glm-5.2"),
        OpenRouterClient().build_models_config("anthropic/claude-opus-5-fast"),
    )

    assert first["providers"]["openrouter"]["models"][0]["id"] == "z-ai/glm-5.2"
    assert (
        second["providers"]["openrouter"]["models"][0]["id"] == "anthropic/claude-opus-5-fast"
    )
    get.assert_awaited_once()


async def test_endpoint_override_is_used_for_discovery_and_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(OpenRouterClient, "_get", _models({"id": "vendor/model"}))

    client = OpenRouterClient(endpoint=" https://router.example.test/v1/ ")
    config = await client.build_models_config("vendor/model")

    assert client.endpoint == "https://router.example.test/v1"
    assert (
        config["providers"]["openrouter"]["baseUrl"] == "https://router.example.test/v1"
    )


async def test_unknown_model_fails_before_launch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(OpenRouterClient, "_get", _models({"id": "some/other-model"}))

    with pytest.raises(ValueError, match="missing/model"):
        await OpenRouterClient().build_models_config("missing/model")


async def test_retryable_statuses_are_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx.Request("GET", "https://openrouter.ai/api/v1/models")
    responses = [
        httpx.Response(503, request=request),
        httpx.Response(200, request=request, json={"data": [{"id": "vendor/model"}]}),
    ]

    class FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, _url: str, headers=None) -> httpx.Response:
            return responses.pop(0)

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", lambda **_kwargs: FakeAsyncClient())
    monkeypatch.setattr(OpenRouterClient._get.retry, "wait", wait_none())

    models = await OpenRouterClient().models()

    assert [model.id for model in models] == ["vendor/model"]
    assert responses == []


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        (None, "https://openrouter.ai/api"),
        ("  https://openrouter.ai/api/v1/  ", "https://openrouter.ai/api"),
        ("https://router.example.test/v1", "https://router.example.test"),
    ],
)
def test_anthropic_base_url_stops_before_the_version_segment(
    endpoint: str | None, expected: str
) -> None:
    # Claude Code appends /v1/messages to ANTHROPIC_BASE_URL.
    assert openrouter.resolve_openrouter_anthropic_base_url(endpoint) == expected


def test_model_limits_fall_back_when_metadata_omits_them() -> None:
    model = OpenRouterModel.model_validate(
        {
            "id": "vendor/model",
            "context_length": 200_000,
            "top_provider": {"max_completion_tokens": 64_000},
        }
    )
    assert model.limits == ModelLimits(context_window=200_000, max_output_tokens=64_000)

    bare = OpenRouterModel.model_validate({"id": "vendor/model"})
    assert bare.limits == ModelLimits(
        context_window=openrouter.DEFAULT_CONTEXT_WINDOW,
        max_output_tokens=openrouter.DEFAULT_MAX_TOKENS,
    )


async def test_model_lookup_rejects_ids_openrouter_does_not_offer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        OpenRouterClient, "_get", _models({"id": "z-ai/glm-5.1", "context_length": 200_000})
    )
    client = OpenRouterClient()

    assert (await client.model("z-ai/glm-5.1")).limits.context_window == 200_000

    with pytest.raises(ValueError, match="missing/model"):
        await client.model("missing/model")


async def test_preset_resolves_to_the_model_and_pins_it_declares(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = _stub_get(
        monkeypatch, {"presets/": _preset_body("z-ai/glm-5.1", only=["z-ai"])}
    )

    selection = await OpenRouterClient(api_key="sk-or-test").resolve("@preset/glm-5-1-zai")

    assert selection.requested_id == "@preset/glm-5-1-zai"
    assert selection.catalogue_id == "z-ai/glm-5.1"
    assert selection.pinned_providers == ("z-ai",)
    assert selection.is_pinned
    assert requested == ["presets/glm-5-1-zai"]


async def test_preset_without_provider_pins_is_not_pinned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_get(monkeypatch, {"presets/": _preset_body("z-ai/glm-5.2")})

    selection = await OpenRouterClient(api_key="sk-or-test").resolve("@preset/glm-5-2-zai")

    assert selection.pinned_providers == ()
    assert not selection.is_pinned


async def test_variant_suffix_resolves_to_the_base_model() -> None:
    client = OpenRouterClient(api_key="sk-or-test")

    assert (await client.resolve("z-ai/glm-5.1:exacto")).catalogue_id == "z-ai/glm-5.1"
    assert (await client.resolve("z-ai/glm-5.1")).catalogue_id == "z-ai/glm-5.1"


async def test_preset_without_a_pinned_model_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _stub_get(monkeypatch, {"presets/": {"data": {"designated_version": {"config": {}}}}})

    with pytest.raises(RuntimeError, match="does not pin a single model"):
        await OpenRouterClient(api_key="sk-or-test").resolve("@preset/broken")


async def test_preset_without_an_api_key_is_rejected() -> None:
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY is required"):
        await OpenRouterClient().resolve("@preset/glm-5-2-zai")


async def test_models_config_keeps_the_preset_id_but_takes_limits_from_the_wrapped_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sending the wrapped model id instead of the preset would drop provider pinning."""
    _stub_get(
        monkeypatch,
        {
            "presets/": _preset_body("z-ai/glm-5.2"),
            "models": {
                "data": [
                    {
                        "id": "z-ai/glm-5.2",
                        "name": "Z.ai: GLM 5.2",
                        "context_length": 1_048_576,
                        "top_provider": {"max_completion_tokens": 131_072},
                    }
                ]
            },
        },
    )

    config = await OpenRouterClient(api_key="sk-or-test").build_models_config(
        "@preset/glm-5-2-zai"
    )

    model = config["providers"]["openrouter"]["models"][0]
    assert model["id"] == "@preset/glm-5-2-zai"
    assert model["contextWindow"] == 1_048_576
    assert model["maxTokens"] == 131_072


async def test_model_without_published_efforts_declares_no_thinking_level_map(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An absent map means "pi decides"; an empty one would cap the model at high."""
    monkeypatch.setattr(
        OpenRouterClient,
        "_get",
        _models({"id": "z-ai/glm-5.1", "reasoning": {"default_enabled": True}}),
    )

    config = await OpenRouterClient().build_models_config("z-ai/glm-5.1")

    assert "thinkingLevelMap" not in config["providers"]["openrouter"]["models"][0]


async def test_unsupported_thinking_level_fails_before_launch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """pi would clamp max to high and record only the clamped value."""
    monkeypatch.setattr(
        OpenRouterClient,
        "_get",
        _models(
            {"id": "z-ai/glm-5.2", "reasoning": {"supported_efforts": ["xhigh", "high"]}}
        ),
    )

    with pytest.raises(ValueError, match="Supported: off, high, xhigh"):
        await OpenRouterClient().build_models_config("z-ai/glm-5.2", thinking_level="max")


async def test_supported_thinking_level_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        OpenRouterClient,
        "_get",
        _models(
            {"id": "z-ai/glm-5.2", "reasoning": {"supported_efforts": ["xhigh", "high"]}}
        ),
    )

    config = await OpenRouterClient().build_models_config(
        "z-ai/glm-5.2", thinking_level="xhigh"
    )

    assert config["providers"]["openrouter"]["models"][0]["id"] == "z-ai/glm-5.2"


async def test_unmapped_model_still_rejects_levels_pi_would_clamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No published efforts means no map, and pi caps an unmapped model at high."""
    monkeypatch.setattr(OpenRouterClient, "_get", _models({"id": "z-ai/glm-5.1"}))

    with pytest.raises(ValueError, match="off, minimal, low, medium, high"):
        await OpenRouterClient().build_models_config("z-ai/glm-5.1", thinking_level="max")


async def test_unmapped_model_accepts_levels_pi_supports_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(OpenRouterClient, "_get", _models({"id": "z-ai/glm-5.1"}))

    config = await OpenRouterClient().build_models_config(
        "z-ai/glm-5.1", thinking_level="high"
    )

    assert config["providers"]["openrouter"]["models"][0]["id"] == "z-ai/glm-5.1"


def test_supported_thinking_levels_mirrors_pi_gating() -> None:
    unmapped = OpenRouterModel.model_validate({"id": "vendor/model"})
    assert unmapped.supported_thinking_levels == (
        "off",
        "minimal",
        "low",
        "medium",
        "high",
    )

    mapped = OpenRouterModel.model_validate(
        {"id": "vendor/model", "reasoning": {"supported_efforts": ["xhigh", "high"]}}
    )
    assert mapped.supported_thinking_levels == ("off", "high", "xhigh")


async def test_pinned_preset_takes_limits_from_the_endpoint_it_pins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """top_provider describes a different endpoint than the one the preset pins."""
    _stub_get(
        monkeypatch,
        {
            "presets/": _preset_body("z-ai/glm-5.2", only=["z-ai"]),
            "models/z-ai/glm-5.2/endpoints": {
                "data": {
                    "endpoints": [
                        {
                            "tag": "chutes/fp4",
                            "context_length": 1_048_576,
                            "max_completion_tokens": 65_535,
                        },
                        {
                            "tag": "z-ai/fp8",
                            "context_length": 1_048_576,
                            "max_completion_tokens": 131_072,
                        },
                    ]
                }
            },
            "models": {
                "data": [
                    {
                        "id": "z-ai/glm-5.2",
                        "context_length": 1_048_576,
                        "top_provider": {"max_completion_tokens": 262_144},
                    }
                ]
            },
        },
    )

    config = await OpenRouterClient(api_key="sk-or-test").build_models_config(
        "@preset/glm-5-2-zai"
    )

    model = config["providers"]["openrouter"]["models"][0]
    assert model["id"] == "@preset/glm-5-2-zai"
    assert model["maxTokens"] == 131_072


async def test_unpinned_preset_keeps_catalogue_limits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a provider block the preset load-balances, so top_provider stands."""
    requested = _stub_get(
        monkeypatch,
        {
            "presets/": _preset_body("z-ai/glm-5.2"),
            "models": {
                "data": [
                    {
                        "id": "z-ai/glm-5.2",
                        "context_length": 1_048_576,
                        "top_provider": {"max_completion_tokens": 262_144},
                    }
                ]
            },
        },
    )

    config = await OpenRouterClient(api_key="sk-or-test").build_models_config(
        "@preset/glm-5-2-zai"
    )

    assert config["providers"]["openrouter"]["models"][0]["maxTokens"] == 262_144
    assert not any(path.endswith("/endpoints") for path in requested)


def test_endpoint_parses_the_provider_slug_from_its_tag() -> None:
    endpoint = openrouter.OpenRouterEndpoint.model_validate(
        {
            "tag": "z-ai/fp8",
            "provider_name": "Z.AI",
            "quantization": "fp8",
            "context_length": 1_048_576,
            "max_completion_tokens": 131_072,
        }
    )

    assert endpoint.provider_slug == "z-ai"
    assert endpoint.quantization == "fp8"
    assert endpoint.max_completion_tokens == 131_072
