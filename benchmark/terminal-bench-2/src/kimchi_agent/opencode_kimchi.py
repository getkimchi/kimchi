import copy
import json
import os
import shlex
from typing import Any

import httpx
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError

KIMCHI_API = "https://llm.kimchi.dev"
KIMCHI_PROVIDER = "kimchi-dev"
KIMCHI_BASE_URL = f"{KIMCHI_API}/openai/v1"
KIMCHI_MODELS_METADATA_URL = f"{KIMCHI_API}/v1/models/metadata?include_in_cli=true"
KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"

FETCH_TIMEOUT_SEC = 5
SMALL_MODEL_ENV = "OPENCODE_SMALL_MODEL"


class KimchiModelLimits(BaseModel):
    model_config = ConfigDict(extra="ignore")

    context_window: StrictInt = Field(gt=0)
    max_output_tokens: StrictInt = Field(gt=0)


class KimchiModelMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    slug: str = Field(min_length=1)
    reasoning: StrictBool = False
    limits: KimchiModelLimits


class KimchiModelsMetadataResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    models: list[KimchiModelMetadata] = Field(min_length=1)


class OpenCodeKimchi(OpenCode):
    """Harbor OpenCode agent wired to the Kimchi OpenAI-compatible gateway.

    The model remains Harbor-configurable: pass ``--model kimchi-dev/<id>`` or
    set ``MODEL=kimchi-dev/<id>`` in the runner script. The adapter registers
    that selected model in OpenCode's config at runtime before invoking
    ``opencode run``.
    """

    @staticmethod
    def name() -> str:
        return "opencode-kimchi"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_metadata_cache: tuple[str, list[KimchiModelMetadata]] | None = None

    @staticmethod
    def _split_model(model_name: str | None) -> tuple[str, str]:
        if not model_name or "/" not in model_name:
            raise ValueError("--model is required and must use provider/model format, e.g. kimchi-dev/kimi-k2.5")
        provider, model_id = model_name.split("/", 1)
        if provider != KIMCHI_PROVIDER:
            raise ValueError(
                f"OpenCodeKimchi only supports {KIMCHI_PROVIDER}/<model-id> models; got {model_name!r}"
            )
        if not model_id:
            raise ValueError("--model must include a model id after kimchi-dev/")
        return provider, model_id

    def _fetch_model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        try:
            response = httpx.get(
                KIMCHI_MODELS_METADATA_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                timeout=FETCH_TIMEOUT_SEC,
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Failed to fetch Kimchi model metadata: HTTP {exc.response.status_code}") from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Failed to fetch Kimchi model metadata: {exc}") from exc

        try:
            metadata = KimchiModelsMetadataResponse.model_validate(body)
        except ValidationError as exc:
            raise RuntimeError(f"Failed to parse Kimchi model metadata: {exc}") from exc

        return metadata.models

    def _model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        if self._model_metadata_cache is None or self._model_metadata_cache[0] != api_key:
            self._model_metadata_cache = (api_key, self._fetch_model_metadata(api_key))
        return self._model_metadata_cache[1]

    def _model_metadata_for(self, api_key: str, model_name: str | None) -> KimchiModelMetadata:
        _, model_id = self._split_model(model_name)
        for model in self._model_metadata(api_key):
            if model.slug == model_id:
                return model
        raise ValueError(f"Model {model_name!r} was not returned by {KIMCHI_MODELS_METADATA_URL}")

    def _selected_model_metadata(self, api_key: str) -> KimchiModelMetadata:
        return self._model_metadata_for(api_key, self.model_name)

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

    def _build_register_config_command(self, api_key: str) -> str:
        _, model_id = self._split_model(self.model_name)
        small_model_name = self._small_model_name()
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
                        "baseURL": KIMCHI_BASE_URL,
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
        api_key = self._get_env(KIMCHI_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{KIMCHI_API_KEY_ENV} is required. Export it on the host and forward it with "
                f"`--ae {KIMCHI_API_KEY_ENV}=${KIMCHI_API_KEY_ENV}`."
            )
        env = self._passthrough_env(("OPENCODE_",))
        env.update({
            KIMCHI_API_KEY_ENV: api_key,
        })
        env.setdefault("OPENCODE_FAKE_VCS", "git")
        return env

    def _passthrough_env(self, prefixes: tuple[str, ...]) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if key.startswith(prefixes)}
        env.update({key: value for key, value in self._extra_env.items() if key.startswith(prefixes)})
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
        self._split_model(self.model_name)
        escaped_instruction = shlex.quote(instruction)
        env = self._build_env()
        api_key = env[KIMCHI_API_KEY_ENV]

        skills_command = self._build_register_skills_command()
        if skills_command:
            await self.exec_as_agent(environment, command=skills_command, env=env)

        await self.exec_as_agent(environment, command=self._build_register_config_command(api_key), env=env)

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
