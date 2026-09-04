"""Native Moonshot AI models (``moonshotai/<id>``).

Routes directly against Moonshot's OpenAI-compatible API
(``https://api.moonshot.ai/v1``) with the key from ``MOONSHOT_API_KEY``, plus
the Anthropic-compatible surface (``https://api.moonshot.ai/anthropic``) for
the claude-code agent. pi-ai ships a built-in ``moonshotai`` provider that
already maps ``MOONSHOT_API_KEY`` from the environment, so no provider
plumbing is needed inside the container — only the model metadata declared
here.

Metadata is fully static (no catalogue fetch): the benchmark offers exactly
the models listed below, and Moonshot's list API publishes no limits,
pricing, or thinking behaviour. Mirrors the ``anthropic/*`` pattern in
``agent.py``; shared by the kimchi, pi, claude-code and opencode agents so the
table exists in exactly one place.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from kimchi_agent.openrouter import PI_OPT_IN_THINKING_LEVELS, PI_THINKING_LEVELS

MOONSHOT_PROVIDER = "moonshotai"
MOONSHOT_API_KEY_ENV = "MOONSHOT_API_KEY"
MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"
MOONSHOT_ANTHROPIC_BASE_URL = "https://api.moonshot.ai/anthropic"

# pi-ai's common openai-completions compat flags from its built-in moonshotai
# catalogue entries. Per-model request formats are declared separately because
# K2.7 uses ``thinking`` while K3 uses top-level ``reasoning_effort``.
_PI_MOONSHOT_COMPAT = {
    "supportsStore": False,
    "supportsDeveloperRole": False,
    "supportsStrictMode": False,
}


def is_moonshot_model(model_name: str | None) -> bool:
    """Whether ``model_name`` is routed via the native Moonshot API (``moonshotai/<id>``)."""
    return bool(model_name) and model_name.startswith(f"{MOONSHOT_PROVIDER}/")


def split_moonshot_model(model_name: str | None) -> str:
    """Extract the model id from a ``moonshotai/<id>`` model name."""
    if not model_name or "/" not in model_name:
        raise ValueError("--model is required and must use provider/model format, e.g. moonshotai/kimi-k3")
    provider, model_id = model_name.split("/", 1)
    if provider != MOONSHOT_PROVIDER:
        raise ValueError(f"expected a {MOONSHOT_PROVIDER}/ model; got {model_name!r}")
    if not model_id:
        raise ValueError(f"--model must include a model id after {MOONSHOT_PROVIDER}/")
    return model_id


class MoonshotModel(BaseModel):
    """Static metadata for one Moonshot model, as a pi-ai model knows it."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    context_window: int = Field(gt=0)
    max_output_tokens: int = Field(gt=0)
    max_tokens_field: Literal["max_tokens", "max_completion_tokens"]
    thinking_format: Literal["deepseek", "openai"]
    # Per-million-token pricing from https://platform.kimi.ai/docs/pricing/chat.
    cost_input: float = Field(ge=0)
    cost_output: float = Field(ge=0)
    cost_cache_read: float = Field(default=0, ge=0)
    # Id to send through the Anthropic-compatible endpoint (claude-code agent):
    # K3's 1M window is selected with the `[1m]` suffix there, per
    # https://platform.kimi.ai/docs/guide/claude-code-kimi.
    anthropic_model_id: str = Field(min_length=1)
    # reasoning_effort values the model accepts. Empty means the parameter is
    # unsupported (K2.7 Code) and pi must not send it.
    supported_efforts: tuple[str, ...] = ()
    # Whether the platform rejects requests with thinking disabled. Both
    # catalogued models always reason; see
    # https://platform.kimi.ai/docs/api/models-overview.
    thinking_required: bool = True

    @property
    def thinking_level_map(self) -> dict[str, str | None] | None:
        """pi's ``thinkingLevelMap``, or ``None`` for pi's default handling.

        Four cases:

        * Optional thinking without an effort parameter: ``None`` — pi's
          default handling applies (``off`` allowed, non-opt-in levels pass
          through to the model, opt-in levels capped), which is what
          ``supported_thinking_levels`` already claims.
        * Optional thinking with efforts: only the supported efforts get
          entries; ``off`` is absent, which pi reads as "thinking can be
          disabled", and every other level is nulled so pi rejects it.
        * Required thinking with efforts (K3): ``off`` is nulled so pi
          rejects disabling, and every level without a matching effort is
          nulled so pi rejects it instead of clamping silently.
        * Required thinking without an effort parameter (K2.7 Code): every
          level is nulled — thinking cannot be configured at all.
        """
        if not self.thinking_required and not self.supported_efforts:
            return None
        level_map: dict[str, str | None] = {}
        if self.thinking_required:
            level_map["off"] = None
        for level in PI_THINKING_LEVELS:
            level_map[level] = level if level in self.supported_efforts else None
        return level_map

    @property
    def supported_thinking_levels(self) -> tuple[str, ...]:
        """Levels pi will accept for this model.

        Mirrors pi's ``getSupportedThinkingLevels``: a level mapped to ``None``
        is unsupported, and opt-in levels (``xhigh``/``max``) additionally need
        an explicit non-null entry. A model without an effort parameter accepts
        nothing — an explicit level could never reach the model.
        """
        supported: list[str] = [] if self.thinking_required else ["off"]
        if self.supported_efforts:
            supported.extend(level for level in PI_THINKING_LEVELS if level in self.supported_efforts)
        elif not self.thinking_required:
            # No published effort parameter but thinking can be disabled: pi
            # passes the non-opt-in levels through to the model verbatim.
            supported.extend(level for level in PI_THINKING_LEVELS if level not in PI_OPT_IN_THINKING_LEVELS)
        # No effort parameter with mandatory thinking (K2.7 Code): nothing is
        # configurable, so nothing is supported.
        return tuple(supported)

    def require_thinking_level(self, thinking_level: str | None, *, model_name: str) -> None:
        """Reject a thinking level this model cannot honour, before launch.

        pi clamps unsupported levels silently and records only the clamped
        value, so a run would measure an effort nobody asked for while the
        artifacts still claim the requested one.
        """
        if not thinking_level:
            return
        supported = self.supported_thinking_levels
        if thinking_level in supported:
            return
        detail = ", ".join(supported) if supported else "none — thinking cannot be configured"
        raise ValueError(
            f"thinking level {thinking_level!r} is not supported by {model_name!r}; "
            f"pi would silently clamp it. Supported: {detail}"
        )

    def to_pi_config(self) -> dict[str, Any]:
        """This model as a pi ``models.json`` entry."""
        config: dict[str, Any] = {
            "id": self.id,
            "name": self.display_name,
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": self.context_window,
            "maxTokens": self.max_output_tokens,
            "cost": {
                "input": self.cost_input,
                "output": self.cost_output,
                "cacheRead": self.cost_cache_read,
                "cacheWrite": 0,
            },
            "provider": MOONSHOT_PROVIDER,
            "compat": {
                **_PI_MOONSHOT_COMPAT,
                "maxTokensField": self.max_tokens_field,
                "supportsReasoningEffort": bool(self.supported_efforts),
                "thinkingFormat": self.thinking_format,
            },
        }
        thinking_level_map = self.thinking_level_map
        if thinking_level_map is not None:
            config["thinkingLevelMap"] = thinking_level_map
        return config


