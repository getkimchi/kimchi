"""Detect whether Harbor or Pier drives the current agent process.

The agent classes extend pier's ``BaseInstalledAgent`` so pier's trial runner
(deep-swe) populates per-trial token context via its ``isinstance`` gate.
Both runners, however, load the same agent classes through the same import
paths — and each framework's ``TrialResult`` pydantic model only accepts its
*own* ``AgentInfo`` type. ``to_agent_info()`` must therefore construct the
class matching the framework that is actually running.
"""

import os
import sys
from typing import TypeVar
from uuid import UUID

AgentInfoT = TypeVar("AgentInfoT")
ModelInfoT = TypeVar("ModelInfoT")


class HarborCompatMixin:
    """Shim for the Harbor BaseAgent surface that pier's fork predates.

    Pier forked Harbor before ``extra_env`` (property), ``session_id`` and
    ``context_id`` (class attributes) were added upstream. Harbor's trial
    runner reads ``agent.extra_env`` when scoping the agent environment and
    assigns ``agent.session_id`` / ``agent.context_id`` per trial. The
    assignments work on any object; the read crashes without this mixin.

    Pier's BaseInstalledAgent already accepts the ``extra_env`` kwarg and
    stores it as ``_extra_env`` — this mixin only re-exposes the public read
    surface. Mix in BEFORE the pier base class.
    """

    session_id: str | None = None
    context_id: UUID | None = None

    @property
    def extra_env(self) -> dict[str, str]:
        """Environment variables configured for this agent (Harbor parity)."""
        return dict(self._extra_env)

    async def _exec(
        self,
        environment,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ):
        """Execute a command against either a Harbor or a Pier environment.

        Pier's BaseInstalledAgent._exec merges ``extra_env`` per-exec and pipes
        it through ``environment.agent_process_env`` (which injects the
        deep-swe egress-proxy vars). Harbor environments have no
        ``agent_process_env`` — and merging ``extra_env`` there is wrong
        anyway, because Harbor's Trial scopes it onto the environment
        (``scoped_exec_env``). Discriminate on the environment's surface, not
        on ``sys.modules``: the agent classes are loaded once per process but
        the runner picks the environment per trial.
        """
        process_env = getattr(environment, "agent_process_env", None)
        merged_env = env
        if process_env is not None:
            if self._extra_env:
                merged_env = dict(env) if env else {}
                merged_env.update(self._extra_env)
            merged_env = process_env(merged_env)

        self.logger.debug(
            f"Running command: {command}",
            extra={"user": str(user), "env": merged_env or {}},
        )

        result = await environment.exec(
            command=f"set -o pipefail; {command}",
            user=user,
            env=merged_env,
            cwd=cwd,
            timeout_sec=timeout_sec,
        )
        if result.return_code != 0:
            self.logger.debug(
                "Command failed",
                extra={
                    "return_code": result.return_code,
                    "stdout": self._truncate_output(result.stdout),
                    "stderr": self._truncate_output(result.stderr),
                },
            )
            self._raise_exec_error(command, result, pier_environment=process_env is not None)

        self.logger.debug(
            "Command outputs captured",
            extra={
                "stdout": self._truncate_output(result.stdout),
                "stderr": self._truncate_output(result.stderr),
            },
        )
        return result

    def _raise_exec_error(self, command: str, result, *, pier_environment: bool):
        """Raise the classified error for a failed command, runner-faithfully.

        Harbor's ``_exec`` dispatches to ``self._classify_exec_error`` — Kimchi
        raises ``KimchiExitError`` (which classify.py's infra breaker keys on),
        PiKimchi raises ``PiExitError``, and agents without an override fall
        back to Harbor's ``ERROR_PATTERNS`` subtypes (``NetworkConnectionError``,
        ``ApiUsageLimitError``, ...) that the pipeline classifier matches by
        exception type. Pier's ``_exec`` raises a plain
        ``NonZeroAgentExitCodeError``. Reproduce the driving runner's behavior:
        custom classifier first (both runners), then Harbor's pattern fallback
        (Harbor environments only), then Pier's plain error.
        """
        from pier.agents.installed.base import NonZeroAgentExitCodeError

        detail = (
            f"Command failed (exit {result.return_code}): {command}\n"
            f"stdout: {self._truncate_output(result.stdout)}\n"
            f"stderr: {self._truncate_output(result.stderr)}"
        )

        classifier = getattr(self, "_classify_exec_error", None)
        if classifier is not None:
            classified = classifier(command, result)
            if classified is not None:
                raise classified

        if not pier_environment:
            import re

            from harbor.agents.installed.base import BaseInstalledAgent as HarborInstalledAgent

            output = f"{result.stdout or ''}\n{result.stderr or ''}"
            for pattern in HarborInstalledAgent.ERROR_PATTERNS:
                if re.search(pattern.pattern, output, re.IGNORECASE):
                    raise pattern.exception(detail)

        raise NonZeroAgentExitCodeError(detail)


def using_pier() -> bool:
    """Return True when the pier runner (deep-swe) is driving this process.

    Two signals, in priority order:

    1. ``USE_PIER=true`` — set by the GitLab chunk jobs when dispatching
       through ``pier_runner`` (see ``bench_config.use_pier``). The chunk
       runner passes its environment through to the pier subprocess.
    2. ``"pier.trial.trial" in sys.modules`` — covers local ``pier run``
       invocations (deep-swe README flow) where the env var is not set.
       Neither our agent modules nor pier's agent modules import
       ``pier.trial.trial``, so under a Harbor run it is never loaded.
    """
    if os.environ.get("USE_PIER", "").lower() == "true":
        return True
    return "pier.trial.trial" in sys.modules


def agent_info_types() -> tuple[type[AgentInfoT], type[ModelInfoT]]:
    """Return the (AgentInfo, ModelInfo) classes for the driving framework.

    Lazy imports so that merely importing this module does not couple us to
    either framework at import time.
    """
    if using_pier():
        from pier.models.trial.result import AgentInfo, ModelInfo
    else:
        from harbor.models.trial.result import AgentInfo, ModelInfo

    return AgentInfo, ModelInfo
