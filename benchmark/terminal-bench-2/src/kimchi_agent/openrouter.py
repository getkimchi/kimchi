"""OpenRouter catalogue access.

:class:`OpenRouterClient` is the single entry point: it owns the HTTP calls and
returns validated models rather than raw JSON, so callers never index into
OpenRouter's response shapes. Discovery is cached per endpoint at class level —
benchmark trials run concurrently in one process and must share one fetch.

Parsing is deliberately permissive (``extra="ignore"``, defaults everywhere).
``/models`` returns the whole catalogue, so one malformed entry must not fail
the run that wanted a different model.
"""

from __future__ import annotations

import asyncio
from typing import Any, ClassVar

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
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

# pi thinking levels that carry a reasoning effort. ``off`` is deliberately
# absent: pi reads a missing ``off`` entry as "thinking can be disabled", which
# is what we want, and reads ``off: null`` as "cannot be disabled".
PI_THINKING_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "max")
# Levels pi treats as opt-in — available only when the model declares them.
PI_OPT_IN_THINKING_LEVELS = ("xhigh", "max")


def is_openrouter_model(model_name: str | None) -> bool:
    """Whether ``model_name`` is routed via OpenRouter (``openrouter/<id>``)."""
    return bool(model_name) and model_name.startswith(f"{OPENROUTER_PROVIDER}/")


def split_openrouter_model(model_name: str | None) -> str:
    """Extract the model id from an ``openrouter/<id>`` model name."""
    if not model_name or "/" not in model_name:
        raise ValueError(
            "--model is required and must use provider/model format, e.g. openrouter/@preset/glm-5-2-zai"
        )
    provider, model_id = model_name.split("/", 1)
    if provider != OPENROUTER_PROVIDER:
        raise ValueError(f"expected a {OPENROUTER_PROVIDER}/ model; got {model_name!r}")
    if not model_id:
        raise ValueError(f"--model must include a model id after {OPENROUTER_PROVIDER}/")
    return model_id


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


def _positive_or_none(value: int | None) -> int | None:
    return value if value is not None and value > 0 else None


_fetch_retry = retry(
    retry=retry_if_exception(_is_retryable_fetch_error),
    stop=stop_after_attempt(FETCH_MAX_ATTEMPTS),
    wait=wait_exponential(
        multiplier=FETCH_RETRY_BACKOFF_SEC,
        min=FETCH_RETRY_BACKOFF_SEC,
        max=FETCH_RETRY_BACKOFF_SEC * (FETCH_MAX_ATTEMPTS - 1),
    ),
    reraise=True,
)


class _Payload(BaseModel):
    """Base for everything parsed off the wire: tolerant and immutable."""

    model_config = ConfigDict(extra="ignore", frozen=True, populate_by_name=True)


class ModelLimits(_Payload):
    """Context window and maximum output tokens, in tokens."""

    context_window: int = Field(gt=0)
    max_output_tokens: int = Field(gt=0)


class ModelCost(_Payload):
    """Per-million-token pricing.

    OpenRouter quotes per-token prices as strings; unparseable values become 0
    rather than failing the catalogue.
    """

    input: float = Field(default=0, alias="prompt")
    output: float = Field(default=0, alias="completion")
    cache_read: float = Field(default=0, alias="input_cache_read")
    cache_write: float = Field(default=0, alias="input_cache_write")

    @field_validator("*", mode="before")
    @classmethod
    def _per_mtok(cls, value: object) -> float:
        try:
            return float(value) * PER_MTOK_MULTIPLIER
        except (TypeError, ValueError):
            return 0.0

    def to_pi_config(self) -> dict[str, float]:
        return {
            "input": self.input,
            "output": self.output,
            "cacheRead": self.cache_read,
            "cacheWrite": self.cache_write,
        }