# Sources: https://platform.kimi.ai/docs/models,
# https://platform.kimi.ai/docs/pricing/chat,
# https://platform.kimi.ai/docs/api/models-overview.
_MOONSHOT_MODELS: dict[str, MoonshotModel] = {
    "kimi-k2.7-code": MoonshotModel(
        id="kimi-k2.7-code",
        display_name="Kimi K2.7 Code",
        context_window=262_144,
        # Moonshot documents 256K as the total context window and 32K as the
        # generation default. Do not misrepresent the context size as a
        # verified output cap: pi and OpenCode use this field for budgeting.
        max_output_tokens=32_768,
        max_tokens_field="max_tokens",
        thinking_format="deepseek",
        cost_input=0.95,
        cost_output=4.0,
        cost_cache_read=0.19,
        anthropic_model_id="kimi-k2.7-code",
        # Thinking is always on and cannot be disabled; reasoning_effort is
        # not supported.
        thinking_required=True,
    ),
    "kimi-k3": MoonshotModel(
        id="kimi-k3",
        display_name="Kimi K3",
        context_window=1_048_576,
        # Moonshot publishes no output-token cap for K3; 128K matches the
        # frontier-model convention used for the static anthropic/* table.
        max_output_tokens=131_072,
        max_tokens_field="max_completion_tokens",
        thinking_format="openai",
        cost_input=3.0,
        cost_output=15.0,
        cost_cache_read=0.30,
        anthropic_model_id="kimi-k3[1m]",
        # Always reasons; effort is low/high/max (default max).
        supported_efforts=("low", "high", "max"),
        thinking_required=True,
    ),
}


def required_moonshot_api_key(get_env: Callable[[str], str | None]) -> str:
    """Resolve the Moonshot key through an agent's environment lookup."""
    api_key = get_env(MOONSHOT_API_KEY_ENV)
    if not api_key:
        raise ValueError(
            f"{MOONSHOT_API_KEY_ENV} is required for {MOONSHOT_PROVIDER}/* models. "
            f"Export it on the host and forward it with "
            f"`--ae {MOONSHOT_API_KEY_ENV}=${MOONSHOT_API_KEY_ENV}`."
        )
    return api_key


def moonshot_metadata(model_id: str) -> MoonshotModel:
    """Static metadata for ``model_id``, raising for anything else."""
    model = _MOONSHOT_MODELS.get(model_id)
    if model is None:
        raise ValueError(
            f"Moonshot model {model_id!r} is not in the static metadata table. "
            f"Known models: {', '.join(sorted(_MOONSHOT_MODELS))}"
        )
    return model


def build_models_config(
    model_id: str,
    *,
    include_api_key: bool = True,
    thinking_level: str | None = None,
) -> dict[str, Any]:
    """Provider block declaring ``model_id`` to a pi-ai-based agent.

    ``include_api_key=False`` omits the ``apiKey`` field for agents that
    resolve the key from ``MOONSHOT_API_KEY`` themselves (upstream pi-ai maps
    the ``moonshotai`` provider to that env var). Prefer it wherever the config
    is written somewhere that ends up in run artifacts — an omitted key cannot
    leak.

    ``thinking_level`` is validated against what pi will accept for the
    model, so an unsupported level fails here instead of being clamped.
    """
    model = moonshot_metadata(model_id)
    model.require_thinking_level(thinking_level, model_name=f"{MOONSHOT_PROVIDER}/{model_id}")

    provider: dict[str, Any] = {
        "api": "openai-completions",
        "baseUrl": MOONSHOT_BASE_URL,
        "authHeader": True,
        "models": [model.to_pi_config()],
    }
    if include_api_key:
        provider["apiKey"] = f"${MOONSHOT_API_KEY_ENV}"

    return {"providers": {MOONSHOT_PROVIDER: provider}}
