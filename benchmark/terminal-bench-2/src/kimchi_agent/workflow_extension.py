"""Host-side handling of the ``extension`` agent kwarg for ``WorkflowAgent``.

Both spec forms resolve on the host, never in the task container — those images
carry no Node toolchain, so pi's own ``-e npm:...`` fails there with
``Executable not found in $PATH: "npm"``.

- ``npm:<pkg>[@<version>]`` — ``npm pack`` plus ``npm install --omit=dev
  --omit=peer`` for its runtime deps (``jiti``, which the extension imports and
  pi does not supply). Cached by ``<pkg>@<version>``, so a job resolves once.
- ``dir:<host path>`` — a developer's checkout, fingerprinted rather than
  installed; used to test engine changes before they are published.

``resolve_extension_spec`` is injectable so tests never shell out or hit the
network.
"""

import json
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# `npm:<pkg>[@<version>]`.
_NPM_PREFIX = "npm:"

# `git:<host>/<owner>/<repo>[@<ref>]`, pi's scp-like shorthand, and the bare
# URL forms pi also accepts directly. NOT a spec form this adapter supports
# (see module docstring) — listed here only so `parse_extension_spec` can
# recognise a git-family spec and reject it with a message that explains why
# and names the two forms that do work, rather than a generic "unrecognised
# prefix" error that reads like a typo.
_GIT_PREFIXES = ("git:", "https://", "http://", "ssh://", "git://")

# `dir:<host path>` — this adapter's own invention for the local-development
# path, resolved and validated by us, on the host.
_DIR_PREFIX = "dir:"

# ~/.cache/kimchi-bench/extensions/<sanitised pkg>-<version>/{package/, .install-complete.json}
# Sibling of release.py's DEFAULT_CACHE_ROOT (~/.cache/kimchi-bench/releases),
# same reasoning: a host-side, cross-job, cross-process cache keyed by the
# thing that actually determines whether a re-resolve is redundant.
DEFAULT_EXTENSIONS_CACHE_ROOT = Path.home() / ".cache" / "kimchi-bench" / "extensions"

# Written into a resolved npm cache entry's directory only after `npm pack`,
# extraction AND `npm install --omit=dev --omit=peer` have all succeeded —
# never before. A resolve that dies partway (killed job, disk full, network
# drop mid-`npm install`) leaves a cache directory with no marker file (or a
# stale one from a previous *build* that never got renamed into place — see
# _resolve_npm), and the next resolve treats that as a miss and starts over,
# rather than uploading a half-installed extension to a container.
_NPM_CACHE_MARKER = ".install-complete.json"


@dataclass(frozen=True)
class NpmExtensionSpec:
    """``npm:<pkg>[@<version>]``. Resolved on the host by ``resolve_extension_spec``
    (``npm pack`` + extract + ``npm install --omit=dev --omit=peer``, cached by
    ``<pkg>@<version>``), then uploaded — the same shape of handling ``dir:``
    already gets, not pi's own installation path. See the module docstring for
    why passthrough (handing this to ``-e`` verbatim and letting pi resolve it
    inside the container) does not work in a terminal-bench task container.
    """

    raw: str


@dataclass(frozen=True)
class DirExtensionSpec:
    path: Path


ExtensionSpec = NpmExtensionSpec | DirExtensionSpec


def parse_extension_spec(raw: str) -> ExtensionSpec:
    """Classify the ``extension`` agent kwarg into one of two forms.

    ``git:`` specs and bare git URLs are rejected rather than accepted and left
    to fail later: they cannot resolve in the container (no toolchain) and the
    one repo they were used with is private, so the host cannot clone it either.

    Raises ``ValueError`` so a malformed spec fails at ``harbor run``, not
    ten minutes into a trial.
    """
    if not raw or not raw.strip():
        raise ValueError("'extension' agent kwarg must not be empty")

    if raw.startswith(_NPM_PREFIX):
        return NpmExtensionSpec(raw=raw)

    if raw.startswith(_DIR_PREFIX):
        path_str = raw[len(_DIR_PREFIX) :]
        if not path_str:
            raise ValueError(f"'extension' dir: spec must not be empty, got {raw!r}")
        return DirExtensionSpec(path=Path(path_str).expanduser())

    if raw.startswith(_GIT_PREFIXES):
        raise ValueError(
            "'extension' no longer accepts 'git:' specs (or bare git URLs) — "
            "resolving one needs a Node toolchain inside the task container, "
            "which terminal-bench images do not have (the same reason 'npm:' "
            "passthrough was removed), and the one repo this form was ever "
            "used with (kimchi-workflows) is private, so host-side resolution "
            "has no credentials for it either. Use 'npm:<pkg>[@<version>]' "
            f"(host-resolved and cached) or 'dir:<host path>' instead — got {raw!r}"
        )

    raise ValueError(
        "'extension' must be one of: 'npm:<pkg>[@<version>]' or 'dir:<host path>' "
        f"— got {raw!r}"
    )