class OpenRouterEndpoint(_Payload):
    """One provider endpoint serving a model.

    Endpoints for the same model differ in quantization and limits, which is why
    an unpinned run is not reproducible.
    """

    # "<provider slug>/<quantization>" — the slug is what provider routing (and
    # a preset's `only` list) matches on.
    tag: str = ""
    provider_name: str = ""
    quantization: str | None = None
    context_length: int | None = None
    max_completion_tokens: int | None = None

    @property
    def provider_slug(self) -> str:
        return self.tag.split("/", 1)[0] if self.tag else ""


class _ReasoningMetadata(_Payload):
    mandatory: bool = False
    default_enabled: bool = False
    supported_efforts: tuple[str, ...] = ()
    default_effort: str | None = None


class _TopProvider(_Payload):
    max_completion_tokens: int | None = None
    context_length: int | None = None


class _Architecture(_Payload):
    input_modalities: tuple[str, ...] = ("text",)


class OpenRouterModel(_Payload):
    """A validated ``/models`` entry."""

    id: str = Field(min_length=1)
    display_name: str | None = Field(default=None, alias="name")
    reasoning_metadata: _ReasoningMetadata = Field(
        default_factory=_ReasoningMetadata, alias="reasoning"
    )
    supported_parameters: tuple[str, ...] = ()
    architecture: _Architecture = Field(default_factory=_Architecture)
    context_length: int | None = None
    top_provider: _TopProvider = Field(default_factory=_TopProvider)
    cost: ModelCost = Field(default_factory=ModelCost, alias="pricing")

    @property
    def name(self) -> str:
        return self.display_name.strip() if self.display_name else self.id

    @property
    def reasoning(self) -> bool:
        """Whether the model reasons by default. pi gates thinking on this."""
        return bool(
            self.reasoning_metadata.mandatory or self.reasoning_metadata.default_enabled
        )

    @property
    def supported_efforts(self) -> tuple[str, ...]:
        """Reasoning efforts OpenRouter accepts.

        Empty means "unpublished", not "none" — it must not be read as a
        rejection.
        """
        return self.reasoning_metadata.supported_efforts

    @property
    def supports_reasoning_effort(self) -> bool:
        return "reasoning_effort" in self.supported_parameters

    @property
    def input_modalities(self) -> tuple[str, ...]:
        return (
            ("text", "image")
            if "image" in self.architecture.input_modalities
            else ("text",)
        )

    @property
    def limits(self) -> ModelLimits:
        """Catalogue-wide limits, describing whichever endpoint is favoured."""
        return ModelLimits(
            context_window=_positive_or_none(self.context_length) or DEFAULT_CONTEXT_WINDOW,
            max_output_tokens=_positive_or_none(self.top_provider.max_completion_tokens)
            or DEFAULT_MAX_TOKENS,
        )

    @property
    def thinking_level_map(self) -> dict[str, str | None] | None:
        """pi's ``thinkingLevelMap``, or ``None`` when efforts are unpublished.

        pi gates ``xhigh``/``max`` on the key being present and reads ``null`` as
        "level unsupported". An omitted map therefore caps a model at ``high``
        silently — which is how a ``--thinking max`` run scored as ``high``.
        """
        if not self.supported_efforts:
            return None
        return {
            level: (level if level in self.supported_efforts else None)
            for level in PI_THINKING_LEVELS
        }

    @property
    def supported_thinking_levels(self) -> tuple[str, ...]:
        """Levels pi will accept for this model.

        Mirrors pi's ``getSupportedThinkingLevels``: ``off``..``high`` are
        available unless mapped to ``null``, while ``xhigh`` and ``max`` need an
        explicit non-null entry. A model with no map therefore stops at ``high``.
        """
        level_map = self.thinking_level_map
        supported = ["off"]
        for level in PI_THINKING_LEVELS:
            if level_map is not None and level in level_map:
                if level_map[level] is not None:
                    supported.append(level)
            elif level not in PI_OPT_IN_THINKING_LEVELS:
                supported.append(level)
        return tuple(supported)

    def require_thinking_level(self, thinking_level: str | None, *, model_id: str) -> None:
        """Reject a thinking level pi would clamp, before the agent starts.

        pi clamps silently and records only the clamped value, so the run
        measures an effort nobody asked for while the artifacts still claim the
        requested one.
        """
        if not thinking_level:
            return
        supported = self.supported_thinking_levels
        if thinking_level in supported:
            return
        raise ValueError(
            f"thinking level {thinking_level!r} is not supported by {model_id!r}; "
            f"pi would silently clamp it. Supported: {', '.join(supported)}"
        )

    def to_pi_config(
        self, *, model_id: str | None = None, limits: ModelLimits | None = None
    ) -> dict[str, Any]:
        """This model as a pi ``models.json`` entry.

        ``model_id`` overrides the declared id so a preset is declared under the
        id the agent must send; ``limits`` narrows the catalogue-wide values to
        the endpoint a preset actually pins.
        """
        effective_limits = limits or self.limits
        config: dict[str, Any] = {
            "id": model_id or self.id,
            "name": self.name,
            "reasoning": self.reasoning,
            "input": list(self.input_modalities),
            "contextWindow": effective_limits.context_window,
            "maxTokens": effective_limits.max_output_tokens,
            "cost": self.cost.to_pi_config(),
            "provider": OPENROUTER_PROVIDER,
        }
        if self.supports_reasoning_effort:
            config["compat"] = {"supportsReasoningEffort": True}
        thinking_level_map = self.thinking_level_map
        if thinking_level_map is not None:
            config["thinkingLevelMap"] = thinking_level_map
        return config


