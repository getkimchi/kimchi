import asyncio
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1"
OPENROUTER_PROVIDER = "openrouter"
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"
OPENROUTER_ENDPOINT_ENV = "KIMCHI_OPENROUTER_ENDPOINT"

FETCH_TIMEOUT_SEC = 20
FETCH_MAX_ATTEMPTS = 3
FETCH_RETRY_BACKOFF_SEC = 1
RETRYABLE_FETCH_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504, 524, 529})

PER_MTOK_MULTIPLIER = 1_000_000
DEFAULT_MAX_TOKENS = 8192
DEFAULT_CONTEXT_WINDOW = 128000

_models_cache: dict[str, list[dict[str, Any]]] = {}
_models_inflight: dict[str, asyncio.Task[list[dict[str, Any]]]] = {}


def resolve_openrouter_endpoint(endpoint: str | None) -> str:
    if endpoint and endpoint.strip():
        return endpoint.strip().rstrip("/")
    return DEFAULT_OPENROUTER_ENDPOINT


def _is_retryable_fetch_error(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_FETCH_STATUSES
    return False


@retry(
    retry=retry_if_exception(_is_retryable_fetch_error),
    stop=stop_after_attempt(FETCH_MAX_ATTEMPTS),
    wait=wait_exponential(
        multiplier=FETCH_RETRY_BACKOFF_SEC,
        min=FETCH_RETRY_BACKOFF_SEC,
        max=FETCH_RETRY_BACKOFF_SEC * (FETCH_MAX_ATTEMPTS - 1),
    ),
    reraise=True,
)
async def _fetch_models_body(endpoint: str) -> object:
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SEC) as client:
        response = await client.get(f"{endpoint}/models")
        response.raise_for_status()
        return response.json()


async def _fetch_models_uncached(endpoint: str) -> list[dict[str, Any]]:
    try:
        body = await _fetch_models_body(endpoint)
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"OpenRouter models request failed: HTTP {exc.response.status_code}"
        ) from exc
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise RuntimeError(
            f"Failed to fetch OpenRouter models after {FETCH_MAX_ATTEMPTS} attempts: {exc}"
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(f"Failed to fetch OpenRouter models: {exc}") from exc

    models = body.get("data") if isinstance(body, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("Unexpected response shape from OpenRouter models endpoint")
    return [model for model in models if isinstance(model, dict)]


async def _fetch_models(endpoint: str) -> list[dict[str, Any]]:
    cached = _models_cache.get(endpoint)
    if cached is not None:
        return cached

    task = _models_inflight.get(endpoint)
    if task is None:
        task = asyncio.create_task(_fetch_models_uncached(endpoint))
        _models_inflight[endpoint] = task

    try:
        models = await asyncio.shield(task)
    finally:
        if task.done():
            _models_inflight.pop(endpoint, None)

    _models_cache[endpoint] = models
    return models


def _per_mtok(raw: object) -> float:
    if not isinstance(raw, str):
        return 0
    try:
        value = float(raw)
    except ValueError:
        return 0
    return value * PER_MTOK_MULTIPLIER


def _positive_int(raw: object, default: int) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        return default
    return raw


def _model_config(metadata: dict[str, Any]) -> dict[str, Any]:
    model_id = metadata.get("id")
    if not isinstance(model_id, str) or not model_id:
        raise RuntimeError("OpenRouter returned a model without a valid id")

    name = metadata.get("name")
    if not isinstance(name, str) or not name.strip():
        name = model_id

    reasoning_metadata = metadata.get("reasoning")
    reasoning = isinstance(reasoning_metadata, dict) and bool(
        reasoning_metadata.get("mandatory") or reasoning_metadata.get("default_enabled")
    )
    supported_parameters = metadata.get("supported_parameters")
    supported = set(supported_parameters) if isinstance(supported_parameters, list) else set()

    architecture = metadata.get("architecture")
    modalities = architecture.get("input_modalities") if isinstance(architecture, dict) else None
    input_modalities = ["text"]
    if isinstance(modalities, list) and "image" in modalities:
        input_modalities.append("image")

    top_provider = metadata.get("top_provider")
    max_tokens = top_provider.get("max_completion_tokens") if isinstance(top_provider, dict) else None
    pricing = metadata.get("pricing")
    pricing = pricing if isinstance(pricing, dict) else {}

    config: dict[str, Any] = {
        "id": model_id,
        "name": name,
        "reasoning": reasoning,
        "input": input_modalities,
        "contextWindow": _positive_int(
            metadata.get("context_length"), DEFAULT_CONTEXT_WINDOW
        ),
        "maxTokens": _positive_int(max_tokens, DEFAULT_MAX_TOKENS),
        "cost": {
            "input": _per_mtok(pricing.get("prompt")),
            "output": _per_mtok(pricing.get("completion")),
            "cacheRead": _per_mtok(pricing.get("input_cache_read")),
            "cacheWrite": _per_mtok(pricing.get("input_cache_write")),
        },
        "provider": OPENROUTER_PROVIDER,
    }
    if "reasoning_effort" in supported:
        config["compat"] = {"supportsReasoningEffort": True}
    return config


async def build_openrouter_models_config(
    model_id: str,
    *,
    endpoint: str | None = None,
) -> dict[str, Any]:
    resolved_endpoint = resolve_openrouter_endpoint(endpoint)
    models = await _fetch_models(resolved_endpoint)
    metadata = next((model for model in models if model.get("id") == model_id), None)
    if metadata is None:
        raise ValueError(f"Model {model_id!r} was not returned by {resolved_endpoint}/models")

    return {
        "providers": {
            OPENROUTER_PROVIDER: {
                "api": "openai-completions",
                "baseUrl": resolved_endpoint,
                "apiKey": f"${OPENROUTER_API_KEY_ENV}",
                "authHeader": True,
                "models": [_model_config(metadata)],
            }
        }
    }


def clear_openrouter_models_cache() -> None:
    """Clear process-local discovery state. Intended for isolated tests."""
    _models_cache.clear()
    _models_inflight.clear()
