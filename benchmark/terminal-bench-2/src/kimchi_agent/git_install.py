"""Shared utility for ensuring git is installed in terminal-bench containers.

Terminal-bench task images are not guaranteed to have git installed, and some
tasks ship with their own git repo already in place.  These helpers install
the git binary if missing, set a default identity so commits don't fail, and
``git init`` + commit a baseline snapshot only when no repo already exists —
so that ``git diff`` during/after the agent run accurately reflects only what
the agent changed.
"""

# Environment for apt-based installs to avoid interactive prompts.
GIT_INSTALL_ENV = {"DEBIAN_FRONTEND": "noninteractive"}

# Install git across the three common base image families (Alpine, Debian/Ubuntu, RHEL).
GIT_INSTALL_COMMAND = (
    # Skip entirely if git is already available (e.g. baked into the Docker
    # image via install_spec). This avoids network access in air-gapped tasks.
    "if command -v git &> /dev/null; then"
    "  echo 'git already installed:' $(git --version);"
    " elif command -v apk &> /dev/null; then"
    "  apk add --no-cache git;"
    " elif command -v apt-get &> /dev/null; then"
    "  apt-get update && apt-get install -y git;"
    " elif command -v yum &> /dev/null; then"
    "  yum install -y git;"
    " else"
    '  echo "Warning: No known package manager found and git not present" >&2;'
    " fi"
)


def git_install_command() -> str:
    """Return the shell command that installs git if missing."""
    return GIT_INSTALL_COMMAND


def git_config_command() -> str:
    """Return the shell command that sets a default git identity (no commits fail).

    Uses ``--global`` so it applies regardless of whether a repo exists.
    Repo-level config always overrides global, so this won't clobber identity
    that a task image intentionally set inside ``.git/config``.
    """
    return (
        'git config --global user.name "Terminal Bench" && '
        'git config --global user.email "bench@local"'
    )


def git_init_and_commit_baseline_command(workdir: str = "/app") -> str:
    """Init a git repo and commit all files as the baseline snapshot.

    Only runs when no ``.git`` already exists — some terminal-bench tasks
    (e.g. ``fix-git``) ship with their own repo and commit history that
    must be preserved.  When a repo already exists, we skip entirely so
    the task's intended starting state is not altered.

    After ``git init`` the working tree is staged and committed so that a
    subsequent ``git diff`` shows only the agent's changes.

    The ``workdir`` parameter controls which directory the git repo is
    initialised in.  It defaults to ``/app`` (the terminal-bench convention)
    but some tasks use a different working directory (e.g. ``prove-plus-comm``
    uses ``/workspace``).  Callers that run the command in a fresh shell where
    the working directory is already correct (set by harbor via ``docker exec
    -w``) can pass ``workdir=""`` to skip the ``cd`` and operate on the
    current directory.
    """
    cd = f"cd {workdir} && " if workdir else ""
    return (
        f"{cd}if [ ! -d .git ]; then"
        "  git init -q &&"
        "  git add -A &&"
        "  git commit -q -m 'baseline' --allow-empty;"
        "fi"
    )
