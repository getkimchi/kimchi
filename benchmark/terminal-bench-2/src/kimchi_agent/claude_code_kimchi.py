import shlex

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from kimchi_agent.gateway import (
    KIMCHI_ANTHROPIC_BASE_URL,
    KimchiGatewayMixin,
    KimchiModelMetadata,
)

CLAUDE_CODE_AUTO_COMPACT_PERCENT = 92
CLAUDE_PASSTHROUGH_ENV_PREFIXES = ("CLAUDE_CODE_", "OTEL_")
CLAUDE_PASSTHROUGH_ENV_KEYS = {
    "API_TIMEOUT_MS",
    "MAX_THINKING_TOKENS",
}
BLOCKED_ENV_PREFIXES = ("BASH",)
DENIED_ENV_KEYS = {
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "DISABLE_PROMPT_CACHING",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_PROJECT",
}

FORCED_ENV_KEYS = {
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_CONFIG_DIR",
    "ENABLE_BACKGROUND_TASKS",
    "FORCE_AUTO_BACKGROUND_TASKS",
    "IS_SANDBOX",
}


class ClaudeCodeKimchi(KimchiGatewayMixin, ClaudeCode):
    """Harbor Claude Code agent wired to the Kimchi Anthropic gateway."""

    @staticmethod
    def name() -> str:
        return "claude-code-kimchi"

    @staticmethod
    def _auto_compact_window(model: KimchiModelMetadata) -> str:
        return str(max(1, model.limits.context_window * CLAUDE_CODE_AUTO_COMPACT_PERCENT // 100))

    def _build_env(self) -> dict[str, str]:
        api_key = self._required_kimchi_api_key()
        model = self._selected_model_metadata(api_key)
        model_id = model.slug
        env = self._passthrough_env(
            prefixes=CLAUDE_PASSTHROUGH_ENV_PREFIXES,
            keys=CLAUDE_PASSTHROUGH_ENV_KEYS,
            blocked_prefixes=BLOCKED_ENV_PREFIXES,
            blocked_keys=FORCED_ENV_KEYS | DENIED_ENV_KEYS,
        )
        env.update(self._resolved_env_vars)
        env.update({
            "ANTHROPIC_API_KEY": "",
            "ANTHROPIC_AUTH_TOKEN": api_key,
            "ANTHROPIC_BASE_URL": KIMCHI_ANTHROPIC_BASE_URL,
            "ANTHROPIC_MODEL": model_id,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model_id,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model_id,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model_id,
            "ANTHROPIC_SMALL_FAST_MODEL": model_id,
            "ANTHROPIC_CUSTOM_MODEL_OPTION": model_id,
            "CLAUDE_CODE_SUBAGENT_MODEL": model_id,
            "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_AUTO_COMPACT_WINDOW": self._auto_compact_window(model),
            "CLAUDE_CONFIG_DIR": (EnvironmentPaths.agent_dir / "sessions").as_posix(),
            "ENABLE_BACKGROUND_TASKS": "1",
            "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "IS_SANDBOX": "1",
        })
        env.update({key: "" for key in DENIED_ENV_KEYS})

        # Harbor merges _extra_env over env=. Remove keys from that channel so
        # per-call env= remains authoritative without copying secrets there.
        self._scrub_extra_env(
            keys=FORCED_ENV_KEYS | DENIED_ENV_KEYS,
            prefixes=BLOCKED_ENV_PREFIXES,
        )

        return {key: value for key, value in env.items() if value is not None}

    def _build_setup_command(self) -> str:
        setup_command = (
            "mkdir -p $CLAUDE_CONFIG_DIR/debug $CLAUDE_CONFIG_DIR/projects/-app "
            "$CLAUDE_CONFIG_DIR/shell-snapshots $CLAUDE_CONFIG_DIR/statsig "
            "$CLAUDE_CONFIG_DIR/todos $CLAUDE_CONFIG_DIR/skills && "
            "if [ -d ~/.claude/skills ]; then "
            "cp -r ~/.claude/skills/. $CLAUDE_CONFIG_DIR/skills/ 2>/dev/null || true; "
            "fi"
        )

        skills_command = self._build_register_skills_command()
        if skills_command:
            setup_command += f" && {skills_command}"

        memory_command = self._build_register_memory_command()
        if memory_command:
            setup_command += f" && {memory_command}"

        mcp_command = self._build_register_mcp_servers_command()
        if mcp_command:
            setup_command += f" && {mcp_command}"

        return setup_command

    def _build_run_command(self, instruction: str) -> str:
        cli_flags = self.build_cli_flags()
        extra_flags = (cli_flags + " ") if cli_flags else ""
        return (
            'export PATH="$HOME/.local/bin:$PATH"; '
            f"claude --verbose --output-format=stream-json "
            f"--permission-mode=bypassPermissions "
            f"{extra_flags}"
            f"--print -- {shlex.quote(instruction)} 2>&1 </dev/null | tee "
            "/logs/agent/claude-code.txt"
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._build_env()

        await self.exec_as_agent(
            environment,
            command=self._build_setup_command(),
            env=env,
        )
        await self.exec_as_agent(
            environment,
            command=self._build_run_command(instruction),
            env=env,
        )