class _PresetProvider(_Payload):
    only: tuple[str, ...] = ()
    allow_fallbacks: bool = True


class _PresetConfig(_Payload):
    wrapped_model: str = Field(alias="model", min_length=1)
    provider: _PresetProvider = Field(default_factory=_PresetProvider)


class _PresetVersion(_Payload):
    config: _PresetConfig


class _PresetData(_Payload):
    designated_version: _PresetVersion


class _PresetResponse(_Payload):
    data: _PresetData


class OpenRouterPreset(_Payload):
    """A saved OpenRouter configuration, addressed as ``@preset/<slug>``."""

    slug: str
    model_id: str
    pinned_providers: tuple[str, ...] = ()

    @classmethod
    def from_body(cls, slug: str, body: object) -> OpenRouterPreset:
        try:
            response = _PresetResponse.model_validate(body)
        except ValidationError as exc:
            raise RuntimeError(
                f"OpenRouter preset {slug!r} does not pin a single model"
            ) from exc
        config = response.data.designated_version.config
        return cls(
            slug=slug,
            model_id=config.wrapped_model,
            pinned_providers=config.provider.only,
        )


class OpenRouterSelection(_Payload):
    """How a requested model id resolves against OpenRouter.

    ``requested_id`` is what the agent must actually send — a preset id routes
    only when passed through verbatim. ``catalogue_id`` is the id that carries
    ``/models`` metadata, and ``pinned_providers`` are the provider slugs a
    preset restricts routing to (empty for an unpinned plain id).
    """

    requested_id: str
    catalogue_id: str
    pinned_providers: tuple[str, ...] = ()

    @property
    def is_pinned(self) -> bool:
        return bool(self.pinned_providers)


class _ModelsResponse(_Payload):
    data: list[dict[str, Any]]


class _EndpointsResponse(_Payload):
    class _Data(_Payload):
        endpoints: list[dict[str, Any]] = Field(default_factory=list)

    data: _Data


