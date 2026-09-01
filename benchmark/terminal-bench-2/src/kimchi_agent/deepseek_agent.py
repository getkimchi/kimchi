"""DeepSeek Harness (dsh) adapter for terminal-bench.

Runs the ``dsh`` Node CLI in headless mode against the Kimchi OpenAI-compatible
gateway. The Kimchi gateway exposes DeepSeek's chat-completions API surface, so
the ``llm-deepseek`` plugin needs its ``baseURL`` and ``apiKeyEnv`` pointed at
``llm.kimchi.dev`` and a single-model catalog carrying the selected Kimchi
model's metadata (context window, max output, modalities). dsh's headless
profile accepts the task as a positional argument and exits 0 on success, 1 on
failure.
"""

import json
import shlex
from pathlib import Path
from typing import Any

from harbor.environments.base import BaseEnvironment
from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pydantic import ValidationError

from kimchi_agent.framework import HarborCompatMixin, agent_info_types
from kimchi_agent.gateway import (
    KIMCHI_API_KEY_ENV,
    KIMCHI_OPENAI_BASE_URL,
    KIMCHI_PROVIDER,
    KimchiGatewayMixin,
    KimchiModelMetadata,
)
from kimchi_agent.git_install import (
    GIT_INSTALL_COMMAND,
    GIT_INSTALL_ENV,
    git_config_command,
    git_init_and_commit_baseline_command,
)
from kimchi_agent.messages import SessionEntry

CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_DSH_HOME = "/tmp/terminal-bench-dsh-home"
DSH_OUTPUT_FILENAME = "dsh.txt"
DSH_EXIT_CODE_FILENAME = "dsh-exit-code.txt"
DSH_STATUS_FILENAME = "dsh-status.json"
DSH_INSTRUCTION_PATH = "/tmp/terminal-bench-dsh-instruction.md"
DSH_PATCH_PATH = "/tmp/dsh-kimchi-gateway.patch.json"
# dsh's llm-deepseek plugin id — the cordis config-node id from
# @deepseek-ai/dsh-llm-deepseek/src/index.ts.
DSH_LLM_PLUGIN_ID = "llm-deepseek"
# DeepSeek catalog models accept only text/image modalities — see the
# catalogModel schema in dsh-llm-deepseek/src/index.ts.
_DSH_MODEL_MODALITIES = ("text", "image")


