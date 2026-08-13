import copy
import json
import shlex
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

SMALL_MODEL_ENV = "OPENCODE_SMALL_MODEL"
OPENCODE_RUNTIME_ENV_KEYS = {
    "OPENCODE_CLIENT",
    "OPENCODE_FAKE_VCS",
}

OPENROUTER_PROVIDER = "openrouter"
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_PROVIDER_NAME = "openrouter"

ZAI_PROVIDER = "zai"
ZAI_API_KEY_ENV = "ZAI_API_KEY"
ZAI_BASE_URL = "https://api.z.ai/api/paas/v4"
ZAI_PROVIDER_NAME = "zai"

# Static metadata for models routed directly to a third-party provider,
# bypassing the Kimchi gateway. The Kimchi metadata API cannot describe
# third-party providers, so known models are listed here. tool_call is
# assumed True (the models we benchmark all support tool use).
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

# docs.z.ai/guides/llm/glm-5.2 (2026-08-13): 1M context, 128K max output,
# thinking enabled by default.
_ZAI_MODEL_METADATA: dict[str, dict[str, Any]] = {
    "glm-5.2": {
        "reasoning": True,
        "context_window": 1_000_000,
        "max_output_tokens": 131_072,
    },
}

# Direct (non-gateway) providers opencode can route to. Each entry names the
# API-key env var, the OpenAI-compatible base URL, the opencode provider id
# and display name, and the static metadata table above.
_DIRECT_PROVIDERS: dict[str, dict[str, Any]] = {
    OPENROUTER_PROVIDER: {
        "key_env": OPENROUTER_API_KEY_ENV,
        "base_url": OPENROUTER_BASE_URL,
        "provider_key": OPENROUTER_PROVIDER_NAME,
        "provider_name": "OpenRouter",
        "models": _OPENROUTER_MODEL_METADATA,
    },
    ZAI_PROVIDER: {
        "key_env": ZAI_API_KEY_ENV,
        "base_url": ZAI_BASE_URL,
        "provider_key": ZAI_PROVIDER_NAME,
        "provider_name": "Z.AI",
        "models": _ZAI_MODEL_METADATA,
    },
}


