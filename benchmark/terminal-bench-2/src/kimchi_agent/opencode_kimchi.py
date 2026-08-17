import copy
import json
import shlex
from dataclasses import dataclass
from typing import Any

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KIMCHI_OPENAI_BASE_URL,
    KIMCHI_PROVIDER,
    KimchiGatewayMixin,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.moonshot import (
    MOONSHOT_API_KEY_ENV,
    MOONSHOT_BASE_URL,
    MOONSHOT_PROVIDER,
    is_moonshot_model,
    moonshot_metadata,
    split_moonshot_model,
)
from kimchi_agent.openrouter import is_openrouter_model, split_openrouter_model
from kimchi_agent.zai import (
    DEFAULT_ZAI_ENDPOINT,
    ZAI_API_KEY_ENV,
    ZAI_PROVIDER,
    is_zai_model,
    split_zai_model,
    zai_model,
)

SMALL_MODEL_ENV = "OPENCODE_SMALL_MODEL"
OPENCODE_RUNTIME_ENV_KEYS = {
    "OPENCODE_CLIENT",
    "OPENCODE_FAKE_VCS",
}

OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PROVIDER_NAME = "openrouter"

# Aliases for the test-suite import contract; canonical values live in
# kimchi_agent.zai.
ZAI_BASE_URL = DEFAULT_ZAI_ENDPOINT
ZAI_PROVIDER_NAME = ZAI_PROVIDER


@dataclass(frozen=True)
class ProviderRoute:
    key: str
    name: str
    base_url: str
    api_key_env: str
    litellm_proxy: bool = False


@dataclass(frozen=True)
class ResolvedModel:
    route: ProviderRoute
    model_id: str
    config: dict[str, Any]

    @property
    def uses_reasoning(self) -> bool:
        return bool(self.config["reasoning"])


KIMCHI_ROUTE = ProviderRoute(
    key=KIMCHI_PROVIDER,
    name="Kimchi",
    base_url=KIMCHI_OPENAI_BASE_URL,
    api_key_env=KIMCHI_API_KEY_ENV,
    litellm_proxy=True,
)
OPENROUTER_ROUTE = ProviderRoute(
    key=OPENROUTER_PROVIDER_NAME,
    name="OpenRouter",
    base_url=OPENROUTER_BASE_URL,
    api_key_env=OPENROUTER_API_KEY_ENV,
)
MOONSHOT_ROUTE = ProviderRoute(
    key=MOONSHOT_PROVIDER,
    name="Moonshot AI",
    base_url=MOONSHOT_BASE_URL,
    api_key_env=MOONSHOT_API_KEY_ENV,
)
ZAI_ROUTE = ProviderRoute(
    key=ZAI_PROVIDER_NAME,
    name="Z.AI",
    base_url=ZAI_BASE_URL,
    api_key_env=ZAI_API_KEY_ENV,
)

# Static metadata for OpenRouter models that bypass the Kimchi gateway.
# The Kimchi metadata API cannot describe third-party providers, so known
# OpenRouter models are listed here. tool_call is assumed True (OpenRouter
# models that support tool use are the ones we benchmark).
_OPENROUTER_MODEL_METADATA: dict[str, dict[str, Any]] = {
    "@preset/glm-5-1-zai": {
        "reasoning": False,
        "context_window": 128_000,
        "max_output_tokens": 16_384,
    },
    "@preset/glm-5-2-zai": {
        "reasoning": False,
        "context_window": 128_000,
        "max_output_tokens": 16_384,
    },
    "@preset/kimi-k2-7-moonshot": {
        "reasoning": True,
        "context_window": 262_144,
        "max_output_tokens": 65_536,
    },
}


