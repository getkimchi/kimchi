import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import ValidationError

from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KIMCHI_OPENAI_BASE_URL,
    KIMCHI_PROVIDER,
    KimchiGatewayMixin,
    KimchiModelMetadata,
)
from kimchi_agent.messages import SessionEntry

CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_GSD_HOME = "/tmp/terminal-bench-gsd-home"
CONTAINER_GSD_AGENT_DIR = f"{CONTAINER_GSD_HOME}/agent"
CONTAINER_GSD_SESSION_DIR = f"{CONTAINER_GSD_AGENT_DIR}/sessions"
CONTAINER_CAPTURED_SESSION_DIR = f"{CONTAINER_LOGS_DIR}/gsd-sessions"
# Keep the transcript as text. GSD JSON mode emits repeated partial state that
# can grow to many GB, while Terminal Bench scoring only needs verifier results
# plus the exit/status artifacts below.
GSD_OUTPUT_FILENAME = "gsd.txt"
GSD_VERSION_FILENAME = "gsd-version.txt"
GSD_EXIT_CODE_FILENAME = "gsd-exit-code.txt"
GSD_STATUS_FILENAME = "gsd-status.json"
GSD_INSTRUCTION_PATH = "/tmp/terminal-bench-gsd-instruction.md"

# gsd-pi exits 10 when a headless run becomes blocked. Harbor should still run
# task verification, but the adapter preserves the blocked status in artifacts.
GSD_BLOCKED_EXIT_CODE = 10
GSD_MODEL_API = "openai-completions"
GSD_COST_FREE = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
GSD_ROLE_KEYS = (
    "research",
    "planning",
    "discuss",
    "execution",
    "execution_simple",
    "completion",
    "validation",
    "subagent",
)