@dataclass(frozen=True)
class ResolvedExtension:
    """The host-side result of resolving an ``extension`` spec — both forms
    (``npm:`` and ``dir:``) now produce one of these; ``WorkflowAgent.install()``
    uploads ``host_dir`` verbatim to ``/installed-agent/kimchi-workflows`` for
    either.

    ``identity`` is the full, unabridged provenance:
      - ``dir:``: ``dir:<abspath>@<sha-or-"dirty">``.
      - ``npm:``: ``npm:<pkg>@<resolved version>+<integrity or shasum>`` when
        the registry supplied one (npm always does for a real `npm pack`),
        else just ``npm:<pkg>@<resolved version>`` — the pinned spec string
        with the version filled in, if it was omitted.

    ``short_identity`` is what ``WorkflowAgent.to_agent_info()`` embeds in
    ``AgentInfo.version``. It is a SEPARATE field rather than a
    truncation of ``identity`` because the two shapes do not truncate alike:
    a `dir:` identity's first N characters are the head of an absolute host
    path (see the field-level note in the original design for why that is
    actively misleading), and an `npm:` identity's integrity string is an
    ~88-character base64 SRI hash not worth carrying in full into a version
    string read by humans.
    """

    host_dir: Path
    identity: str
    short_identity: str


@dataclass(frozen=True)
class NpmPackResult:
    """What ``npm pack --json <spec>`` reports about the package it just
    downloaded — the resolved version (filled in even when the spec omitted
    one) plus enough to prove what was fetched."""

    version: str
    filename: str
    shasum: str | None
    integrity: str | None


def _npm_pack(pack_spec: str, dest_dir: Path) -> NpmPackResult:
    """Real ``npm pack`` implementation — the default for the ``npm_pack``
    seam on ``resolve_extension_spec``. Never called by a test directly; tests
    inject a fake that writes a fixture tarball instead, so the suite never
    shells out to ``npm`` or touches the network.

    ``cwd=dest_dir`` (an otherwise-empty directory under the cache root) is
    deliberate: run from inside this repo (or the wider kimchi monorepo,
    which has its own package.json / workspaces) and npm's workspace
    resolution can second-guess what's being packed. A scratch directory
    has no ambient npm project to get confused by.
    """
    try:
        result = subprocess.run(
            ["npm", "pack", pack_spec, "--json", "--pack-destination", str(dest_dir), "--no-audit", "--no-fund"],
            capture_output=True,
            text=True,
            cwd=str(dest_dir),
            timeout=120,
        )
    except OSError as exc:
        raise RuntimeError(
            f"could not run 'npm pack {pack_spec}': {exc}. Is npm installed and on $PATH on this host?"
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(
            f"npm pack {pack_spec!r} failed (exit {result.returncode}): "
            f"{(result.stderr or result.stdout).strip()}"
        )
    try:
        packed = json.loads(result.stdout)[0]
        return NpmPackResult(
            version=packed["version"],
            filename=packed["filename"],
            shasum=packed.get("shasum"),
            integrity=packed.get("integrity"),
        )
    except (json.JSONDecodeError, IndexError, KeyError) as exc:
        raise RuntimeError(f"npm pack {pack_spec!r} produced unparseable --json output: {result.stdout!r}") from exc


def _npm_install_runtime_deps(package_dir: Path) -> None:
    """Real ``npm install --omit=dev --omit=peer`` implementation — the
    default for the ``npm_install_runtime_deps`` seam. ``--omit=dev`` keeps
    the extension's own test/build tooling out; ``--omit=peer`` matters
    specifically because ``typebox`` and ``@earendil-works/pi-coding-agent``
    are peers pi aliases to its own bundled copies — installing them anyway
    (npm >=7's default) would be a wasted ~14 MB duplicate. What this step
    exists for at all:
    `jiti` (~1.7 MB) is a real (non-peer, non-dev) dependency that
    ``src/host/load-workflow.ts`` imports directly, and pi does not supply it
    to extensions.
    """
    # --ignore-scripts: this is the only extension code that runs on the host
    # rather than in the container. Dropping it needs a deliberate decision.
    command = ["npm", "install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund"]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            cwd=str(package_dir),
            timeout=300,
        )
    except OSError as exc:
        raise RuntimeError(f"could not run 'npm install' in {package_dir}: {exc}") from exc
    if result.returncode != 0:
        # quote the command actually run, so the message cannot drift from it
        raise RuntimeError(
            f"{shlex.join(command)!r} in {package_dir} failed "
            f"(exit {result.returncode}): {(result.stderr or result.stdout).strip()}"
        )


