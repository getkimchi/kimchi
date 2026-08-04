"""What both workflow-running adapters do with ``workflows/``, in one place.

``WorkflowAgent`` (kimchi) and ``PiWorkflowAgent`` (stock pi) run the *same*
workflow sources out of the *same* directory through the *same* extension. Only
the harness underneath differs — and with it the project directory the
extension resolves names against, which is derived from the running harness's
own name (``kimchi-workflows/src/host/project-dir.ts``: ``.kimchi`` under
kimchi, ``.pi`` under pi). So everything here is parameterised on that path and
nothing else.

Deliberately functions over a mixin: the two adapters have different bases
(``Kimchi`` / ``PiKimchi``) and a mixin would have to reach into both.
``workflows_host_dir`` is an argument rather than a module global for the same
reason it is still a module global in each adapter — the tests monkeypatch it
there, and a shared global would silently ignore that.
"""

from __future__ import annotations

import shutil
from pathlib import Path

# workflows/ is also a dev directory; none of this belongs in a task container,
# and `npm install` there would otherwise ship ~72MB plus a symlink out of the
# repo. A denylist, since a workflow may legitimately need a data file beside it.
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
    """Copy ``source_dir`` to ``destination``, minus the dev-only scaffolding."""
    shutil.copytree(source_dir, destination, ignore=WORKFLOWS_UPLOAD_IGNORE)


def assert_a_workflow_can_resolve(
    *,
    staged_workflows: Path,
    workflow: str,
    workflows_host_dir: Path,
    project_workflows_dir: str,
) -> None:
    """Fail at install, not ten minutes into a trial, when nothing the container
    will receive can serve this run's ``workflow=``.

    Scans the staged tree, which is exactly what gets uploaded — the source tree
    also holds ``node_modules/@kimchi-dev/kimchi-workflows/``'s own
    ``create.workflow.ts``, which the upload filter strips.

    ``resolveWorkflow`` (``kimchi-workflows/src/host/workflow-catalog.ts``)
    takes a ``.ts`` argument as a path, which reaches a nested file, and
    anything else as a declared name, which only ``discoverWorkflows``'
    non-recursive ``readdir`` can serve. So the required check depends on which
    form was passed.
    """
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