class DeepSeekAgent(KimchiGatewayMixin, HarborCompatMixin, BaseInstalledAgent):
    """Harbor DeepSeek Harness agent wired to one selected Kimchi model.

    The ``PRESET`` class attribute selects which dsh configuration variant to
    use.  Subclasses override it (and ``name``) to produce the four shipped
    variants: standard, ptc, minimal, creator.
    """

    SUPPORTS_ATIF: bool = False
    PRESET: str = "standard"

    @staticmethod
    def name() -> str:
        return "deepseek"

    def to_agent_info(self):
        # Framework-matched types: each runner's TrialResult only accepts its
        # own AgentInfo, and the pier base class builds pier's type
        # unconditionally (see kimchi_agent.framework).
        AgentInfo, ModelInfo = agent_info_types()
        return AgentInfo(
            name=self.name(),
            version=self.version() or "unknown",
            model_info=(
                ModelInfo(
                    name=self._parsed_model_name,
                    provider=self._parsed_model_provider,
                )
                if self._parsed_model_name
                else None
            ),
        )

    def get_version_command(self) -> str | None:
        return 'export NVM_DIR="$HOME/.nvm"; [ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"; dsh --version'

    def install_spec(self) -> AgentInstallSpec:
        """Declarative install steps for Docker image fingerprinting.

        DeepSeek Harness's install is network-dependent (npm install, nvm) and
        cannot be fully expressed as cached Docker layers. The pure-shell
        git install step is declared for fingerprinting; the rest runs in
        :meth:`install` at setup time.
        """
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[
                InstallStep(user="root", run=git_config_command()),
            ],
            verification_command=self.get_version_command(),
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        """Override pier's setup to always run install().

        Pier's BaseInstalledAgent.setup() skips install() when the environment
        was pre-built with install_spec() steps inlined into the Dockerfile
        (is_preinstalled=True), accessing ``environment.agent_install_spec``
        which does not exist on Harbor's DockerEnvironment.  Harbor's own
        BaseInstalledAgent.setup() simply calls install() unconditionally.
        Mirror that behaviour so the agent works under Harbor.
        """
        await environment.exec(command="mkdir -p /installed-agent", user="root")

        setup_dir = self.logs_dir / "setup"
        setup_dir.mkdir(parents=True, exist_ok=True)

        try:
            await self.install(environment)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Agent install failed: {exc}") from exc

        if self._version is None:
            version_cmd = self.get_version_command()
            if version_cmd:
                try:
                    version_result = await environment.exec(command=version_cmd)
                    if version_result.return_code == 0 and version_result.stdout:
                        self._version = self.parse_version(version_result.stdout)
                except Exception:
                    pass  # Version detection is best-effort

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=GIT_INSTALL_COMMAND,
            env=GIT_INSTALL_ENV,
        )
        # Ensure curl is available for the nvm bootstrap on minimal base images.
        await self.exec_as_root(
            environment,
            command=(
                "command -v curl >/dev/null 2>&1"
                " || { if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y curl;"
                '  elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl;'
                '  elif command -v yum >/dev/null 2>&1; then yum install -y curl;'
                '  else echo "Error: cannot install curl" >&2; exit 1; fi; }'
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=git_config_command(),
        )

        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "node_major=0; "
                "if command -v node &>/dev/null && command -v npm &>/dev/null; then"
                "  node_major=$(node -v | sed -E 's/v([0-9]+).*/\\1/');"
                " fi; "
                "if [ \"$node_major\" -ge 22 ] 2>/dev/null; then"
                "  npm -v;"
                " else"
                "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash &&"
                '  export NVM_DIR="$HOME/.nvm" &&'
                '  \\. "$NVM_DIR/nvm.sh" || true &&'
                "  command -v nvm &>/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; } &&"
                "  nvm install 22 && nvm alias default 22 && npm -v;"
                " fi && "
                f"npm install -g @deepseek-ai/dsh{version_spec} && "
                # Patch the llm-deepseek translate module: the Kimchi gateway sends
                # function.name as null (not undefined) in subsequent tool-call
                # SSE deltas.  dsh's check `!== void 0` passes for null, overwriting
                # the tool name to null -> empty string -> "unknown tool".  Fix:
                # change the guard to `!= null` which skips both undefined and null.
                "translate_js=\"$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js\" && "
                "if [ -f \"$translate_js\" ]; then "
                "  sed -i 's/call.function?.name !== void 0/call.function?.name != null/g' \"$translate_js\"; "
                "fi && "
                "dsh --version"
            ),
        )

    @staticmethod
    def _dsh_input_modalities(model: KimchiModelMetadata) -> list[str]:
        allowed = [
            modality for modality in model.input_modalities if modality in _DSH_MODEL_MODALITIES
        ]
        return allowed or ["text"]

    def _dsh_model_entry(self, model: KimchiModelMetadata) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "id": model.slug,
            "name": model.display_name or model.slug,
            "contextWindow": model.limits.context_window,
            "maxTokens": model.limits.max_output_tokens,
            "inputModalities": self._dsh_input_modalities(model),
        }
        # The dsh llm-deepseek schema (catalogModel) does not declare a
        # per-model `reasoning` field; thinking policy lives at the plugin
        # level as `reasoningEffort`. Map the Kimchi metadata's boolean to
        # the closest dsh equivalent so reasoning-capable models keep their
        # default effort.
        if model.reasoning:
            entry["reasoningEffort"] = "high"
        return entry

    def _dsh_provider_config(self, model: KimchiModelMetadata) -> dict[str, Any]:
        config: dict[str, Any] = {
            "apiKeyEnv": KIMCHI_API_KEY_ENV,
            "baseURL": KIMCHI_OPENAI_BASE_URL,
            "models": [self._dsh_model_entry(model)],
        }
        if model.reasoning:
            config["thinking"] = "enabled"
        return config

    def _dsh_default_model_config(self, model: KimchiModelMetadata) -> dict[str, Any]:
        # dsh's agent-default-model expects the *internal* provider id that
        # the llm-deepseek plugin registers ("deepseek-official"), not the
        # upstream Kimchi gateway provider name.  Kimchi routing is configured
        # at the plugin level via baseURL + apiKeyEnv in _dsh_provider_config.
        # KIMCHI_PROVIDER is kept for validation/assertion consistency.
        assert KIMCHI_PROVIDER == "kimchi-dev"
        return {
            "provider": "deepseek-official",
            "model": model.slug,
        }

    def _tools_mode(self) -> str:
        """Return the dsh tools presentation mode for this preset."""
        if self.PRESET == "ptc":
            return "ptc"
        return "native"

    def _build_patch_json(self, model: KimchiModelMetadata) -> str:
        # dsh consumes a cordis patch list. Each entry targets a config node
        # by id and supplies its config overlay. ``agent-default-model``
        # selects the default route for headless Agents; ``llm-deepseek``
        # points the provider at the Kimchi gateway and ships the catalog.
        tools_mode = self._tools_mode()
        patch = [
            {"id": "agent-default-model", "config": self._dsh_default_model_config(model)},
            {"id": DSH_LLM_PLUGIN_ID, "config": self._dsh_provider_config(model)},
            # Set tools presentation mode (native or ptc) so the model sees
            # tool schemas in the right form for this preset.
            {"id": "tools", "config": {"mode": tools_mode}},
            # Auto-approve all tool calls — headless mode has no user to ask.
            {"id": "approval", "config": {"policy": "never"}},
        ]

        # Minimal preset: override system prompt persona and restrict tools
        # to bash + str-replace-editor only (deny everything else).
        if self.PRESET == "minimal":
            patch.append({
                "id": "system-prompt",
                "config": {
                    "persona": "You are a helpful software engineer assistant. Your working directory is {{cwd}}.",
                },
            })
            # Restrict the tool set to only bash and str-replace-editor.
            patch.append({
                "id": "tools",
                "config": {
                    "mode": "native",
                    "restrict": {
                        "allow": ["bash", "str_replace_editor"],
                    },
                },
            })

        # Creator (cordis) preset: override persona to mention runtime introspection.
        if self.PRESET == "cordis":
            patch.append({
                "id": "system-prompt",
                "config": {
                    "persona": (
                        "You are a coding agent powered by the {{model}} model. "
                        "Your working directory is {{cwd}}. "
                        "You have access to Cordis runtime introspection tools for self-modification."
                    ),
                },
            })

        return json.dumps(patch)

    def _build_patch_command(self, model: KimchiModelMetadata) -> str:
        patch_json = self._build_patch_json(model)
        return (
            f"mkdir -p {shlex.quote(CONTAINER_LOGS_DIR)} && "
            f"printf '%s\\n' {shlex.quote(patch_json)} > {shlex.quote(DSH_PATCH_PATH)}"
        )

    def _build_env(self) -> dict[str, str]:
        # The dsh llm-deepseek plugin resolves the bearer token through the
        # credential seam, which honors the apiKeyEnv string we set in the
        # patch. We mirror the Kimchi API key into DEEPSEEK_API_KEY as well
        # so any default DeepSeek codepath (env-only) keeps working without
        # the patch overlay.
        api_key = self._required_kimchi_api_key()
        return {
            KIMCHI_API_KEY_ENV: api_key,
            "DEEPSEEK_API_KEY": api_key,
            "DEEPSEEK_BASE_URL": KIMCHI_OPENAI_BASE_URL,
            "DSH_HOME": CONTAINER_DSH_HOME,
            # Tools presentation mode — ptc preset wraps tools under run_code.
            "DSH_TOOLS_MODE": self._tools_mode(),
            # Auto-approve all tool calls — headless mode has no interactive
            # user to confirm approvals.  danger-full-access also sets the
            # sandbox to full access and the approval policy to "never ask".
            "DSH_PERMISSION_MODE": "danger-full-access",
        }

    def _build_run_command(self, instruction: str, model: KimchiModelMetadata) -> str:
        instruction_text = (
            "Terminal Bench task. Work fully non-interactively. Do not ask the user questions.\n\n"
            f"{instruction}"
        )
        status_path = f"{CONTAINER_LOGS_DIR}/{DSH_STATUS_FILENAME}"
        return (
            f"mkdir -p {shlex.quote(CONTAINER_LOGS_DIR)} && "
            "project_dir=$(pwd -P) && "
            f"printf '%s' {shlex.quote(instruction_text)} > {shlex.quote(DSH_INSTRUCTION_PATH)} && "
            'export NVM_DIR="$HOME/.nvm" && '
            '[ ! -s "$NVM_DIR/nvm.sh" ] || . "$NVM_DIR/nvm.sh"; '
            # dsh --version is sourced through nvm; skip writing a redundant
            # version file but tolerate nvm load failures so the headless run
            # still gets a chance.
            "dsh --version >/dev/null 2>&1 || true; "
            f'echo "dsh preset: {self.PRESET}" > {shlex.quote(f"{CONTAINER_LOGS_DIR}/dsh-preset.txt")}; '
            f'echo "=== dsh preset: {self.PRESET} ===" >&2; '
            "status=0; "
            # dsh treats the launcher flags first and hands everything after
            # them to the headless app as inner args. The task is therefore
            # passed as one positional argument.
            # Use a direct redirect instead of tee/pipelines so the shell
            # keeps dsh's exit code; a pipeline would report the right side's
            # status instead.
            f"dsh --profile headless --patch {shlex.quote(DSH_PATCH_PATH)} "
            f'"$(cat {shlex.quote(DSH_INSTRUCTION_PATH)})" '
            f"> {shlex.quote(f'{CONTAINER_LOGS_DIR}/{DSH_OUTPUT_FILENAME}')} 2>&1 </dev/null "
            "|| status=$?; "
            f"printf '%s\\n' \"$status\" > {shlex.quote(f'{CONTAINER_LOGS_DIR}/{DSH_EXIT_CODE_FILENAME}')}; "
            "if [ \"$status\" -eq 0 ]; then dsh_status=success; else dsh_status=error; fi; "
            f"printf '{{\"status\":\"%s\",\"exit_code\":%s}}\\n' \"$dsh_status\" \"$status\" "
            f"> {shlex.quote(status_path)}; "
            # Drop dsh's managed home so it does not bloat the captured
            # logs. Session JSONL is harvested separately in
            # populate_context_post_run.
            f"rm -rf {shlex.quote(CONTAINER_DSH_HOME)}; "
            'exit "$status"'
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._build_env()
        api_key = env[KIMCHI_API_KEY_ENV]
        model = self._selected_model_metadata(api_key)

        await self.exec_as_agent(
            environment,
            command=self._build_patch_command(model),
            env=env,
        )
        await self.exec_as_agent(
            environment,
            command=git_init_and_commit_baseline_command(workdir=""),
            env=env,
        )
        await self.exec_as_agent(
            environment,
            command=self._build_run_command(instruction, model),
            env=env,
        )

    def _read_exit_status(self) -> dict[str, Any]:
        exit_code_path = self.logs_dir / DSH_EXIT_CODE_FILENAME
        if not exit_code_path.exists():
            return {}

        try:
            exit_code = int(exit_code_path.read_text().strip())
        except (OSError, ValueError):
            return {}

        status = "success" if exit_code == 0 else "error"
        return {"dsh_exit_code": exit_code, "dsh_status": status}

    def _dsh_session_files(self) -> list[Path]:
        candidates = [
            self.logs_dir / "dsh-sessions",
            self.logs_dir / ".dsh" / "sessions",
            self.logs_dir / ".sessions",
        ]
        files: list[Path] = []
        for sessions_dir in candidates:
            if not sessions_dir.is_dir():
                continue
            files.extend(sorted(sessions_dir.rglob("*.jsonl")))
        return files

    def _populate_token_context(self, context: AgentContext) -> None:
        session_files = self._dsh_session_files()
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
                    "Skipping unreadable dsh session file during token aggregation",
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
        # Do not parse dsh.txt here. It is a human transcript and can be large;
        # Terminal Bench correctness comes from the verifier, not ATIF tokens.


__all__ = [
    "DeepSeekAgent",
    "DeepSeekStandardAgent",
    "DeepSeekPtcAgent",
    "DeepSeekMinimalAgent",
    "DeepSeekCreatorAgent",
]


class DeepSeekStandardAgent(DeepSeekAgent):
    """DeepSeek Harness with the standard preset (native tools, all tools)."""

    PRESET = "standard"

    @staticmethod
    def name() -> str:
        return "deepseek-standard"


class DeepSeekPtcAgent(DeepSeekAgent):
    """DeepSeek Harness with the PTC preset (tools wrapped under run_code)."""

    PRESET = "ptc"

    @staticmethod
    def name() -> str:
        return "deepseek-ptc"


class DeepSeekMinimalAgent(DeepSeekAgent):
    """DeepSeek Harness with the minimal preset (bash + str-replace only)."""

    PRESET = "minimal"

    @staticmethod
    def name() -> str:
        return "deepseek-minimal"


class DeepSeekCreatorAgent(DeepSeekAgent):
    """DeepSeek Harness with the creator preset (standard + Cordis tools)."""

    PRESET = "cordis"

    @staticmethod
    def name() -> str:
        return "deepseek-creator"