class OpenRouterClient:
    """Reads OpenRouter's catalogue and builds pi provider configuration.

    Discovery is cached per endpoint on the class, not the instance: agents build
    one client per trial, and concurrent trials must share a single fetch.
    """

    _models_cache: ClassVar[dict[str, tuple[OpenRouterModel, ...]]] = {}
    _models_inflight: ClassVar[dict[str, asyncio.Task[tuple[OpenRouterModel, ...]]]] = {}
    _endpoints_cache: ClassVar[
        dict[tuple[str, str], tuple[OpenRouterEndpoint, ...]]
    ] = {}
    _endpoints_inflight: ClassVar[
        dict[tuple[str, str], asyncio.Task[tuple[OpenRouterEndpoint, ...]]]
    ] = {}

    def __init__(self, *, api_key: str | None = None, endpoint: str | None = None) -> None:
        self._api_key = api_key
        self._endpoint = resolve_openrouter_endpoint(endpoint)

    @property
    def endpoint(self) -> str:
        return self._endpoint

    @classmethod
    def clear_caches(cls) -> None:
        """Clear process-local discovery state. Intended for isolated tests."""
        cls._models_cache.clear()
        cls._models_inflight.clear()
        cls._endpoints_cache.clear()
        cls._endpoints_inflight.clear()

    @_fetch_retry
    async def _get(self, path: str, *, authed: bool = False) -> object:
        headers = (
            {"Authorization": f"Bearer {self._api_key}"} if authed and self._api_key else {}
        )
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SEC) as client:
            response = await client.get(f"{self._endpoint}/{path}", headers=headers)
            response.raise_for_status()
            return response.json()

    async def _fetch_models(self) -> tuple[OpenRouterModel, ...]:
        try:
            body = await self._get("models")
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

        try:
            response = _ModelsResponse.model_validate(body)
        except ValidationError as exc:
            raise RuntimeError(
                "Unexpected response shape from OpenRouter models endpoint"
            ) from exc

        models = []
        for entry in response.data:
            # The catalogue is fetched whole; one malformed entry must not deny
            # every other model.
            try:
                models.append(OpenRouterModel.model_validate(entry))
            except ValidationError:
                continue
        return tuple(models)

    async def models(self) -> tuple[OpenRouterModel, ...]:
        """Every model OpenRouter offers, shared across concurrent callers."""
        cached = self._models_cache.get(self._endpoint)
        if cached is not None:
            return cached

        task = self._models_inflight.get(self._endpoint)
        if task is None:
            task = asyncio.create_task(self._fetch_models())
            self._models_inflight[self._endpoint] = task

        try:
            models = await asyncio.shield(task)
        finally:
            if task.done():
                self._models_inflight.pop(self._endpoint, None)

        self._models_cache[self._endpoint] = models
        return models

    async def model(self, model_id: str) -> OpenRouterModel:
        """Metadata for ``model_id``, raising if OpenRouter does not offer it."""
        for candidate in await self.models():
            if candidate.id == model_id:
                return candidate
        raise ValueError(f"Model {model_id!r} was not returned by {self._endpoint}/models")

    async def preset(self, slug: str) -> OpenRouterPreset:
        """A preset's pinned model and provider routing. Presets are per-account."""
        try:
            body = await self._get(f"presets/{slug}", authed=True)
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"OpenRouter preset {slug!r} request failed: HTTP {exc.response.status_code}"
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError(f"Failed to fetch OpenRouter preset {slug!r}: {exc}") from exc
        return OpenRouterPreset.from_body(slug, body)

    async def _fetch_endpoints(self, model_id: str) -> tuple[OpenRouterEndpoint, ...]:
        body = await self._get(f"models/{model_id}/endpoints")
        try:
            response = _EndpointsResponse.model_validate(body)
        except ValidationError:
            return ()
        endpoints = []
        for entry in response.data.endpoints:
            try:
                endpoints.append(OpenRouterEndpoint.model_validate(entry))
            except ValidationError:
                continue
        return tuple(endpoints)

    async def endpoints(self, model_id: str) -> tuple[OpenRouterEndpoint, ...]:
        """Per-provider endpoints for a model, shared across concurrent callers."""
        key = (self._endpoint, model_id)
        cached = self._endpoints_cache.get(key)
        if cached is not None:
            return cached

        task = self._endpoints_inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_endpoints(model_id))
            self._endpoints_inflight[key] = task

        try:
            endpoints = await asyncio.shield(task)
        finally:
            if task.done():
                self._endpoints_inflight.pop(key, None)

        self._endpoints_cache[key] = endpoints
        return endpoints

    async def resolve(self, model_id: str) -> OpenRouterSelection:
        """Resolve a requested id to its metadata id plus any preset routing pins.

        Presets resolve to the model they wrap; variant suffixes (``:exacto``,
        ``:nitro``, …) select routing behaviour for a model catalogued under its
        base id. Plain ids pass through unchanged.
        """
        pinned: tuple[str, ...] = ()
        catalogue_id = model_id
        if model_id.startswith(OPENROUTER_PRESET_PREFIX):
            if not self._api_key:
                raise ValueError(
                    f"{OPENROUTER_API_KEY_ENV} is required to resolve preset {model_id!r}"
                )
            preset = await self.preset(model_id[len(OPENROUTER_PRESET_PREFIX) :])
            catalogue_id = preset.model_id
            pinned = preset.pinned_providers
        base_id, _, _variant = catalogue_id.partition(":")
        return OpenRouterSelection(
            requested_id=model_id, catalogue_id=base_id, pinned_providers=pinned
        )

    async def limits_for(self, selection: OpenRouterSelection) -> ModelLimits:
        """Limits of the endpoints a selection actually reaches.

        ``top_provider`` describes whichever endpoint OpenRouter currently
        favours, which is not where a pinned preset routes. A pin names a
        provider rather than an endpoint, so a provider serving several
        quantizations can still route to any of them — the smallest limit is the
        only one safe to assume.
        """
        model = await self.model(selection.catalogue_id)
        if not selection.is_pinned:
            return model.limits

        matches = [
            endpoint
            for endpoint in await self.endpoints(selection.catalogue_id)
            if endpoint.provider_slug in selection.pinned_providers
        ]
        if not matches:
            return model.limits

        def smallest(values: list[int | None], fallback: int) -> int:
            return min(
                (value for value in values if _positive_or_none(value) is not None),
                default=fallback,
            )

        return ModelLimits(
            context_window=smallest(
                [endpoint.context_length for endpoint in matches],
                model.limits.context_window,
            ),
            max_output_tokens=smallest(
                [endpoint.max_completion_tokens for endpoint in matches],
                model.limits.max_output_tokens,
            ),
        )

    async def build_models_config(
        self,
        model_id: str,
        *,
        include_api_key: bool = True,
        thinking_level: str | None = None,
    ) -> dict[str, Any]:
        """Provider block declaring ``model_id`` to a pi-ai-based agent.

        ``include_api_key=False`` omits the ``apiKey`` field for agents that
        resolve the key from ``OPENROUTER_API_KEY`` themselves (upstream pi maps
        provider ids to env vars). Prefer it wherever the config is written
        somewhere that ends up in run artifacts — an omitted key cannot leak.

        ``thinking_level`` is validated against what pi will accept for the
        model, so an unsupported level fails here instead of being clamped.
        """
        # Preset and variant ids are not catalogued, so pricing and limits come
        # from the model they wrap — but the agent must still request the id as
        # given, or the preset's provider pinning is lost.
        selection = await self.resolve(model_id)
        model = await self.model(selection.catalogue_id)
        model.require_thinking_level(thinking_level, model_id=model_id)
        limits = await self.limits_for(selection)

        provider: dict[str, Any] = {
            "api": "openai-completions",
            "baseUrl": self._endpoint,
            "authHeader": True,
            "models": [model.to_pi_config(model_id=model_id, limits=limits)],
        }
        if include_api_key:
            provider["apiKey"] = f"${OPENROUTER_API_KEY_ENV}"

        return {"providers": {OPENROUTER_PROVIDER: provider}}
