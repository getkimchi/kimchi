"""Unit tests for host-side extension resolution (`workflow_extension.py`).

`workflow_agent_test.py` covers `WorkflowAgent`'s use of the
`extension_resolver` seam (always injected there, so it never reaches this
module's real logic). This file exercises `resolve_extension_spec` itself —
the caching, provenance and dispatch logic — through its own injectable
`npm_pack`/`npm_install_runtime_deps` seams, so it never shells out to `npm`
or touches the network either — resolution is designed to stay an
injectable seam throughout.
"""

import io
import json
import subprocess
import tarfile
from collections.abc import Callable
from pathlib import Path

import pytest

from kimchi_agent import workflow_extension
from kimchi_agent.workflow_extension import (
    DirExtensionSpec,
    NpmExtensionSpec,
    NpmPackResult,
    resolve_extension_spec,
)


def _write_fake_npm_tarball(dest_dir: Path, filename: str, *, extra_files: dict[str, str] | None = None) -> None:
    """Build a real gzipped tar matching what `npm pack` produces: a
    top-level `package/` directory containing `package.json`. Real tarfile
    extraction logic runs against this fixture — only the network/subprocess
    call that would normally produce it is faked.
    """

    def _add_text(tar: tarfile.TarFile, arcname: str, content: str) -> None:
        data = content.encode()
        info = tarfile.TarInfo(name=arcname)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))

    with tarfile.open(dest_dir / filename, "w:gz") as tar:
        _add_text(tar, "package/package.json", json.dumps({"name": "fake-pkg"}))
        for rel, content in (extra_files or {}).items():
            _add_text(tar, f"package/{rel}", content)


def _fake_npm_pack(
    *,
    version: str,
    shasum: str | None = "deadbeefcafebabedeadbeefcafebabedeadbeef",
    integrity: str | None = "sha512-abc123def456ghi789==",
    calls: list[str],
) -> Callable[[str, Path], NpmPackResult]:
    def fake(pack_spec: str, dest_dir: Path) -> NpmPackResult:
        calls.append(pack_spec)
        filename = "pkg.tgz"
        _write_fake_npm_tarball(dest_dir, filename)
        return NpmPackResult(version=version, filename=filename, shasum=shasum, integrity=integrity)

    return fake


def _fake_npm_install(calls: list[Path]) -> Callable[[Path], None]:
    def fake(package_dir: Path) -> None:
        calls.append(package_dir)
        # A real `npm install --omit=dev --omit=peer` would populate this;
        # nothing reads it back in these tests, but it makes the fixture
        # honest about what the real seam leaves behind.
        (package_dir / "node_modules" / "jiti").mkdir(parents=True, exist_ok=True)

    return fake


# --- dispatch: resolve_extension_spec routes by spec type -------------------


def test_resolve_extension_spec_dispatches_dir_without_touching_npm_seams(tmp_path: Path) -> None:
    checkout = tmp_path / "kimchi-workflows"
    checkout.mkdir()

    def pack_must_not_be_called(pack_spec: str, dest_dir: Path) -> NpmPackResult:
        raise AssertionError("npm_pack must not be called for a dir: spec")

    resolved = resolve_extension_spec(
        DirExtensionSpec(path=checkout),
        cache_root=tmp_path / "cache",
        npm_pack=pack_must_not_be_called,
        npm_install_runtime_deps=lambda p: (_ for _ in ()).throw(AssertionError("must not be called")),
    )

    assert resolved.host_dir == checkout
    assert resolved.identity == f"dir:{checkout}@dirty"


# --- npm: resolution — pinned spec, cache reuse ------------------------------