class OpenCodeKimchi(KimchiGatewayMixin, OpenCode):
    """Harbor OpenCode agent wired to an OpenAI-compatible gateway.

    Supports two provider modes selected by the ``--model`` prefix:

    * ``kimchi-dev/<id>`` — routes through the Kimchi gateway. Model metadata
      (context window, output limits, reasoning) is fetched from the Kimchi
      metadata API.
    * ``openrouter/<id>`` — routes through OpenRouter directly. Metadata for
      known models is looked up from a static table; the OpenRouter API key
      is injected from ``OPENROUTER_API_KEY``.
    * ``zai/<id>`` — routes through Z.AI's OpenAI-compatible API directly.
      Metadata comes from the static table; the key is injected from
      ``ZAI_API_KEY``.

    The adapter registers the selected model in OpenCode's config at runtime
    before invoking ``opencode run``.
    """

    @staticmethod
    def _direct_provider(model_name: str | None) -> str | None:
        """The direct-provider prefix of ``model_name``, or None for the gateway."""
        if not model_name:
            return None
        provider, _, _ = model_name.partition("/")
        return provider if provider in _DIRECT_PROVIDERS else None

    def _split_direct_model(self, model_name: str | None) -> tuple[dict[str, Any], str]:
        """``(provider spec, model id)`` for a direct-provider model name."""
        provider = self._direct_provider(model_name)
        if model_name is None or provider is None:
            raise ValueError(
                f"{type(self).__name__} expected a direct-provider model "
                f"({'/'.join(sorted(_DIRECT_PROVIDERS))}/*); got {model_name!r}"
            )
        _, model_id = model_name.split("/", 1)
        if not model_id:
            raise ValueError(f"--model must include a model id after {provider}/")
        return _DIRECT_PROVIDERS[provider], model_id

    def _direct_model_config(self, model_name: str | None) -> dict[str, Any]:
        """Build static model config for a direct-provider model."""
        spec, model_id = self._split_direct_model(model_name)
        meta = spec["models"].get(model_id)
        if meta is None:
            raise ValueError(
                f"{spec['provider_name']} model {model_id!r} is not in the static metadata table. "
                f"Known models: {', '.join(sorted(spec['models']))}"
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

    def _model_config(self, api_key: str, model_name: str | None) -> dict[str, Any]:
        if self._direct_provider(model_name) is not None:
            return self._direct_model_config(model_name)
        model = self._model_metadata_for(api_key, model_name)
        return {
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

    def _selected_model_config(self, api_key: str) -> dict[str, Any]:
        return self._model_config(api_key, self.model_name)

    def _small_model_name(self) -> str | None:
        return self._get_env(SMALL_MODEL_ENV) or self.model_name

    def _build_register_config_command(self, api_key: str, small_model_name: str | None = None) -> str:
        direct_provider = self._direct_provider(self.model_name)
        small_model_name = small_model_name or self._small_model_name()
        if direct_provider is not None:
            _, model_id = self._split_direct_model(self.model_name)
        else:
            _, model_id = self._split_model(self.model_name)
        models = {model_id: self._selected_model_config(api_key)}
        if small_model_name != self.model_name:
            if self._direct_provider(small_model_name) is not None:
                _, small_model_id = self._split_direct_model(small_model_name)
                models[small_model_id] = self._direct_model_config(small_model_name)
            else:
                _, small_model_id = self._split_model(small_model_name)
                models[small_model_id] = self._model_config(api_key, small_model_name)

        mcp: dict[str, dict[str, Any]] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                cmd_list = [server.command, *server.args] if server.command else []
                mcp[server.name] = {"type": "local", "command": cmd_list}
            else:
                mcp[server.name] = {"type": "remote", "url": server.url}

        if direct_provider is not None:
            spec = _DIRECT_PROVIDERS[direct_provider]
            provider_key = spec["provider_key"]
            provider_config: dict[str, Any] = {
                "npm": "@ai-sdk/openai-compatible",
                "name": spec["provider_name"],
                "options": {
                    "baseURL": spec["base_url"],
                    "apiKey": f"{{env:{spec['key_env']}}}",
                },
                "models": models,
            }
        else:
            provider_key = KIMCHI_PROVIDER
            provider_config = {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Kimchi",
                "options": {
                    "baseURL": KIMCHI_OPENAI_BASE_URL,
                    # kimchi: the gateway is served through LiteLLM, matching
                    # the first-party Kimchi OpenCode provider integration.
                    "litellmProxy": True,
                    "apiKey": f"{{env:{KIMCHI_API_KEY_ENV}}}",
                },
                "models": models,
            }

        config: dict[str, Any] = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {provider_key: provider_config},
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
        return f"mkdir -p ~/.config/opencode && echo {shlex.quote(config_json)} > ~/.config/opencode/opencode.json"

    def _build_env(self) -> dict[str, str]:
        direct_provider = self._direct_provider(self.model_name)
        env = self._passthrough_env(keys=OPENCODE_RUNTIME_ENV_KEYS)
        if direct_provider is not None:
            key_env = _DIRECT_PROVIDERS[direct_provider]["key_env"]
            env.update({key_env: self._required_env(key_env)})
        else:
            env.update({KIMCHI_API_KEY_ENV: self._required_kimchi_api_key()})
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

    def _thinking_flag(self, api_key: str) -> str:
        if self._direct_provider(self.model_name) is not None:
            spec, model_id = self._split_direct_model(self.model_name)
            meta = spec["models"].get(model_id)
            return " --thinking" if meta and meta["reasoning"] else ""
        return " --thinking" if self._selected_model_metadata(api_key).reasoning else ""

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped_instruction = shlex.quote(instruction)
        small_model_name = self._small_model_name()
        env = self._build_env()
        direct_provider = self._direct_provider(self.model_name)
        api_key = (
            env[_DIRECT_PROVIDERS[direct_provider]["key_env"]]
            if direct_provider is not None
            else env[KIMCHI_API_KEY_ENV]
        )
        config_command = self._build_register_config_command(api_key, small_model_name)

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
                f"run --format=json{self._thinking_flag(api_key)} --dangerously-skip-permissions -- "
                f"{escaped_instruction} "
                f"2>&1 </dev/null | stdbuf -oL tee /logs/agent/{shlex.quote(self._OUTPUT_FILENAME)}"
            ),
            env=env,
        )