class GsdKimchi(KimchiGatewayMixin, BaseInstalledAgent):
    """Harbor GSD agent wired to one selected Kimchi OpenAI-compatible model."""

    SUPPORTS_ATIF: bool = False

    @staticmethod
    def name() -> str:
        return "gsd-kimchi"

    def get_version_command(self) -> str | None:
        return 'export NVM_DIR="$HOME/.nvm"; [ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"; gsd --version'

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apk &> /dev/null; then"
                "  apk add --no-cache curl bash git nodejs npm;"
                " elif command -v apt-get &> /dev/null; then"
                "  apt-get update && apt-get install -y curl git;"
                " elif command -v yum &> /dev/null; then"
                "  yum install -y curl git;"
                " else"
                '  echo "Warning: No known package manager found, assuming curl is available" >&2;'
                " fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v node &>/dev/null && command -v npm &>/dev/null; then"
                "  npm -v;"
                " else"
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash &&"
                '  export NVM_DIR="$HOME/.nvm" &&'
                '  \\. "$NVM_DIR/nvm.sh" || true &&'
                "  command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } &&"
                "  nvm install 22 && nvm alias default 22 && npm -v;"
                " fi && "
                f"npm install -g gsd-pi{version_spec} && "
                "gsd --version"
            ),
        )

    @staticmethod
    def _model_ref(model: KimchiModelMetadata) -> str:
        return f"{KIMCHI_PROVIDER}/{model.slug}"

    @staticmethod
    def _gsd_input_modalities(model: KimchiModelMetadata) -> list[str]:
        allowed = [modality for modality in model.input_modalities if modality in {"text", "image"}]
        return allowed or ["text"]

    def _models_config(self, model: KimchiModelMetadata) -> dict[str, Any]:
        return {
            "providers": {
                KIMCHI_PROVIDER: {
                    "name": "Kimchi Dev",
                    "baseUrl": KIMCHI_OPENAI_BASE_URL,
                    "apiKey": KIMCHI_API_KEY_ENV,
                    "api": GSD_MODEL_API,
                    "models": [
                        {
                            "id": model.slug,
                            "name": model.display_name or model.slug,
                            "contextWindow": model.limits.context_window,
                            "maxTokens": model.limits.max_output_tokens,
                            "reasoning": model.reasoning,
                            "input": self._gsd_input_modalities(model),
                            "cost": GSD_COST_FREE,
                        }
                    ],
                }
            }
        }

    def _settings_config(self, model: KimchiModelMetadata) -> dict[str, Any]:
        return {
            "defaultProvider": KIMCHI_PROVIDER,
            "defaultModel": model.slug,
            "quietStartup": True,
            "collapseChangelog": True,
        }

    def _preferences(self, model: KimchiModelMetadata) -> str:
        model_ref = self._model_ref(model)
        role_lines = "\n".join(f"  {role}: {model_ref}" for role in GSD_ROLE_KEYS)
        return f"""---
version: 1
models:
{role_lines}
auto_supervisor:
  model: {model_ref}
dynamic_routing:
  enabled: false
  tier_models:
    light: {model_ref}
    standard: {model_ref}
    heavy:
      - {model_ref}
  budget_pressure: false
token_profile: balanced
skill_discovery: suggest
git:
  isolation: worktree
  merge_strategy: squash
---
"""

    def _build_config_command(self, model: KimchiModelMetadata) -> str:
        models_json = json.dumps(self._models_config(model), indent=2)
        settings_json = json.dumps(self._settings_config(model), indent=2)
        preferences = self._preferences(model)
        return (
            f"mkdir -p {shlex.quote(CONTAINER_GSD_AGENT_DIR)} {shlex.quote(CONTAINER_GSD_HOME)} && "
            f"printf '%s\\n' {shlex.quote(models_json)} > "
            f"{shlex.quote(f'{CONTAINER_GSD_AGENT_DIR}/models.json')} && "
            f"printf '%s\\n' {shlex.quote(settings_json)} > "
            f"{shlex.quote(f'{CONTAINER_GSD_AGENT_DIR}/settings.json')} && "
            f"printf '%s\\n' {shlex.quote(preferences)} > "
            f"{shlex.quote(f'{CONTAINER_GSD_HOME}/preferences.md')}"
        )

    def _build_run_command(self, instruction: str, model: KimchiModelMetadata) -> str:
        instruction_text = (
            "Terminal Bench task. Work fully non-interactively. Do not ask the user questions.\n\n"
            f"{instruction}"
        )
        model_ref = self._model_ref(model)
        status_path = f"{CONTAINER_LOGS_DIR}/{GSD_STATUS_FILENAME}"
        gsd_snapshot_path = f"{CONTAINER_LOGS_DIR}/gsd"
        return (
            f"mkdir -p {shlex.quote(CONTAINER_LOGS_DIR)} "
            f"{shlex.quote(CONTAINER_GSD_SESSION_DIR)} "
            f"{shlex.quote(CONTAINER_CAPTURED_SESSION_DIR)} && "
            "project_dir=$(pwd -P) && "
            f"printf '%s' {shlex.quote(instruction_text)} > {shlex.quote(GSD_INSTRUCTION_PATH)} && "
            'export NVM_DIR="$HOME/.nvm" && '
            '[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"; '
            f"gsd --version > {shlex.quote(f'{CONTAINER_LOGS_DIR}/{GSD_VERSION_FILENAME}')} 2>&1 || true; "
            "status=0; "
            # GSD/pi ignores positional args that start with "-", and its parser
            # does not treat "--" as an end-of-options marker. The instruction is
            # therefore prefixed above and passed as one positional argument.
            # Use a direct redirect instead of tee/pipelines so the shell keeps
            # GSD's exit code; a pipeline would report tee's status instead.
            f"gsd --mode text --print --model {shlex.quote(model_ref)} "
            f'"$(cat {shlex.quote(GSD_INSTRUCTION_PATH)})" '
            f"> {shlex.quote(f'{CONTAINER_LOGS_DIR}/{GSD_OUTPUT_FILENAME}')} 2>&1 </dev/null "
            "|| status=$?; "
            f"printf '%s\\n' \"$status\" > {shlex.quote(f'{CONTAINER_LOGS_DIR}/{GSD_EXIT_CODE_FILENAME}')}; "
            f"if [ \"$status\" -eq 0 ]; then gsd_status=success; "
            f"elif [ \"$status\" -eq {GSD_BLOCKED_EXIT_CODE} ]; then gsd_status=blocked; "
            "else gsd_status=error; fi; "
            f"printf '{{\"status\":\"%s\",\"exit_code\":%s}}\\n' \"$gsd_status\" \"$status\" "
            f"> {shlex.quote(status_path)}; "
            # GSD has to populate its managed runtime home on launch. Keep that
            # home in /tmp, then preserve only session JSONL needed for tokens.
            f"rm -rf {shlex.quote(CONTAINER_CAPTURED_SESSION_DIR)} && "
            f"if [ -d {shlex.quote(CONTAINER_GSD_SESSION_DIR)} ]; then "
            f"mkdir -p {shlex.quote(CONTAINER_CAPTURED_SESSION_DIR)} && "
            f"cp -a {shlex.quote(f'{CONTAINER_GSD_SESSION_DIR}/.')} "
            f"{shlex.quote(CONTAINER_CAPTURED_SESSION_DIR)}; fi; "
            f"rm -rf {shlex.quote(CONTAINER_GSD_HOME)}; "
            f"rm -rf {shlex.quote(gsd_snapshot_path)} && "
            f"if [ -d \"$project_dir/.gsd\" ]; then cp -a \"$project_dir/.gsd\" "
            f"{shlex.quote(gsd_snapshot_path)}; fi; "
            f"if [ \"$status\" -eq {GSD_BLOCKED_EXIT_CODE} ]; then exit 0; fi; "
            'exit "$status"'
        )

    def _build_env(self) -> dict[str, str]:
        return {
            KIMCHI_API_KEY_ENV: self._required_kimchi_api_key(),
            # GSD 3.x derives the embedded pi agent dir from GSD_HOME; older
            # gsd-pi builds used PI_CODING_AGENT_DIR directly. Pin both paths
            # to a temporary home and copy only sessions into Harbor logs.
            "GSD_HOME": CONTAINER_GSD_HOME,
            "GSD_CODING_AGENT_DIR": CONTAINER_GSD_AGENT_DIR,
            "PI_CODING_AGENT_DIR": CONTAINER_GSD_AGENT_DIR,
        }

    def _force_session_env(self) -> None:
        # Harbor merges _extra_env over env= at exec time. Keep GSD's managed
        # home temporary even if --ae passes the same keys.
        self._extra_env["GSD_HOME"] = CONTAINER_GSD_HOME
        self._extra_env["GSD_CODING_AGENT_DIR"] = CONTAINER_GSD_AGENT_DIR
        self._extra_env["PI_CODING_AGENT_DIR"] = CONTAINER_GSD_AGENT_DIR

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._build_env()
        self._force_session_env()
        api_key = env[KIMCHI_API_KEY_ENV]
        model = self._selected_model_metadata(api_key)

        await self.exec_as_agent(
            environment,
            command=self._build_config_command(model),
            env=env,
        )
        await self.exec_as_agent(
            environment,
            command=self._build_run_command(instruction, model),
            env=env,
        )

    def _read_exit_status(self) -> dict[str, Any]:
        exit_code_path = self.logs_dir / GSD_EXIT_CODE_FILENAME
        if not exit_code_path.exists():
            return {}

        try:
            exit_code = int(exit_code_path.read_text().strip())
        except (OSError, ValueError):
            return {}

        if exit_code == GSD_BLOCKED_EXIT_CODE:
            status = "blocked"
        elif exit_code == 0:
            status = "success"
        else:
            status = "error"
        return {"gsd_exit_code": exit_code, "gsd_status": status}

    def _session_files(self) -> list[Path]:
        sessions_dir = self.logs_dir / "gsd-sessions"
        if not sessions_dir.is_dir():
            return []
        return sorted(sessions_dir.rglob("*.jsonl"))

    def _populate_token_context(self, context: AgentContext) -> None:
        session_files = self._session_files()
        if not session_files:
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        for session_file in session_files:
            try:
                with session_file.open(encoding="utf-8") as handle:
                    for raw_line in handle:
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            entry = SessionEntry.model_validate_json(line)
                        except ValidationError:
                            continue
                        if entry.type != "message" or entry.message.role != "assistant":
                            continue
                        usage = entry.message.usage
                        total_input_tokens += usage.input
                        total_output_tokens += usage.output
                        total_cache_read_tokens += usage.cache_read
                        total_cache_write_tokens += usage.cache_write
                        total_cost += usage.cost.total
            except OSError as exc:
                self.logger.warning(
                    "Skipping unreadable GSD/pi session file during token aggregation",
                    extra={"path": str(session_file), "error": str(exc)},
                )
                continue

        # pi-ai treats input, cacheRead, cacheWrite as disjoint summing to totalTokens.
        context.n_input_tokens = total_input_tokens + total_cache_read_tokens + total_cache_write_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None

    def populate_context_post_run(self, context: AgentContext) -> None:
        exit_status = self._read_exit_status()
        if exit_status:
            context.metadata = {**(context.metadata or {}), **exit_status}
        self._populate_token_context(context)
        # Do not parse gsd.txt here. It is a human transcript and can be large;
        # Terminal Bench correctness comes from the verifier, not ATIF tokens.