def resolve_extension_spec(
    spec: ExtensionSpec,
    *,
    cache_root: Path = DEFAULT_EXTENSIONS_CACHE_ROOT,
    npm_pack: Callable[[str, Path], NpmPackResult] = _npm_pack,
    npm_install_runtime_deps: Callable[[Path], None] = _npm_install_runtime_deps,
) -> ResolvedExtension:
    """Resolve either extension spec form **on the host**. The single seam
    ``WorkflowAgent`` calls through its constructor-injectable
    ``extension_resolver`` — a test overrides that whole callable, so it never
    needs the ``npm_pack``/``npm_install_runtime_deps``/``cache_root`` knobs
    below; those exist so *this module's own* tests can exercise the caching
    and provenance logic without shelling out to ``npm`` or touching the
    network, by injecting fakes for exactly the two operations that do.
    """
    if isinstance(spec, DirExtensionSpec):
        return _resolve_dir(spec)
    return _resolve_npm(
        spec, cache_root=cache_root, npm_pack=npm_pack, npm_install_runtime_deps=npm_install_runtime_deps
    )


def _resolve_dir(spec: DirExtensionSpec) -> ResolvedExtension:
    abspath = spec.path.resolve()
    if not abspath.is_dir():
        raise ValueError(f"extension dir:{spec.path} does not exist or is not a directory")
    git_id = _git_identity(abspath)
    # The basename, not the whole path: it is the part that actually varies
    # between two checkouts a developer is A/B-ing, and the version string has
    # to stay readable next to the kimchi version and the workflow name.
    return ResolvedExtension(
        host_dir=abspath,
        identity=f"dir:{abspath}@{git_id}",
        short_identity=f"dir:{abspath.name}@{git_id[:12]}",
    )


