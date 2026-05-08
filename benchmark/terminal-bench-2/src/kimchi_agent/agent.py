import shlex
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from pydantic import ValidationError

from kimchi_agent.config import KimchiAgentConfig
from kimchi_agent.messages import SessionEntry
from kimchi_agent.release import BINARY_RELPATH, SHARE_RELPATH, GitHubClient

if TYPE_CHECKING:
    from harbor.environments.base import BaseEnvironment
    from harbor.models.agent.context import AgentContext


# The release tarball (and local `pnpm run build:binary` output) is laid out as
# `bin/kimchi` + `share/kimchi/{package.json, theme/, export-html/}`. We
# preserve that layout under /installed-agent so the binary can find its auxiliary
# files via PI_PACKAGE_DIR (see src/entry.ts → resolveAuxiliaryFilesDir).
INSTALL_DIR = "/installed-agent"
BINARY_PATH = f"{INSTALL_DIR}/{BINARY_RELPATH.as_posix()}"
PI_PACKAGE_DIR = f"{INSTALL_DIR}/{SHARE_RELPATH.as_posix()}"
UPLOAD_STAGE_DIR = "/tmp/kimchi-stage"

# In-container paths. /logs/agent is bind-mounted to self.logs_dir on the host.
CONTAINER_LOGS_DIR = "/logs/agent"
CONTAINER_SESSIONS_DIR = f"{CONTAINER_LOGS_DIR}/sessions"
CONTAINER_MAIN_SESSION = f"{CONTAINER_SESSIONS_DIR}/main.jsonl"


