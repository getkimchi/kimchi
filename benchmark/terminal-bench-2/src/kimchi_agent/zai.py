"""Z.AI direct provider configuration.

Z.AI is routed directly (no OpenRouter), giving GLM benchmarks a reproducible
fp8 endpoint without presets. Unlike :mod:`kimchi_agent.openrouter` there is
no HTTP catalogue or preset machinery: Z.AI publishes no OpenRouter-style
discovery endpoint, so model metadata is a static table verified against
docs.z.ai (https://docs.z.ai/guides/llm/glm-5.2, 2026-08-13;
https://docs.z.ai/guides/llm/glm-5.3, 2026-08-25).

Two API surfaces exist:

- OpenAI-compatible chat completions (``https://api.z.ai/api/paas/v4``) — used
  by the kimchi, pi, and opencode agents through pi's ``openai-completions``
  API.
- Anthropic-compatible messages (``https://api.z.ai/api/anthropic``) — used by
  the claude-code agent via ``ANTHROPIC_BASE_URL``.
"""

from __future__ import annotations

from typing import Any

DEFAULT_ZAI_ENDPOINT = "https://api.z.ai/api/paas/v4"
DEFAULT_ZAI_ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic"
ZAI_PROVIDER = "zai"
ZAI_API_KEY_ENV = "ZAI_API_KEY"
# Optional overrides, mirroring KIMCHI_OPENROUTER_ENDPOINT. The OpenAI-
# compatible and Anthropic-compatible surfaces have unrelated paths, so each
# has its own override rather than one derivation rule.
ZAI_ENDPOINT_ENV = "KIMCHI_ZAI_ENDPOINT"
ZAI_ANTHROPIC_ENDPOINT_ENV = "KIMCHI_ZAI_ANTHROPIC_ENDPOINT"

# pi thinking levels that carry a reasoning effort; mirrors openrouter.py.
_PI_THINKING_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "max")
_PI_OPT_IN_THINKING_LEVELS = ("xhigh", "max")

# GLM-5.2 reasoning efforts on the direct API. Z.AI's Claude Code effort
# mapping is low/medium/high→high and xhigh/max→max, so only "high" and "max"
# reach the model distinctly; the rest would be silently clamped and are
# mapped to None so pi rejects them before the run starts.
_GLM_5_2_THINKING_LEVEL_MAP: dict[str, str | None] = {
    "minimal": None,
    "low": None,
    "medium": None,
    "high": "high",
    "xhigh": None,
    "max": "max",
}

# GLM-5.3 reasoning efforts on the direct API
# (https://docs.z.ai/guides/llm/glm-5.3): low, high, and max. Reasoning is
# always enabled and cannot be disabled — a request with thinking disabled
# fails — so "off" is excluded via off_supported=False and levels without an
# equivalent are mapped to None; both are rejected before the run starts
# instead of silently clamping.
_GLM_5_3_THINKING_LEVEL_MAP: dict[str, str | None] = {
    "minimal": None,
    "low": "low",
    "medium": None,
    "high": "high",
    "xhigh": None,
    "max": "max",
}


def is_zai_model(model_name: str | None) -> bool:
    """Whether ``model_name`` is routed via Z.AI (``zai/<id>``)."""
    return bool(model_name) and model_name.startswith(f"{ZAI_PROVIDER}/")


def split_zai_model(model_name: str | None) -> str:
    """Extract the model id from a ``zai/<id>`` model name."""
    if not model_name or "/" not in model_name:
        raise ValueError(
            "--model is required and must use provider/model format, e.g. zai/glm-5.2"
        )
    provider, model_id = model_name.split("/", 1)
    if provider != ZAI_PROVIDER:
        raise ValueError(f"expected a {ZAI_PROVIDER}/ model; got {model_name!r}")
    if not model_id:
        raise ValueError(f"--model must include a model id after {ZAI_PROVIDER}/")
    return model_id


def resolve_zai_endpoint(endpoint: str | None) -> str:
    """OpenAI-compatible endpoint, honouring a stripped override."""
    if endpoint and endpoint.strip():
        return endpoint.strip().rstrip("/")
    return DEFAULT_ZAI_ENDPOINT


def resolve_zai_anthropic_base_url(endpoint: str | None) -> str:
    """Base URL for Z.AI's Anthropic-compatible surface.

    Claude Code appends ``/v1/messages`` to ``ANTHROPIC_BASE_URL``; Z.AI's
    Anthropic surface already ends one segment short of that, so this is a
    plain default with an override hook.
    """
    if endpoint and endpoint.strip():
        return endpoint.strip().rstrip("/")
    return DEFAULT_ZAI_ANTHROPIC_BASE_URL