def _git_identity(path: Path) -> str:
    """Best-effort ``<40-char sha>`` or ``"dirty"`` for a local checkout.

    Never raises: a directory that isn't a git checkout at all (e.g. an
    extension vendored without its ``.git``) is just always "dirty" — that is
    the correct, honest answer, not an error condition.
    """
    try:
        sha_result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        status_result = subprocess.run(
            ["git", "-C", str(path), "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "dirty"
    if sha_result.returncode != 0 or status_result.returncode != 0 or status_result.stdout.strip():
        return "dirty"
    return sha_result.stdout.strip()


def _split_npm_pkg_and_version(pack_spec: str) -> tuple[str, str | None]:
    """Split ``<pkg>[@<version>]`` (the part of an ``npm:`` spec after the
    prefix) into ``(package_name, version_or_None)``.

    Handles scoped packages (``@scope/name[@version]``) by only looking for
    the version-separating ``@`` *after* the scope's ``/`` — a scoped name's
    own leading ``@`` must not be mistaken for one.
    """
    if pack_spec.startswith("@"):
        if "/" not in pack_spec:
            raise ValueError(f"malformed scoped npm spec {pack_spec!r}; expected '@scope/name[@version]'")
        at_index = pack_spec.find("@", pack_spec.index("/"))
    else:
        at_index = pack_spec.find("@")
    if at_index == -1:
        return pack_spec, None
    return pack_spec[:at_index], pack_spec[at_index + 1 :]


def _npm_cache_key(package_name: str, version: str) -> str:
    # e.g. "@kimchi-dev/kimchi-workflows" + "0.0.1-0" -> "kimchi-dev-kimchi-workflows-0.0.1-0",
    # matching the tarball-naming convention npm itself uses for scoped names.
    sanitised = package_name.lstrip("@").replace("/", "-")
    return f"{sanitised}-{version}"


def _npm_identity(package_name: str, version: str, pack_result: NpmPackResult) -> tuple[str, str]:
    base = f"npm:{package_name}@{version}"
    digest = pack_result.integrity or (f"sha1-{pack_result.shasum}" if pack_result.shasum else None)
    if not digest:
        # Registry genuinely gave us nothing beyond the resolved version —
        # the pinned spec string (with the version filled in) is the honest
        # fallback, same principle as dir:'s "dirty" for a non-git checkout.
        return base, base
    _, _, tail = digest.partition("-")
    short_digest = (tail or digest)[:12]
    return f"{base}+{digest}", f"{base}+{short_digest}"


def _load_npm_cache_entry(cache_dir: Path) -> ResolvedExtension | None:
    marker = cache_dir / _NPM_CACHE_MARKER
    package_root = cache_dir / "package"
    if not marker.is_file() or not package_root.is_dir():
        return None
    try:
        meta = json.loads(marker.read_text())
        identity = meta["identity"]
        short_identity = meta["short_identity"]
    except (OSError, json.JSONDecodeError, KeyError):
        # A marker that exists but doesn't parse is not a good cache entry —
        # treat it exactly like a missing one and let the caller re-resolve.
        return None
    return ResolvedExtension(host_dir=package_root, identity=identity, short_identity=short_identity)


def _publish_npm_cache_entry(staging: Path, cache_dir: Path, built: ResolvedExtension) -> ResolvedExtension:
    """
    A simple rename is going to fail if the target directory exists and is not empty.
    """
    try:
        staging.rename(cache_dir)
        # renamed successfully
        return built
    except OSError:
        pass

    # check if cache directory exists
    cached = _load_npm_cache_entry(cache_dir)
    if cached is not None:
        return cached

    quarantine: Path | None = cache_dir.with_name(f".{cache_dir.name}.stale-{uuid.uuid4().hex[:12]}")
    try:
        cache_dir.rename(quarantine)
    except OSError:
        # Another process cleared the same leftover first. Whatever it has done
        # with the freed name since is one of the two cases already handled.
        quarantine = None
    try:
        staging.rename(cache_dir)
        return built
    except OSError:
        # another process published here first — use its entry, do not fail
        cached = _load_npm_cache_entry(cache_dir)
        if cached is None:
            raise
        return cached
    finally:
        if quarantine is not None:
            shutil.rmtree(quarantine, ignore_errors=True)


def _resolve_npm(
    spec: NpmExtensionSpec,
    *,
    cache_root: Path,
    npm_pack: Callable[[str, Path], NpmPackResult],
    npm_install_runtime_deps: Callable[[Path], None],
) -> ResolvedExtension:
    pack_spec = spec.raw[len(_NPM_PREFIX) :]
    package_name, pinned_version = _split_npm_pkg_and_version(pack_spec)

    # Fast path: a PINNED spec's cache directory is knowable without asking
    # the registry anything, so a hit here costs zero network calls — this is
    # what makes a job of N trials against a pinned spec resolve once, in the
    # first trial, and every later trial a pure filesystem read.
    if pinned_version is not None:
        cached = _load_npm_cache_entry(cache_root / _npm_cache_key(package_name, pinned_version))
        if cached is not None:
            return cached

    cache_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".kimchi-npm-stage-", dir=cache_root))
    try:
        pack_result = npm_pack(pack_spec, staging)
        resolved_version = pack_result.version
        cache_dir = cache_root / _npm_cache_key(package_name, resolved_version)

        # An UNPINNED spec only learns its target directory here, after
        # asking the registry — but if that resolved version is one this (or
        # any other) process already finished installing, the work below is
        # redundant; reuse it rather than re-downloading and re-installing.
        cached = _load_npm_cache_entry(cache_dir)
        if cached is not None:
            return cached

        package_root = _extract_npm_tarball(staging / pack_result.filename, staging)
        npm_install_runtime_deps(package_root)

        identity, short_identity = _npm_identity(package_name, resolved_version, pack_result)
        # Written INSIDE the staging dir, before it becomes the cache entry —
        # so the rename below either publishes a directory that already has
        # its marker, or doesn't publish at all. There is no window where a
        # marker-less directory is visible at the final cache path.
        (staging / _NPM_CACHE_MARKER).write_text(json.dumps({"identity": identity, "short_identity": short_identity}))

        # Publish by rename only — see _publish_npm_cache_entry for why the
        # occupied-target cases are handled by moving directories rather than
        # by deleting one where another process may be reading it.
        return _publish_npm_cache_entry(
            staging,
            cache_dir,
            ResolvedExtension(host_dir=cache_dir / "package", identity=identity, short_identity=short_identity),
        )
    finally:
        # No-op if `staging` was already renamed away above; cleans up a
        # leftover only when this resolve returned early (cache hit) or
        # raised partway through.
        shutil.rmtree(staging, ignore_errors=True)


def _extract_npm_tarball(tarball_path: Path, dest_dir: Path) -> Path:
    with tarfile.open(tarball_path, "r:gz") as tar:
        tar.extractall(dest_dir, filter="data")
    package_root = dest_dir / "package"
    if not (package_root / "package.json").is_file():
        raise RuntimeError(
            f"npm pack tarball {tarball_path} did not extract a 'package/package.json' — "
            "not a valid npm package archive"
        )
    return package_root