def test_resolve_npm_pinned_spec_installs_once_and_uploads_from_the_extracted_package_root(
    tmp_path: Path,
) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")
    pack_calls: list[str] = []
    install_calls: list[Path] = []

    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=pack_calls),
        npm_install_runtime_deps=_fake_npm_install(install_calls),
    )

    assert pack_calls == ["@kimchi-dev/kimchi-workflows@0.1.0"]
    assert len(install_calls) == 1
    # npm_install_runtime_deps runs against the STAGING copy, before it's
    # atomically renamed into place as the cache entry — so it's the same
    # "package" leaf, under a different (pre-rename) parent.
    assert install_calls[0].name == "package"
    assert install_calls[0].parent.parent == cache_root
    assert (resolved.host_dir / "package.json").is_file()
    assert (resolved.host_dir / "node_modules" / "jiti").is_dir()
    # Uploaded verbatim by WorkflowAgent.install() — the dir has to actually
    # be the extracted package root, not the cache entry's parent.
    assert resolved.host_dir.name == "package"


def test_resolve_npm_pinned_spec_second_resolve_is_a_pure_cache_hit(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")

    first_pack_calls: list[str] = []
    first_install_calls: list[Path] = []
    first = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=first_pack_calls),
        npm_install_runtime_deps=_fake_npm_install(first_install_calls),
    )

    # Fresh call-recording lists for the second resolve: if either seam gets
    # invoked at all, these stay non-empty and the assertion below fails —
    # that's the whole point of a cache "reuse", not just "cheaper reuse".
    second_pack_calls: list[str] = []
    second_install_calls: list[Path] = []
    second = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=second_pack_calls),
        npm_install_runtime_deps=_fake_npm_install(second_install_calls),
    )

    assert second_pack_calls == []
    assert second_install_calls == []
    assert second == first


def test_resolve_npm_unpinned_spec_still_calls_pack_but_reuses_install_once_version_is_known(
    tmp_path: Path,
) -> None:
    # An unpinned spec's cache directory isn't knowable without asking the
    # registry, so `npm_pack` runs every resolve (documented cost of staying
    # unpinned) — but once the resolved version is known, a second
    # resolve that lands on the SAME version must not redo the install.
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows")  # no @<version>

    first_pack_calls: list[str] = []
    first_install_calls: list[Path] = []
    first = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.9.0", calls=first_pack_calls),
        npm_install_runtime_deps=_fake_npm_install(first_install_calls),
    )
    assert first_pack_calls == ["@kimchi-dev/kimchi-workflows"]
    assert len(first_install_calls) == 1

    second_pack_calls: list[str] = []
    second_install_calls: list[Path] = []
    second = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.9.0", calls=second_pack_calls),  # registry resolves the same version again
        npm_install_runtime_deps=_fake_npm_install(second_install_calls),
    )

    assert second_pack_calls == ["@kimchi-dev/kimchi-workflows"]  # pack DOES run again
    assert second_install_calls == []  # install does NOT — the version was already cached
    assert second == first


# --- cache key sanitisation ---------------------------------------------------