class Kimchi(BaseInstalledAgent):
    """Harbor agent that runs the kimchi binary inside the task container.

    Binary source:
        1. If ``KIMCHI_CODE_BINARY`` is set on the host, that file is uploaded.
        2. Otherwise, the latest GitHub release from ``castai/kimchi`` is
           downloaded, sha256-verified, and extracted on the host, then uploaded.

    Model routing is always via the Kimchi LLM gateway (``https://llm.kimchi.dev``) using ``KIMCHI_API_KEY``;
    no provider-specific keys are needed.
    """

    CLI_FLAGS: ClassVar[list[CliFlag]] = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh"],
        ),
        CliFlag("tools", cli="--tools", type="str"),
        CliFlag("yolo", cli="--yolo", type="bool"),
        CliFlag(
            "disable-multi-model",
            cli="--multi-model=false",
            type="bool",
        ),
        CliFlag(
            "dangerously-skip-permissions",
            cli="--dangerously-skip-permissions",
            type="bool",
            default=True,
        ),
    ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._config = KimchiAgentConfig()

    @staticmethod
    def name() -> str:
        return "kimchi"

    def get_version_command(self) -> str | None:
        # PI_PACKAGE_DIR tells entry.ts where to find package.json + theme/; without it
        # the binary falls back to $XDG_DATA_HOME/$HOME and errors out before printing the version.
        return f"PI_PACKAGE_DIR={shlex.quote(PI_PACKAGE_DIR)} {shlex.quote(BINARY_PATH)} --version"

    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    async def install(self, environment: BaseEnvironment) -> None:
        host_stage_dir = await self._resolve_host_stage_dir(environment)
        # Upload the stage dir verbatim. It contains bin/kimchi and
        # share/kimchi/{package.json, theme/, export-html/} — resolved at runtime via PI_PACKAGE_DIR.
        await environment.upload_dir(source_dir=host_stage_dir, target_dir=UPLOAD_STAGE_DIR)
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {INSTALL_DIR} && "
                f"cp -a {shlex.quote(UPLOAD_STAGE_DIR)}/. {shlex.quote(INSTALL_DIR)}/ && "
                f"chmod 0755 {shlex.quote(BINARY_PATH)} && "
                f"rm -rf {shlex.quote(UPLOAD_STAGE_DIR)}"
            ),
        )

    async def _resolve_host_stage_dir(self, environment: BaseEnvironment) -> Path:
        """Return the host directory to upload — a ``bin/`` + ``share/kimchi/`` tree."""
        if self._config.binary_path is not None:
            # KIMCHI_CODE_BINARY points at the binary (e.g. dist/bin/kimchi). The stage dir is
            # the tarball-layout root two levels up (e.g. dist/), which also holds share/kimchi/.
            stage_dir = self._config.binary_path.parent.parent
            share_marker = stage_dir / SHARE_RELPATH / "package.json"
            if not share_marker.is_file():
                raise RuntimeError(
                    f"Expected auxiliary files at {share_marker} alongside the binary at "
                    f"{self._config.binary_path}. Run `pnpm run build:binary` (or build:binary-linux-x64) "
                    "to produce the full bin/ + share/ layout."
                )
            return stage_dir
        arch = await self._detect_container_arch(environment)
        with GitHubClient(token=self._config.github_token) as gh:
            release = gh.resolve_latest(self._config.github_repo)
            self.logger.info(
                "Fetching kimchi release",
                extra={"tag": release.tag_name, "arch": arch, "repo": self._config.github_repo},
            )
            return gh.download_and_extract(release, arch)

    async def _detect_container_arch(self, environment: BaseEnvironment) -> str:
        # Read e_machine (1 byte at offset 18) from /bin/sh's ELF header. uname -m reports
        # the kernel arch, which under Docker Desktop Rosetta on Apple Silicon is arm64
        # even when the userland is amd64. The dynamic loader only honors the userland
        # arch, so we read it directly from a binary that's guaranteed to exist.
        result = await self.exec_as_agent(environment, command="od -An -t x1 -j 18 -N 1 /bin/sh")
        e_machine = (result.stdout or "").strip().lower()
        match e_machine:
            case "3e":
                return "amd64"
            case "b7":
                return "arm64"
            case _:
                raise RuntimeError(
                    f"Unsupported container arch (ELF e_machine=0x{e_machine or '??'}); "
                    "kimchi release assets only cover amd64/arm64"
                )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError(
                "--model is required and must be qualified with a provider "
                "(e.g. kimchi-dev/kimi-k2.5, kimchi-dev/glm-5-fp8, kimchi-dev/minimax-m2.7)"
            )
        if "/" not in self.model_name:
            # kimchi's built-in pi-ai catalog also registers models like kimi-k2.5 under
            # the opencode provider. Without a qualifier the resolver may pick opencode and
            # fail auth with the kimchi key, so we force the caller to be explicit.
            raise ValueError(
                f"--model must be qualified as <provider>/<id> (got {self.model_name!r}); use e.g. kimchi-dev/kimi-k2.5"
            )

        cli_flags = self.build_cli_flags()
        if cli_flags:
            cli_flags += " "

        # Harbor's _exec merges _extra_env *over* env=, so the merged value must live
        # in _extra_env to win. Idempotent: a second run() sees the merged string as
        # "user tags", finds all auto keys collide, and produces the same output.
        user_tags = self._extra_env.get("KIMCHI_TAGS", "")
        self._extra_env["KIMCHI_TAGS"] = self._merge_kimchi_tags(user_tags)

        # Pipe the prompt via stdin instead of as a positional arg: pi-coding-agent's
        # parseArgs treats any token starting with `-` as a flag (no `--` end-of-options
        # marker), which deterministically crashes on instructions like "- You are given...".
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {CONTAINER_SESSIONS_DIR} && "
                f"printf '%s' {shlex.quote(instruction)} | "
                f"{shlex.quote(BINARY_PATH)} "
                f"--print --session {CONTAINER_MAIN_SESSION} "
                f"--model {shlex.quote(self.model_name)} "
                f"{cli_flags}"
            ),
            env={"KIMCHI_API_KEY": self._config.api_key, "PI_PACKAGE_DIR": PI_PACKAGE_DIR},
        )

    def _auto_tags(self) -> dict[str, str]:
        # logs_dir is expected to be jobs/<run>/<task>__<trial>/agent. Derive
        # run / task / trial from that ancestry so they're injected automatically
        # and survive glob / full-dataset runs where the user can't statically
        # know the task name.
        trial_dir = self.logs_dir.parent
        run_dir = trial_dir.parent
        if self.logs_dir.name != "agent" or run_dir.parent.name != "jobs":
            self.logger.debug(
                "Skipping auto KIMCHI_TAGS; logs_dir does not match jobs/<run>/<task>__<trial>/agent",
                extra={"logs_dir": str(self.logs_dir)},
            )
            return {}
        trial_id = trial_dir.name
        return {
            "run": run_dir.name,
            "task": trial_id.split("__", 1)[0],
            "trial": trial_id,
        }

    def _merge_kimchi_tags(self, user_raw: str) -> str:
        # User-supplied values via --ae KIMCHI_TAGS=... win on key collision.
        user_raw = user_raw.strip()
        user_keys: set[str] = set()
        for tag in user_raw.split(","):
            if ":" not in tag:
                continue
            key = tag.split(":", 1)[0].strip()
            if key:
                user_keys.add(key)

        merged = [f"{k}:{v}" for k, v in self._auto_tags().items() if k not in user_keys]
        if user_raw:
            merged.append(user_raw)
        return ",".join(merged)

    def populate_context_post_run(self, context: AgentContext) -> None:
        sessions_dir = self.logs_dir / "sessions"
        if not sessions_dir.is_dir():
            return

        total_input_tokens = 0
        total_output_tokens = 0
        total_cache_read_tokens = 0
        total_cache_write_tokens = 0
        total_cost = 0.0

        # Aggregate main.jsonl + subagent <timestamp>_<uuid>.jsonl siblings (see
        # src/extensions/subagent.ts:prepareChildSessionFile). Subagent runs are
        # separate sessions, so their usage isn't reflected in main.jsonl.
        for session_file in sorted(sessions_dir.glob("*.jsonl")):
            for line in session_file.read_text().splitlines():
                line = line.strip()
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

        # pi-ai treats input, cacheRead, cacheWrite as disjoint summing to totalTokens
        # (see node_modules/.../pi-ai/dist/providers/anthropic.js). Sum all three for
        # the wire-level prompt total.
        context.n_input_tokens = total_input_tokens + total_cache_read_tokens + total_cache_write_tokens
        context.n_output_tokens = total_output_tokens
        context.n_cache_tokens = total_cache_read_tokens
        context.cost_usd = total_cost if total_cost > 0 else None
