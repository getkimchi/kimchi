import asyncio
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1"
OPENROUTER_PROVIDER = "openrouter"
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"
OPENROUTER_ENDPOINT_ENV = "KIMCHI_OPENROUTER_ENDPOINT"
# Presets (https://openrouter.ai/settings/presets) pin provider routing for a
# model — the only way to stop OpenRouter load-balancing a benchmark run across
# endpoints of differing quantization. They are referenced as a model id but are
# not listed in /models, so limits are read from the model they wrap.
OPENROUTER_PRESET_PREFIX = "@preset/"

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


def resolve_openrouter_anthropic_base_url(endpoint: str | None) -> str:
    """Base URL for OpenRouter's Anthropic-compatible surface.

    Claude Code appends ``/v1/messages`` to ``ANTHROPIC_BASE_URL``, so the base
    must stop one segment short of the OpenAI-style endpoint:
    ``https://openrouter.ai/api`` + ``/v1/messages``.
    """
    resolved = resolve_openrouter_endpoint(endpoint)
    version_suffix = "/v1"
    if resolved.endswith(version_suffix):
        return resolved[: -len(version_suffix)]
    return resolved


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
async def _fetch_preset_body(endpoint: str, slug: str, api_key: str) -> object:
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SEC) as client:
        response = await client.get(
            f"{endpoint}/presets/{slug}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        response.raise_for_status()
        return response.json()


async def fetch_openrouter_preset_model(
    slug: str,
    *,
    api_key: str,
    endpoint: str | None = None,
) -> str:
    """Model id a preset wraps. Presets are per-account, so this call is authed."""
    resolved_endpoint = resolve_openrouter_endpoint(endpoint)
    try:
        body = await _fetch_preset_body(resolved_endpoint, slug, api_key)
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(
            f"OpenRouter preset {slug!r} request failed: HTTP {exc.response.status_code}"
        ) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError(f"Failed to fetch OpenRouter preset {slug!r}: {exc}") from exc

    data = body.get("data") if isinstance(body, dict) else None
    version = data.get("designated_version") if isinstance(data, dict) else None
    config = version.get("config") if isinstance(version, dict) else None
    model_id = config.get("model") if isinstance(config, dict) else None
    if not isinstance(model_id, str) or not model_id:
        raise RuntimeError(f"OpenRouter preset {slug!r} does not pin a single model")
    return model_id


async def resolve_openrouter_catalogue_model(
    model_id: str,
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
) -> str:
    """Map a requested model id to the id that carries its /models metadata.

    Presets resolve to the model they wrap; variant suffixes (``:exacto``,
    ``:nitro``, …) select routing behaviour for a model that is catalogued under
    its base id. Plain ids pass through unchanged.
    """
    if model_id.startswith(OPENROUTER_PRESET_PREFIX):
        if not api_key:
            raise ValueError(
                f"{OPENROUTER_API_KEY_ENV} is required to resolve preset {model_id!r}"
            )
        model_id = await fetch_openrouter_preset_model(
            model_id[len(OPENROUTER_PRESET_PREFIX) :],
            api_key=api_key,
            endpoint=endpoint,
        )
    base_id, _, _variant = model_id.partition(":")
    return base_id


async def fetch_openrouter_model(
    model_id: str,
    *,
    endpoint: str | None = None,
) -> dict[str, Any]:
    """Raw OpenRouter metadata for ``model_id``, raising if it is not offered."""
    resolved_endpoint = resolve_openrouter_endpoint(endpoint)
    models = await _fetch_models(resolved_endpoint)
    metadata = next((model for model in models if model.get("id") == model_id), None)
    if metadata is None:
        raise ValueError(f"Model {model_id!r} was not returned by {resolved_endpoint}/models")
    return metadata


def openrouter_model_limits(metadata: dict[str, Any]) -> tuple[int, int]:
    """``(context_window, max_output_tokens)`` for an OpenRouter model."""
    top_provider = metadata.get("top_provider")
    max_tokens = top_provider.get("max_completion_tokens") if isinstance(top_provider, dict) else None
    return (
        _positive_int(metadata.get("context_length"), DEFAULT_CONTEXT_WINDOW),
        _positive_int(max_tokens, DEFAULT_MAX_TOKENS),
    )


async def build_openrouter_models_config(
    model_id: str,
    *,
    api_key: str | None = None,
    endpoint: str | None = None,
) -> dict[str, Any]:
    resolved_endpoint = resolve_openrouter_endpoint(endpoint)
    # Preset and variant ids are not catalogued, so pricing and limits come from
    # the model they wrap — but the agent must still request the id as given, or
    # the preset's provider pinning is lost.
    catalogue_id = await resolve_openrouter_catalogue_model(
        model_id, api_key=api_key, endpoint=resolved_endpoint
    )
    metadata = await fetch_openrouter_model(catalogue_id, endpoint=resolved_endpoint)
    model_config = {**_model_config(metadata), "id": model_id}

    return {
        "providers": {
            OPENROUTER_PROVIDER: {
                "api": "openai-completions",
                "baseUrl": resolved_endpoint,
                "apiKey": f"${OPENROUTER_API_KEY_ENV}",
                "authHeader": True,
                "models": [model_config],
            }
        }
    }


def clear_openrouter_models_cache() -> None:
    """Clear process-local discovery state. Intended for isolated tests."""
    _models_cache.clear()
    _models_inflight.clear()