def test_resolve_npm_cache_dir_sanitises_a_scoped_package_name(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.0.1-0")

    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.0.1-0", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    expected = cache_root / "kimchi-dev-kimchi-workflows-0.0.1-0" / "package"
    assert resolved.host_dir == expected


def test_resolve_npm_cache_dir_for_unscoped_package_has_no_leading_dash(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:kimchi-workflows@1.2.3")

    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="1.2.3", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert resolved.host_dir == cache_root / "kimchi-workflows-1.2.3" / "package"


# --- provenance ----------------------------------------------------------------


def test_resolve_npm_identity_includes_resolved_version_and_integrity(tmp_path: Path) -> None:
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")

    resolved = resolve_extension_spec(
        spec,
        cache_root=tmp_path / "cache",
        npm_pack=_fake_npm_pack(version="0.1.0", integrity="sha512-abc123def456ghi789==", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert resolved.identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0+sha512-abc123def456ghi789=="
    # short_identity carries a truncated digest — compact enough to embed in
    # AgentInfo.version, unlike the ~88-char full SRI hash in `identity`.
    assert resolved.short_identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0+abc123def456"
    assert len(resolved.short_identity) < len(resolved.identity)


def test_resolve_npm_identity_falls_back_to_shasum_when_no_integrity(tmp_path: Path) -> None:
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")

    resolved = resolve_extension_spec(
        spec,
        cache_root=tmp_path / "cache",
        npm_pack=_fake_npm_pack(version="0.1.0", integrity=None, shasum="deadbeefcafebabe", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert resolved.identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0+sha1-deadbeefcafebabe"


def test_resolve_npm_identity_falls_back_to_the_pinned_spec_string_with_no_registry_hash(tmp_path: Path) -> None:
    # "prefer the resolved version plus the registry integrity/shasum ... ,
    # falling back to the pinned spec string" — this is that fallback: the
    # registry gave nothing to hash, so the honest identity is just the
    # resolved package@version, same shape as the original spec string.
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")

    resolved = resolve_extension_spec(
        spec,
        cache_root=tmp_path / "cache",
        npm_pack=_fake_npm_pack(version="0.1.0", integrity=None, shasum=None, calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert resolved.identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0"
    assert resolved.short_identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0"


# --- marker-file completeness: an interrupted resolve is not a cache hit ----


def test_resolve_npm_treats_a_marker_less_directory_as_a_cache_miss(tmp_path: Path) -> None:
    # Simulate a resolve that died after extraction but before the
    # `.install-complete.json` marker was written (e.g. `npm install` was
    # killed partway) — a real, plausible interrupted state, not a
    # hypothetical one. The next resolve must not trust it.
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")
    stale_package_root = cache_root / "kimchi-dev-kimchi-workflows-0.1.0" / "package"
    stale_package_root.mkdir(parents=True)
    (stale_package_root / "package.json").write_text("{}")
    # Deliberately NO .install-complete.json marker written.

    pack_calls: list[str] = []
    install_calls: list[Path] = []
    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=pack_calls),
        npm_install_runtime_deps=_fake_npm_install(install_calls),
    )

    # Re-resolved from scratch rather than trusting the marker-less directory.
    assert pack_calls == ["@kimchi-dev/kimchi-workflows@0.1.0"]
    assert len(install_calls) == 1
    assert (resolved.host_dir / "node_modules" / "jiti").is_dir()


def test_resolve_npm_treats_an_unparseable_marker_as_a_cache_miss(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")
    entry_dir = cache_root / "kimchi-dev-kimchi-workflows-0.1.0"
    package_root = entry_dir / "package"
    package_root.mkdir(parents=True)
    (package_root / "package.json").write_text("{}")
    (entry_dir / ".install-complete.json").write_text("not valid json")

    pack_calls: list[str] = []
    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=pack_calls),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert pack_calls == ["@kimchi-dev/kimchi-workflows@0.1.0"]
    assert resolved.identity.startswith("npm:@kimchi-dev/kimchi-workflows@0.1.0+")


def test_resolve_npm_writes_marker_only_after_a_complete_install(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")

    resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    marker = cache_root / "kimchi-dev-kimchi-workflows-0.1.0" / ".install-complete.json"
    assert marker.is_file()
    meta = json.loads(marker.read_text())
    assert meta["identity"].startswith("npm:@kimchi-dev/kimchi-workflows@0.1.0")

    # No leftover staging directories: the successful run's temp build dir
    # was renamed into place, not left behind under the cache root.
    leftovers = [p for p in cache_root.iterdir() if p.name.startswith(".kimchi-npm-stage-")]
    assert leftovers == []


# --- publishing a finished build: never destroy a directory in place ---------


def test_resolve_npm_reuses_a_complete_entry_another_process_published_mid_install(tmp_path: Path) -> None:
    """The publish-time race, made deterministic.

    Two `harbor run` jobs sharing one cache root is the only way to reach this
    path — in-process, harbor's concurrent trials are asyncio tasks on one
    event loop and the blocking `npm` calls pin it for the whole resolve. So
    the other process is simulated *from inside* the install seam: it finishes
    and publishes a complete entry at the exact cache key this resolve is
    about to claim, while this resolve is still inside `npm install`.

    Its entry must be reused intact. Deleting it to make room for an
    equivalent rebuild is not merely wasteful: a third job that hit the cache
    moments ago may be uploading out of `cache_dir/package` right now.
    """
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")
    cache_dir = cache_root / "kimchi-dev-kimchi-workflows-0.1.0"

    def install_and_lose_the_race(package_dir: Path) -> None:
        (package_dir / "node_modules" / "jiti").mkdir(parents=True, exist_ok=True)
        winner_package = cache_dir / "package"
        winner_package.mkdir(parents=True)
        (winner_package / "package.json").write_text(json.dumps({"name": "fake-pkg"}))
        (winner_package / "published-by-the-other-process").write_text("x\n")
        (cache_dir / ".install-complete.json").write_text(
            json.dumps(
                {
                    "identity": "npm:@kimchi-dev/kimchi-workflows@0.1.0+sha512-winner==",
                    "short_identity": "npm:@kimchi-dev/kimchi-workflows@0.1.0+winner",
                }
            )
        )

    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=[]),
        npm_install_runtime_deps=install_and_lose_the_race,
    )

    # The winner's provenance, not this process's own — the returned identity
    # is the one on disk, so result.json cannot claim a build that got discarded.
    assert resolved.identity == "npm:@kimchi-dev/kimchi-workflows@0.1.0+sha512-winner=="
    assert resolved.host_dir == cache_dir / "package"
    # Reused intact rather than deleted and replaced by an equivalent rebuild.
    assert (resolved.host_dir / "published-by-the-other-process").is_file()
    # And this resolve's own discarded build left nothing behind under the cache root.
    assert sorted(p.name for p in cache_root.iterdir()) == [cache_dir.name]


def test_resolve_npm_replaces_a_marker_less_leftover_without_leaving_a_quarantine_behind(tmp_path: Path) -> None:
    # A marker-less directory occupying the cache key is a leftover from an
    # interrupted resolve, and unlike the complete entry above it must NOT be
    # reused. It is still renamed aside rather than removed where it stands
    # (see _publish_npm_cache_entry) — so what this pins is that the aside
    # copy really is cleaned up afterwards, and that the fresh build wins.
    cache_root = tmp_path / "cache"
    spec = NpmExtensionSpec(raw="npm:@kimchi-dev/kimchi-workflows@0.1.0")
    cache_dir = cache_root / "kimchi-dev-kimchi-workflows-0.1.0"
    stale_package = cache_dir / "package"
    stale_package.mkdir(parents=True)
    (stale_package / "package.json").write_text("{}")
    (stale_package / "half-installed-leftover").write_text("x\n")
    # Deliberately NO .install-complete.json marker written.

    resolved = resolve_extension_spec(
        spec,
        cache_root=cache_root,
        npm_pack=_fake_npm_pack(version="0.1.0", calls=[]),
        npm_install_runtime_deps=_fake_npm_install([]),
    )

    assert resolved.host_dir == cache_dir / "package"
    assert (resolved.host_dir / "node_modules" / "jiti").is_dir()
    assert not (resolved.host_dir / "half-installed-leftover").exists()
    assert (cache_dir / ".install-complete.json").is_file()
    # Nothing of the leftover — nor any quarantine or staging dir — survives.
    assert sorted(p.name for p in cache_root.iterdir()) == [cache_dir.name]


# --- host-side execution boundary ---------------------------------------------


def test_npm_install_runtime_deps_ignores_lifecycle_scripts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Reaches past the injectable seam to the real ``_npm_install_runtime_deps``
    on purpose: this is the one call in the whole adapter that runs a resolved
    extension's code (or a dependency's) on the **benchmark host** rather than
    inside the throwaway task container, and that host holds ``KIMCHI_API_KEY``.
    Every other test here fakes the seam away, which would let
    ``--ignore-scripts`` be dropped without a single failure.
    """
    captured: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(workflow_extension.subprocess, "run", fake_run)

    workflow_extension._npm_install_runtime_deps(tmp_path)

    assert len(captured) == 1
    assert "--ignore-scripts" in captured[0]
    # The flags this step exists for must survive alongside it.
    assert captured[0][:2] == ["npm", "install"]
    assert "--omit=dev" in captured[0]
    assert "--omit=peer" in captured[0]