class OpenCodeKimchi(KimchiGatewayMixin, OpenCode):
    """Harbor OpenCode agent wired to an OpenAI-compatible gateway.

    Supports four provider modes selected by the ``--model`` prefix:

    * ``kimchi-dev/<id>`` — routes through the Kimchi gateway. Model metadata
      (context window, output limits, reasoning) is fetched from the Kimchi
      metadata API.
    * ``openrouter/<id>`` — routes through OpenRouter directly. Metadata for
      known models is looked up from a static table; the OpenRouter API key
      is injected from ``OPENROUTER_API_KEY``.
    * ``moonshotai/<id>`` — routes through Moonshot directly using static
      metadata and ``MOONSHOT_API_KEY``.
    * ``zai/<id>`` — routes through Z.AI's OpenAI-compatible API directly.
      Metadata comes from the static table; the key is injected from
      ``ZAI_API_KEY``.

    The adapter registers the selected model in OpenCode's config at runtime
    before invoking ``opencode run``.
    """

    @classmethod
    def _provider_route(cls, model_name: str | None) -> ProviderRoute:
        if is_openrouter_model(model_name):
            return OPENROUTER_ROUTE
        if is_moonshot_model(model_name):
            return MOONSHOT_ROUTE
        if is_zai_model(model_name):
            return ZAI_ROUTE
        return KIMCHI_ROUTE

    def _openrouter_model_config(self, model_name: str | None) -> dict[str, Any]:
        """Build static model config for an OpenRouter model."""
        model_id = split_openrouter_model(model_name)
        meta = _OPENROUTER_MODEL_METADATA.get(model_id)
        if meta is None:
            raise ValueError(
                f"OpenRouter model {model_id!r} is not in the static metadata table. "
                f"Known models: {', '.join(sorted(_OPENROUTER_MODEL_METADATA))}"
            )
        return {
            "name": model_id,
            "tool_call": True,
            "reasoning": meta["reasoning"],
            "limit": {
                "context": meta["context_window"],
                "output": meta["max_output_tokens"],
            },
        }

    @staticmethod
    def name() -> str:
        return "opencode-kimchi"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=GIT_INSTALL_COMMAND,
            env=GIT_INSTALL_ENV,
        )
        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )
        await super().install(environment)

    def _moonshot_model_config(self, model_name: str | None) -> dict[str, Any]:
        """Build static model config for a Moonshot model."""
        model = moonshot_metadata(split_moonshot_model(model_name))
        return {
            "name": model.id,
            "tool_call": True,
            "reasoning": True,
            "limit": {
                "context": model.context_window,
                "output": model.max_output_tokens,
            },
        }

    def _zai_model_config(self, model_name: str | None) -> dict[str, Any]:
        """Build static model config for a Z.AI model."""
        meta = zai_model(split_zai_model(model_name))
        return {
            "name": meta.id,
            "tool_call": True,
            "reasoning": meta.reasoning,
            "limit": {
                "context": meta.context_window,
                "output": meta.max_output_tokens,
            },
        }

    def _resolve_model(self, model_name: str | None, api_key: str | None = None) -> ResolvedModel:
        """Resolve provider-specific identity, metadata, and behavior once."""
        route = self._provider_route(model_name)
        if route is OPENROUTER_ROUTE:
            model_id = split_openrouter_model(model_name)
            config = self._openrouter_model_config(model_name)
            return ResolvedModel(route, model_id, config)
        if route is MOONSHOT_ROUTE:
            model_id = split_moonshot_model(model_name)
            config = self._moonshot_model_config(model_name)
            return ResolvedModel(route, model_id, config)
        if route is ZAI_ROUTE:
            model_id = split_zai_model(model_name)
            config = self._zai_model_config(model_name)
            return ResolvedModel(route, model_id, config)
        _, model_id = self._split_model(model_name)
        if api_key is None:
            raise ValueError("api_key is required for kimchi-dev/* models")
        model = self._model_metadata_for(api_key, model_name)
        config = {
            "name": model.slug,
            # The current metadata endpoint does not expose tool-call capability.
            # Kimchi's OpenCode integration treats gateway-served models as tool-capable.
            "tool_call": True,
            "reasoning": model.reasoning,
            "limit": {
                "context": model.limits.context_window,
                "output": model.limits.max_output_tokens,
            },
        }
        return ResolvedModel(route, model_id, config)

    def _small_model_name(self) -> str | None:
        small_model_name = self._get_env(SMALL_MODEL_ENV) or self.model_name
        if self.model_name and small_model_name:
            main_provider, separator, _ = self.model_name.partition("/")
            small_provider, small_separator, _ = small_model_name.partition("/")
            if separator and small_separator and main_provider != small_provider:
                raise ValueError(
                    f"{SMALL_MODEL_ENV} must use the same provider as --model; "
                    f"got {small_model_name!r} with {self.model_name!r}"
                )
        return small_model_name

    def _build_register_config_command(
        self,
        api_key: str,
        small_model_name: str | None = None,
    ) -> tuple[str, bool]:
        small_model_name = small_model_name or self._small_model_name()
        selected_model = self._resolve_model(self.model_name, api_key=api_key)
        route = selected_model.route
        models = {selected_model.model_id: selected_model.config}
        if small_model_name != self.model_name:
            small_model = self._resolve_model(small_model_name, api_key=api_key)
            models[small_model.model_id] = small_model.config

        mcp: dict[str, dict[str, Any]] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                cmd_list = [server.command, *server.args] if server.command else []
                mcp[server.name] = {"type": "local", "command": cmd_list}
            else:
                mcp[server.name] = {"type": "remote", "url": server.url}

        provider_options: dict[str, Any] = {
            "baseURL": route.base_url,
            "apiKey": f"{{env:{route.api_key_env}}}",
        }
        if route.litellm_proxy:
            provider_options["litellmProxy"] = True
        provider_config: dict[str, Any] = {
            "npm": "@ai-sdk/openai-compatible",
            "name": route.name,
            "options": provider_options,
            "models": models,
        }

        config: dict[str, Any] = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {route.key: provider_config},
            "model": self.model_name,
            # Defaults to the benchmark model for reproducibility; override with
            # OPENCODE_SMALL_MODEL=<provider>/<id> if summary/title work should
            # use a cheaper model.
            "small_model": small_model_name,
        }
        if mcp:
            config["mcp"] = mcp

        config = self._deep_merge(copy.deepcopy(self._DEFAULT_CONFIG), config)
        config = self._deep_merge(config, self._opencode_config)
        config_json = json.dumps(config, indent=2)
        command = (
            f"mkdir -p ~/.config/opencode && "
            f"echo {shlex.quote(config_json)} > ~/.config/opencode/opencode.json"
        )
        return command, selected_model.uses_reasoning

    def _build_env(self) -> dict[str, str]:
        route = self._provider_route(self.model_name)
        env = self._passthrough_env(keys=OPENCODE_RUNTIME_ENV_KEYS)
        api_key = self._required_env(route.api_key_env)
        env[route.api_key_env] = api_key
        env.setdefault("OPENCODE_FAKE_VCS", "git")
        self._scrub_extra_env(prefixes=("OPENCODE_",), allow_keys=OPENCODE_RUNTIME_ENV_KEYS)
        return env

    def _required_env(self, env_var: str) -> str:
        value = self._get_env(env_var)
        if not value:
            raise ValueError(
                f"{env_var} is required. Export it on the host and forward it with `--ae {env_var}=${env_var}`."
            )
        return value

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)
        small_model_name = self._small_model_name()
        route = self._provider_route(self.model_name)
        env = self._build_env()
        api_key = env[route.api_key_env]
        config_command, uses_reasoning = self._build_register_config_command(api_key, small_model_name)

        await self.exec_as_agent(
            environment,
            command=git_init_and_commit_baseline_command(workdir=""),
            env=env,
        )
        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)

        await self.exec_as_agent(environment, command=config_command, env=env)

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                f"opencode --model={shlex.quote(self.model_name or '')} "
                f"run --format=json{' --thinking' if uses_reasoning else ''} "
                f"--dangerously-skip-permissions -- "
                f"{escaped_instruction} "
                f"2>&1 </dev/null | stdbuf -oL tee /logs/agent/{shlex.quote(self._OUTPUT_FILENAME)}"
            ),
            env=env,
        )