class ZaiModel:
    """Static pi ``models.json`` metadata for one Z.AI model."""

    def __init__(
        self,
        *,
        model_id: str,
        name: str,
        context_window: int,
        max_output_tokens: int,
        reasoning: bool,
        thinking_level_map: dict[str, str | None] | None,
        off_supported: bool = True,
    ) -> None:
        self.id = model_id
        self.name = name
        self.context_window = context_window
        self.max_output_tokens = max_output_tokens
        self.reasoning = reasoning
        self.thinking_level_map = thinking_level_map
        self.off_supported = off_supported

    @property
    def supported_thinking_levels(self) -> tuple[str, ...]:
        """Levels pi will accept for this model.

        Mirrors pi's ``getSupportedThinkingLevels``: ``off``..``high`` are
        available unless mapped to ``null``, while ``xhigh`` and ``max`` need
        an explicit non-null entry. ``off`` itself is dropped when the model
        cannot disable reasoning (``off_supported=False``); sending a
        thinking-disabled request to such a model fails at the API.
        """
        level_map = self.thinking_level_map
        supported = ["off"] if self.off_supported else []
        for level in _PI_THINKING_LEVELS:
            if level_map is not None and level in level_map:
                if level_map[level] is not None:
                    supported.append(level)
            elif level not in _PI_OPT_IN_THINKING_LEVELS:
                supported.append(level)
        return tuple(supported)

    def require_thinking_level(self, thinking_level: str | None) -> None:
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
            f"thinking level {thinking_level!r} is not supported by Z.AI model "
            f"{self.id!r}; pi would silently clamp it. Supported: {', '.join(supported)}"
        )

    def to_pi_config(self) -> dict[str, Any]:
        config: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "reasoning": self.reasoning,
            "input": ["text"],
            "contextWindow": self.context_window,
            "maxTokens": self.max_output_tokens,
            # Z.AI publishes plan-tier pricing rather than the per-token list
            # OpenRouter exposes; zeros keep usage accounting explicit about
            # the unknown cost instead of inventing numbers.
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "provider": ZAI_PROVIDER,
            # The direct API accepts a reasoning_effort parameter.
            "compat": {"supportsReasoningEffort": True},
        }
        if self.thinking_level_map is not None:
            config["thinkingLevelMap"] = dict(self.thinking_level_map)
        return config


ZAI_MODELS: dict[str, ZaiModel] = {
    "glm-5.2": ZaiModel(
        model_id="glm-5.2",
        name="GLM-5.2",
        # docs.z.ai/guides/llm/glm-5.2 — 1M context (Z.AI's own Claude Code
        # setup uses a 1,000,000 auto-compact window), 128K max output
        # (paas/v4 max_tokens maximum 131072), thinking enabled by default.
        context_window=1_000_000,
        max_output_tokens=131_072,
        reasoning=True,
        thinking_level_map=_GLM_5_2_THINKING_LEVEL_MAP,
    ),
    "glm-5.3": ZaiModel(
        model_id="glm-5.3",
        name="GLM-5.3",
        # docs.z.ai/guides/llm/glm-5.3 — 1M context, 128K max output, thinking
        # always enabled (disabling it fails the request), reasoning_effort
        # values low/high/max (default max).
        context_window=1_000_000,
        max_output_tokens=131_072,
        reasoning=True,
        thinking_level_map=_GLM_5_3_THINKING_LEVEL_MAP,
        off_supported=False,
    ),
}


def zai_model(model_id: str) -> ZaiModel:
    """Static metadata for ``model_id``, raising if Z.AI does not offer it."""
    meta = ZAI_MODELS.get(model_id)
    if meta is None:
        raise ValueError(
            f"Z.AI model {model_id!r} is not in the static metadata table. "
            f"Known models: {', '.join(sorted(ZAI_MODELS))}"
        )
    return meta


def build_models_config(
    model_id: str,
    *,
    include_api_key: bool = True,
    thinking_level: str | None = None,
    endpoint: str | None = None,
) -> dict[str, Any]:
    """Provider block declaring ``model_id`` to a pi-ai-based agent.

    ``include_api_key=False`` omits the ``apiKey`` field so the config can be
    written somewhere that ends up in run artifacts without a key to redact.

    ``thinking_level`` is validated against what pi will accept for the model,
    so an unsupported level fails here instead of being clamped.
    """
    model = zai_model(model_id)
    model.require_thinking_level(thinking_level)

    provider: dict[str, Any] = {
        "api": "openai-completions",
        "baseUrl": resolve_zai_endpoint(endpoint),
        "authHeader": True,
        "models": [model.to_pi_config()],
    }
    if include_api_key:
        provider["apiKey"] = f"${ZAI_API_KEY_ENV}"

    return {"providers": {ZAI_PROVIDER: provider}}
