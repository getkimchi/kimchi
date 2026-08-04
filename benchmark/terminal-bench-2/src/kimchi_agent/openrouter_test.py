import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest
from tenacity import wait_none

from kimchi_agent import openrouter


@pytest.fixture(autouse=True)
def clear_models_cache() -> None:
    openrouter.clear_openrouter_models_cache()


async def test_build_openrouter_models_config_maps_live_metadata_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetch = AsyncMock(
        return_value=[
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
        ]
    )
    monkeypatch.setattr(openrouter, "_fetch_models_uncached", fetch)

    config = await openrouter.build_openrouter_models_config("z-ai/glm-5.2")

    provider = config["providers"]["openrouter"]
    assert provider == {
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
            }
        ],
    }


async def test_discovery_is_shared_by_concurrent_trials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetch = AsyncMock(
        return_value=[
            {"id": "z-ai/glm-5.2"},
            {"id": "anthropic/claude-opus-5-fast"},
        ]
    )
    monkeypatch.setattr(openrouter, "_fetch_models_uncached", fetch)

    first, second = await asyncio.gather(
        openrouter.build_openrouter_models_config("z-ai/glm-5.2"),
        openrouter.build_openrouter_models_config("anthropic/claude-opus-5-fast"),
    )

    assert first["providers"]["openrouter"]["models"][0]["id"] == "z-ai/glm-5.2"
    assert (
        second["providers"]["openrouter"]["models"][0]["id"]
        == "anthropic/claude-opus-5-fast"
    )
    fetch.assert_awaited_once_with("https://openrouter.ai/api/v1")


async def test_endpoint_override_is_used_for_discovery_and_runtime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetch = AsyncMock(return_value=[{"id": "vendor/model"}])
    monkeypatch.setattr(openrouter, "_fetch_models_uncached", fetch)

    config = await openrouter.build_openrouter_models_config(
        "vendor/model", endpoint=" https://router.example.test/v1/ "
    )

    fetch.assert_awaited_once_with("https://router.example.test/v1")
    assert (
        config["providers"]["openrouter"]["baseUrl"]
        == "https://router.example.test/v1"
    )


async def test_unknown_model_fails_before_launch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        openrouter,
        "_fetch_models_uncached",
        AsyncMock(return_value=[{"id": "some/other-model"}]),
    )

    with pytest.raises(ValueError, match="missing/model"):
        await openrouter.build_openrouter_models_config("missing/model")


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

        async def get(self, _url: str) -> httpx.Response:
            return responses.pop(0)

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", lambda **_kwargs: FakeAsyncClient())
    monkeypatch.setattr(openrouter._fetch_models_body.retry, "wait", wait_none())

    models = await openrouter._fetch_models_uncached("https://openrouter.ai/api/v1")

    assert models == [{"id": "vendor/model"}]
    assert responses == []
