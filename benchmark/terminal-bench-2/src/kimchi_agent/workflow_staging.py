"""Shared workflow staging for ``WorkflowAgent`` (kimchi) and ``PiWorkflowAgent`` (stock pi).

Functions, not a mixin: the two adapters have different bases (``Kimchi`` /
``PiKimchi``). ``workflows_host_dir`` is an argument because each adapter's
tests monkeypatch it as a module global — a shared global here would silently
ignore that.
"""

from __future__ import annotations

import shutil
from pathlib import Path

# A denylist, not an allowlist: a workflow may legitimately need a data file
# beside it. Without this, npm install in workflows/ would ship ~72MB plus a
# symlink out of the repo into a task container.
WORKFLOWS_UPLOAD_IGNORE = shutil.ignore_patterns(
    "node_modules",
    "test",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    ".gitignore",
    "README.md",
)


def stage_workflows(source_dir: Path, destination: Path) -> None:
    shutil.copytree(source_dir, destination, ignore=WORKFLOWS_UPLOAD_IGNORE)


def assert_a_workflow_can_resolve(
    *,
    staged_workflows: Path,
    workflow: str,
    workflows_host_dir: Path,
    project_workflows_dir: str,
) -> None:
    # Scans the staged tree (what gets uploaded, after the dev-only filter).
    # resolveWorkflow takes a .ts argument as a path (reaches nested files)
    # and anything else as a declared name (served only by a non-recursive
    # readdir of the top level). So the check depends on which form was passed.
    staged = sorted(staged_workflows.rglob("*.workflow.ts"))
    if not staged:
        raise RuntimeError(
            f"No *.workflow.ts files found anywhere under {workflows_host_dir} that would reach "
            "the container (the dev-only names in WORKFLOWS_UPLOAD_IGNORE are excluded from the "
            "upload, and so from this check). There is nothing to run, by name or by path; see "
            "workflows/README.md for the expected layout."
        )

    if workflow.endswith(".ts") or any(path.parent == staged_workflows for path in staged):
        return

    nested = ", ".join(str(path.relative_to(staged_workflows)) for path in staged)
    raise RuntimeError(
        f"'workflow={workflow}' is a declared workflow name, which the extension resolves "
        f"through a non-recursive scan of the top level of {workflows_host_dir} — but every "
        f"*.workflow.ts that reaches the container is in a subdirectory ({nested}), where that "
        "scan cannot see it. Move one to the top level, or address a nested file by path instead "
        f"(workflow={project_workflows_dir}/<subdir>/<file>.workflow.ts). "
        "See workflows/README.md, 'What goes here'."
    )


__all__ = ["WORKFLOWS_UPLOAD_IGNORE", "assert_a_workflow_can_resolve", "stage_workflows"]
