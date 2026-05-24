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

SMALL_MODEL_ENV = "OPENCODE_SMALL_MODEL"
OPENCODE_RUNTIME_ENV_KEYS = {
    "OPENCODE_CLIENT",
    "OPENCODE_FAKE_VCS",
}


class OpenCodeKimchi(KimchiGatewayMixin, OpenCode):
    """Harbor OpenCode agent wired to the Kimchi OpenAI-compatible gateway.

    The model remains Harbor-configurable: pass ``--model kimchi-dev/<id>`` or
    set ``MODEL=kimchi-dev/<id>`` in the runner script. The adapter registers
    that selected model in OpenCode's config at runtime before invoking
    ``opencode run``.
    """

    @staticmethod
    def name() -> str:
        return "opencode-kimchi"

    def _model_config(self, api_key: str, model_name: str | None) -> dict[str, Any]:
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
        _, model_id = self._split_model(self.model_name)
        small_model_name = small_model_name or self._small_model_name()
        _, small_model_id = self._split_model(small_model_name)
        models = {model_id: self._selected_model_config(api_key)}
        if small_model_id != model_id:
            models[small_model_id] = self._model_config(api_key, small_model_name)

        mcp: dict[str, dict[str, Any]] = {}
        for server in self.mcp_servers:
            if server.transport == "stdio":
                cmd_list = [server.command, *server.args] if server.command else []
                mcp[server.name] = {"type": "local", "command": cmd_list}
            else:
                mcp[server.name] = {"type": "remote", "url": server.url}

        config: dict[str, Any] = {
            "$schema": "https://opencode.ai/config.json",
            "provider": {
                KIMCHI_PROVIDER: {
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
            },
            "model": self.model_name,
            # Defaults to the benchmark model for reproducibility; override with
            # OPENCODE_SMALL_MODEL=kimchi-dev/<id> if summary/title work should
            # use a cheaper Kimchi model.
            "small_model": small_model_name,
        }
        if mcp:
            config["mcp"] = mcp

        config = self._deep_merge(copy.deepcopy(self._DEFAULT_CONFIG), config)
        config = self._deep_merge(config, self._opencode_config)
        config_json = json.dumps(config, indent=2)
        return f"mkdir -p ~/.config/opencode && echo {shlex.quote(config_json)} > ~/.config/opencode/opencode.json"

    def _build_env(self) -> dict[str, str]:
        api_key = self._required_kimchi_api_key()
        env = self._passthrough_env(keys=OPENCODE_RUNTIME_ENV_KEYS)
        env.update({
            KIMCHI_API_KEY_ENV: api_key,
        })
        env.setdefault("OPENCODE_FAKE_VCS", "git")
        self._scrub_extra_env(prefixes=("OPENCODE_",), allow_keys=OPENCODE_RUNTIME_ENV_KEYS)
        return env

    def _thinking_flag(self, api_key: str) -> str:
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
        api_key = env[KIMCHI_API_KEY_ENV]
        config_command = self._build_register_config_command(api_key, small_model_name)

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
