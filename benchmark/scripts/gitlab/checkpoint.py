"""Durable per-trial benchmark checkpointing over GCS.

This module is the single source of truth for checkpoint *semantics* and the
shared archive/transport logic used by three callers:

- ``chunk_runner.py`` (system ``python3``): restores checkpoints at chunk
  startup and reconciles durable progress (Phases 4-6).
- ``upload_gcs.py`` / the summary job: hydrates all chunks from GCS when
  GitLab artifacts are missing (Phase 7).
- ``kimchi_agent.plugins.gcs_checkpoint`` (the Harbor plugin, Harbor venv):
  uploads a checkpoint for each completed trial (Phase 3).

It deliberately uses **only the Python standard library** plus the ``gcloud
storage`` CLI for transport, so it imports cleanly in both execution contexts.
Harbor's venv (tenacity/httpx) is not required here; retry logic is a small
stdlib loop so behaviour is identical everywhere and trivially unit-testable.

## Checkpoint layout

Checkpoints live under a namespace kept strictly separate from the final
published ``jobs.tar.gz``::

    <run-prefix>/_checkpoints/
        chunk=0/trials/<trial-id>.tar.gz
        chunk=1/trials/<trial-id>.tar.gz
        chunk=2/trials/<trial-id>.tar.gz
        run-metadata.json

``<run-prefix>`` is the pipeline-level GCS prefix produced by
``chunk_runner._build_gcs_key_prefix()`` and recorded in
``run-metadata.json`` as ``gcs.prefix``.

## Trial archive layout

Each ``.tar.gz`` mirrors a Harbor trial directory under a single root named
after the trial id (the trial directory name, e.g. ``fix-git__abc1234``)::

    fix-git__abc1234/
        config.json
        lock.json
        result.json
        agent/...
        verifier/...
        artifacts/...
        _checkpoint_meta.json

``_checkpoint_meta.json`` carries ``schema_version``, ``task_name``,
``trial_id`` and ``payload_sha256`` (the checksum of every *other* member's
``arcname + \\0 + content``). It is the corruption detector used on restore:
durable data that fails verification is rejected loudly rather than silently
rerunning expensive trials.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import logging
import shutil
import subprocess
import tarfile
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:  # pragma: no cover - typing only
    pass

logger = logging.getLogger(__name__)

# --- Schema / namespace constants ------------------------------------------

#: Bump when the on-disk archive or metadata shape changes incompatibly.
#: Restored archives whose recorded version differs are rejected explicitly.
CHECKPOINT_SCHEMA_VERSION = 1

#: Sub-namespace under the run prefix. Kept separate from the final
#: ``jobs.tar.gz`` so summary publishing never collides with checkpoints.
CHECKPOINT_NAMESPACE = "_checkpoints"

#: Chunk segment of the prefix, e.g. ``chunk=0``.
def _chunk_segment(chunk_index: int) -> str:
    return f"chunk={int(chunk_index)}"

#: Name of the per-trial archive member holding metadata + checksum.
CHECKPOINT_META_NAME = "_checkpoint_meta.json"

#: Synthetic Harbor-style run directory used for restored checkpoints. Keeping
#: trials one level below ``jobs/`` makes them visible to reconciliation and
#: summary enumeration without mixing them into a real Harbor invocation.
CHECKPOINT_RESTORE_DIR = "_checkpoint-restored"


def checkpoint_prefix(run_prefix: str) -> str:
    """Top-level checkpoint namespace under a pipeline run prefix."""
    return f"{run_prefix.rstrip('/')}/{CHECKPOINT_NAMESPACE}"


def chunk_prefix(run_prefix: str, chunk_index: int) -> str:
    """Per-chunk checkpoint prefix (parent of the ``trials/`` directory)."""
    return f"{checkpoint_prefix(run_prefix)}/{_chunk_segment(chunk_index)}"


def trial_object_name(run_prefix: str, chunk_index: int, trial_id: str) -> str:
    """Deterministic GCS object name for one completed trial.

    ``trial_id`` is the Harbor trial directory name (``<task>__<suffix>``); it
    is unique within a job and stable across retries, so it is the natural
    deduplication key. The object name is content-independent (no checksum in
    the path) which makes listing/restore deterministic.
    """
    safe_id = _sanitize_trial_id(trial_id)
    return f"{chunk_prefix(run_prefix, chunk_index)}/trials/{safe_id}.tar.gz"


def run_metadata_object_name(run_prefix: str) -> str:
    """GCS object name for the pipeline run-metadata copy written to GCS."""
    return f"{checkpoint_prefix(run_prefix)}/run-metadata.json"


def run_metadata_lookup_object_name(project_id: str, pipeline_id: str) -> str:
    """Stable metadata bootstrap key known to the summary job.

    The canonical copy remains under ``<run-prefix>/_checkpoints``. This lookup
    copy breaks the bootstrap cycle when every chunk artifact containing the
    run prefix is unavailable.
    """
    safe_project = _sanitize_object_segment(project_id)
    safe_pipeline = _sanitize_object_segment(pipeline_id)
    return (
        f"{CHECKPOINT_NAMESPACE}/run-metadata/"
        f"project={safe_project}/pipeline={safe_pipeline}.json"
    )


def chunk_attempt_prefix(run_prefix: str, chunk_index: int) -> str:
    """Prefix containing immutable GitLab-job markers for one chunk."""
    return f"{chunk_prefix(run_prefix, chunk_index)}/attempts"


def chunk_attempt_object_name(
    run_prefix: str,
    chunk_index: int,
    job_id: str,
) -> str:
    """Immutable marker proving that a GitLab job attempt started."""
    safe_job_id = _sanitize_object_segment(job_id)
    return f"{chunk_attempt_prefix(run_prefix, chunk_index)}/job={safe_job_id}.json"


def chunk_status_prefix(run_prefix: str, chunk_index: int) -> str:
    """Prefix containing immutable completion status for chunk job attempts."""
    return f"{chunk_prefix(run_prefix, chunk_index)}/status"


def chunk_status_object_name(
    run_prefix: str,
    chunk_index: int,
    job_id: str,
) -> str:
    """Immutable status object written when a chunk attempt exits cleanly."""
    safe_job_id = _sanitize_object_segment(job_id)
    return f"{chunk_status_prefix(run_prefix, chunk_index)}/job={safe_job_id}.json"


# --- Trial-id / task helpers -----------------------------------------------

def trial_id_from_dir(trial_dir: Path) -> str:
    """The trial id is the Harbor trial directory name (``task__suffix``)."""
    return trial_dir.name


def task_from_trial_id(trial_id: str) -> str:
    """Bare task name from a trial id (everything before the last ``__``)."""
    return trial_id.rsplit("__", 1)[0]


def _sanitize_trial_id(trial_id: str) -> str:
    """Keep GCS object names free of characters that need URL-escaping.

    Harbor trial names are already ``[A-Za-z0-9._-]+``, but defend in depth so
    a future task id can never produce a pathological object name. In
    particular, runs of two or more dots (``..``) are collapsed to a single
    dash so an object name can never contain a path-traversal sequence,
    even though GCS keys are opaque strings rather than filesystem paths.
    Single dots are preserved (legit in names like ``install-windows-3.11``).
    """
    import re

    no_traversal = re.sub(r"\.{2,}", "-", trial_id)
    out = re.sub(r"[^A-Za-z0-9._-]+", "-", no_traversal)
    return out.strip("-") or "unknown-trial"


def _sanitize_object_segment(value: str) -> str:
    import re

    out = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value))
    return out.strip("-") or "unknown"


# --- Archive build / inspect / extract -------------------------------------

@dataclass(frozen=True)
class ArchiveMeta:
    """Parsed ``_checkpoint_meta.json`` from a checkpoint archive."""

    schema_version: int
    task_name: str
    trial_id: str
    payload_sha256: str


@dataclass(frozen=True)
class InspectedArchive:
    """Result of validating a downloaded checkpoint archive."""

    meta: ArchiveMeta
    ok: bool
    members: list[str]


def _iter_payload_members(tf: tarfile.TarFile) -> list[tarfile.TarInfo]:
    """All members except the metadata sidecar (the checksummed payload)."""
    return [m for m in tf.getmembers() if m.name != CHECKPOINT_META_NAME]


def _payload_checksum(members: list[tuple[str, bytes]]) -> str:
    """Stable sha256 over sorted ``arcname + \\0 + content`` of payload members.

    Independent of tar metadata (timestamps/mode/order) so it is reproducible
    after extraction. The metadata sidecar stores this value; on restore we
    recompute it over the downloaded payload and compare.
    """
    h = hashlib.sha256()
    for arcname, content in sorted(members, key=lambda mc: mc[0]):
        h.update(arcname.encode("utf-8"))
        h.update(b"\x00")
        h.update(content)
    return h.hexdigest()


def _collect_trial_members(trial_dir: Path) -> list[tuple[str, bytes]]:
    """Read every regular file under ``trial_dir`` as (relative-arcname, bytes).

    The arcname is relative to the trial directory and prefixed with the trial
    id root so extraction reproduces ``<trial-id>/...``. Symlinks are skipped
    (Harbor trial dirs do not rely on them, and following them risks escaping
    the staging copy during redaction).
    """
    trial_id = trial_id_from_dir(trial_dir)
    members: list[tuple[str, bytes]] = []
    for path in sorted(trial_dir.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(trial_dir)
        arcname = f"{trial_id}/{rel.as_posix()}"
        members.append((arcname, path.read_bytes()))
    return members


def _read_redact_secrets() -> list[bytes]:
    """Load the secret bytes to scrub from checkpoint archives.

    Reads ``KIMCHI_API_KEY`` (the only secret this benchmark injects) lazily so
    tests can set/unset the env var around the call. Empty/absent → no
    secrets, which is the local-dev case.
    """
    import os

    key = os.environ.get("KIMCHI_API_KEY", "")
    return [key.encode("utf-8")] if key else []


def create_trial_archive(
    trial_dir: Path,
    *,
    task_name: str,
    chunk_index: int,
    redact_secrets: list[bytes] | None = None,
) -> tuple[bytes, str]:
    """Build a redacted, checksummed checkpoint archive for one trial.

    The original trial directory is **never** read after staging: a temporary
    copy is made, redacted in place, then archived. This guarantees an
    unredacted secret can never reach GCS even if archiving fails midway.

    Args:
        trial_dir: the completed Harbor trial directory.
        task_name: bare task name (from ``result.json`` / trial id).
        chunk_index: owning chunk, recorded for traceability.
        redact_secrets: secret byte strings to scrub. ``None`` reads
            ``KIMCHI_API_KEY`` from the environment.

    Returns:
        ``(archive_bytes, payload_sha256)``. ``payload_sha256`` is the checksum
        stored inside the metadata sidecar and reused for idempotent uploads.
    """
    trial_id = trial_id_from_dir(trial_dir)
    secrets = redact_secrets if redact_secrets is not None else _read_redact_secrets()

    with tempfile.TemporaryDirectory(prefix="ckpt-stage-") as stage_str:
        stage_root = Path(stage_str)
        staged_trial = stage_root / trial_id
        # Copy first, then redact the copy — never touch the original.
        # Preserve links in the staging copy so neither copytree nor subsequent
        # redaction/archive collection can dereference a path outside the trial.
        # Both redact_tree() and _collect_trial_members() deliberately skip
        # symlinks.
        shutil.copytree(trial_dir, staged_trial, symlinks=True)
        if secrets:
            _redact_tree(staged_trial, secrets)

        members = _collect_trial_members(staged_trial)
        payload_sha256 = _payload_checksum(members)
        meta = {
            "schema_version": CHECKPOINT_SCHEMA_VERSION,
            "task_name": task_name,
            "trial_id": trial_id,
            "chunk_index": int(chunk_index),
            "payload_sha256": payload_sha256,
        }
        meta_bytes = json.dumps(meta, sort_keys=True).encode("utf-8")

        with tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024) as buf:
            # ``tarfile.open(mode="w:gz")`` writes the current time into the
            # gzip header. Build the gzip layer explicitly with mtime=0 so an
            # ambiguous upload can be retried with byte-identical content.
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=buf,
                mtime=0,
            ) as gzip_file, tarfile.open(fileobj=gzip_file, mode="w") as tf:
                for arcname, content in members:
                    info = tarfile.TarInfo(name=arcname)
                    info.size = len(content)
                    info.mtime = 0
                    info.mode = 0o644
                    tf.addfile(info, _BytesReader(content))
                meta_name = f"{trial_id}/{CHECKPOINT_META_NAME}"
                minfo = tarfile.TarInfo(name=meta_name)
                minfo.size = len(meta_bytes)
                minfo.mtime = 0
                minfo.mode = 0o644
                tf.addfile(minfo, _BytesReader(meta_bytes))

            buf.seek(0)
            archive_bytes = buf.read()
        return archive_bytes, payload_sha256


class _BytesReader:
    """Minimal file-like reader so tarfile can stream in-memory bytes."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self._data[self._pos:] if size is None or size < 0 else self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    def close(self) -> None:  # pragma: no cover - tarfile calls it
        pass


def inspect_archive(archive_bytes: bytes) -> InspectedArchive:
    """Parse + validate a downloaded checkpoint archive (no extraction).

    Reads the metadata sidecar, recomputes the payload checksum over the
    remaining members, and reports whether they match. A corrupt archive
    (missing/mismatched metadata or checksum) returns ``ok=False``; callers
    must treat that as an explicit failure rather than rerunning the trial.
    """
    import io

    meta: ArchiveMeta | None = None
    meta_member_names: list[str] = []
    payload_members: list[tuple[str, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile() and not member.isdir():
                return InspectedArchive(
                    meta=ArchiveMeta(schema_version=0, task_name="", trial_id="", payload_sha256=""),
                    ok=False,
                    members=[m for m, _ in payload_members],
                )
            if member.isdir():
                continue
            f = tf.extractfile(member)
            if f is None:
                return InspectedArchive(
                    meta=ArchiveMeta(schema_version=0, task_name="", trial_id="", payload_sha256=""),
                    ok=False,
                    members=[m for m, _ in payload_members],
                )
            content = f.read()
            if member.name.endswith(f"/{CHECKPOINT_META_NAME}") or member.name == CHECKPOINT_META_NAME:
                meta_member_names.append(member.name)
                meta = _parse_meta(content)
                continue
            payload_members.append((member.name, content))

    if meta is None or len(meta_member_names) != 1:
        return InspectedArchive(
            meta=ArchiveMeta(schema_version=0, task_name="", trial_id="", payload_sha256=""),
            ok=False,
            members=[m for m, _ in payload_members],
        )

    recomputed = _payload_checksum(payload_members)
    all_member_names = [name for name, _ in payload_members] + meta_member_names
    members_are_safe = all(
        _is_safe_archive_member(name, meta.trial_id) for name in all_member_names
    )
    expected_meta_name = f"{meta.trial_id}/{CHECKPOINT_META_NAME}"
    ok = (
        meta.schema_version == CHECKPOINT_SCHEMA_VERSION
        and recomputed == meta.payload_sha256
        and members_are_safe
        and meta_member_names == [expected_meta_name]
        and len(all_member_names) == len(set(all_member_names))
    )
    return InspectedArchive(meta=meta, ok=ok, members=[m for m, _ in payload_members])


def _is_safe_archive_member(name: str, trial_id: str) -> bool:
    """Require a relative path rooted exactly at the metadata trial id."""
    path = PurePosixPath(name)
    return (
        bool(trial_id)
        and not path.is_absolute()
        and len(path.parts) >= 2
        and path.parts[0] == trial_id
        and all(part not in ("", ".", "..") for part in path.parts)
    )


def _parse_meta(content: bytes) -> ArchiveMeta | None:
    try:
        data = json.loads(content.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return ArchiveMeta(
            schema_version=int(data["schema_version"]),
            task_name=str(data["task_name"]),
            trial_id=str(data["trial_id"]),
            payload_sha256=str(data["payload_sha256"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def extract_trial_archive(archive_bytes: bytes, dest_dir: Path) -> Path:
    """Safely extract a checkpoint archive into ``dest_dir``.

    The archive root is the trial-id directory; extraction reproduces
    ``dest_dir/<trial-id>/...``. Path traversal (zip-slip) is refused: every
    member must resolve inside ``dest_dir``. Returns the extracted trial dir.

    Extraction is staged outside ``dest_dir`` and then renamed into place, so
    interruption cannot expose a partial trial. Re-extraction removes a prior
    checkpoint copy only after staging succeeds; callers deduplicate GitLab
    overlap before invoking this function.
    """
    import io

    try:
        inspected = inspect_archive(archive_bytes)
    except (OSError, tarfile.TarError) as exc:
        raise CheckpointCorruptError(f"invalid checkpoint archive: {exc}") from exc
    if not inspected.ok:
        raise CheckpointCorruptError("checkpoint archive failed schema, checksum, or path validation")

    dest_dir.mkdir(parents=True, exist_ok=True)
    # Build the complete trial outside ``dest_dir`` and expose it with one
    # rename. A killed restore can leave an orphaned staging directory, but it
    # can never leave a half-populated directory at the final trial path.
    with tempfile.TemporaryDirectory(
        prefix=".checkpoint-extract-",
        dir=dest_dir.parent,
    ) as staging_str:
        staging_root = Path(staging_str)
        staging_abs = staging_root.resolve()
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tf:
            for member in tf.getmembers():
                target = (staging_root / member.name).resolve()
                try:
                    target.relative_to(staging_abs)
                except ValueError as exc:  # inspect_archive also rejects this
                    raise CheckpointCorruptError(
                        f"unsafe path in checkpoint archive: {member.name}"
                    ) from exc
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    raise CheckpointCorruptError(
                        f"unreadable member in checkpoint archive: {member.name}"
                    )
                target.write_bytes(src.read())

        staged_trial = staging_root / inspected.meta.trial_id
        final_trial = dest_dir / inspected.meta.trial_id
        if final_trial.exists():
            shutil.rmtree(final_trial)
        staged_trial.replace(final_trial)
        return final_trial


# --- Redaction (reusable, Phase 2) -----------------------------------------

def _redact_tree(root: Path, secrets: list[bytes]) -> int:
    """Redact a staging tree in place. Returns the count of files modified.

    Thin wrapper around :func:`redact_api_key.redact_tree` so this module
    stays decoupled from the redaction implementation. Imported lazily so the
    GitLab-scripts directory only needs to be importable when actually
    redacting (the Harbor plugin adds it to ``sys.path`` via a plugin kwarg).
    """
    if not secrets:
        return 0
    from redact_api_key import redact_tree  # local import: keeps dep optional

    before = sum(1 for p in root.rglob("*") if p.is_file())
    redact_tree(root, secrets)
    return before


# --- GCS transport via `gcloud storage` -----------------------------------

class SubprocessRunner(Protocol):
    """Callable that runs a command and returns (returncode, stdout, stderr)."""

    def __call__(self, cmd: list[str], *, timeout: float | None = ...) -> tuple[int, str, str]: ...


def _real_runner(cmd: list[str], *, timeout: float | None = None) -> tuple[int, str, str]:
    """Run a command capturing output. Never raises on non-zero (caller checks)."""
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def gcs_object_checksum(
    bucket: str,
    object_name: str,
    *,
    runner: SubprocessRunner = _real_runner,
) -> str | None:
    """Return the Base64-encoded MD5 of an existing object, or None if absent.

    Uses ``gcloud storage objects describe``. The md5 is GCS's own object
    checksum, independent of our payload checksum — it lets us tell whether an
    existing object already holds identical bytes before re-uploading.
    """
    rc, out, _err = runner(
        ["gcloud", "storage", "objects", "describe", f"gs://{bucket}/{object_name}",
         "--format=value(md5_hash)"],
        timeout=60,
    )
    if rc != 0:
        # 404 / not-found → absent. gcloud prints a message but returns non-zero.
        return None
    md5 = out.strip()
    return md5 or None


def gcs_upload_object(
    bucket: str,
    object_name: str,
    data: bytes,
    *,
    content_type: str = "application/octet-stream",
    retries: int = 5,
    base_delay: float = 1.0,
    runner: SubprocessRunner = _real_runner,
) -> None:
    """Upload ``data`` to ``gs://bucket/object_name`` with bounded retries.

    Idempotent: if an existing object already holds identical bytes (matching
    GCS md5), the upload is skipped. On exhausted retries the last error is
    raised so the caller can apply the checkpoint-failure policy.

    Uploads go through a temp file because ``gcloud storage cp`` reads from a
    path more reliably than from stdin across gcloud versions.
    """
    existing = gcs_object_checksum(bucket, object_name, runner=runner)
    local_md5 = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")
    if existing is not None:
        if existing == local_md5:
            logger.info("checkpoint object already durable, skipping upload: %s", object_name)
            return
        raise CheckpointUploadError(
            f"refusing to overwrite immutable checkpoint gs://{bucket}/{object_name}: "
            f"existing checksum {existing!r} differs from {local_md5!r}"
        )

    last_err = ""
    for attempt in range(1, retries + 1):
        with tempfile.NamedTemporaryFile(prefix="ckpt-up-", suffix=".tar.gz") as tmp:
            tmp.write(data)
            tmp.flush()
            rc, _out, err = runner(
                ["gcloud", "storage", "cp", tmp.name, f"gs://{bucket}/{object_name}",
                 "--content-type", content_type, "--if-generation-match=0", "--quiet"],
                timeout=600,
            )
        if rc == 0:
            # Verify the upload landed with matching bytes.
            got = gcs_object_checksum(bucket, object_name, runner=runner)
            if got == local_md5:
                return
            last_err = f"post-upload checksum mismatch (got={got})"
        else:
            last_err = err.strip() or f"gcloud exited {rc}"
            # A request can commit even when the client observes a transient
            # error, and another chunk can win the create-only race.
            got = gcs_object_checksum(bucket, object_name, runner=runner)
            if got == local_md5:
                return
            if got is not None:
                raise CheckpointUploadError(
                    f"refusing to overwrite immutable checkpoint "
                    f"gs://{bucket}/{object_name}: existing checksum "
                    f"{got!r} differs from {local_md5!r}"
                )
        if attempt < retries:
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(
                "checkpoint upload attempt %d/%d failed for %s: %s (retrying in %.1fs)",
                attempt, retries, object_name, last_err, delay,
            )
            time.sleep(delay)
    raise CheckpointUploadError(
        f"failed to upload gs://{bucket}/{object_name} after {retries} attempts: {last_err}"
    )


def gcs_list_objects(
    bucket: str,
    prefix: str,
    *,
    runner: SubprocessRunner = _real_runner,
) -> list[str]:
    """List object names under a GCS prefix.

    Returns bare object names (relative to the bucket), e.g.
    ``_checkpoints/chunk=0/trials/foo__abc.tar.gz``.

    ``gcloud storage ls`` handles API pagination internally. A ``/**`` glob
    requests flat recursive output; unlike ``--recursive``, it does not add
    directory headers. The storage command rejects generic gcloud
    ``--format`` values, so the default URL output is parsed directly.
    """
    names: list[str] = []
    cmd = [
        "gcloud",
        "storage",
        "ls",
        f"gs://{bucket}/{prefix.rstrip('/')}/**",
    ]
    rc, out, err = runner(cmd, timeout=120)
    if rc != 0:
        detail = err.strip() or f"gcloud exited {rc}"
        if "matched no objects" in detail.lower():
            return names
        raise CheckpointRestoreError(
            f"failed to list gs://{bucket}/{prefix}: {detail}"
        )
    bucket_prefix = f"gs://{bucket}/"
    for line in out.splitlines():
        url = line.strip()
        if not url.startswith(bucket_prefix):
            continue
        stripped = url.removeprefix(bucket_prefix)
        if stripped and stripped != prefix:
            names.append(stripped)
    return names


def gcs_download_object(
    bucket: str,
    object_name: str,
    *,
    runner: SubprocessRunner = _real_runner,
) -> bytes | None:
    """Download a GCS object's bytes, or None if it does not exist."""
    with tempfile.NamedTemporaryFile(prefix="ckpt-dl-", suffix=".tar.gz") as tmp:
        rc, _out, _err = runner(
            ["gcloud", "storage", "cp", f"gs://{bucket}/{object_name}", tmp.name, "--quiet"],
            timeout=600,
        )
        if rc != 0:
            logger.warning("gcs_download_object failed for %s: %s", object_name, _err.strip())
            return None
        return Path(tmp.name).read_bytes()


def gcs_upload_bytes(
    bucket: str,
    object_name: str,
    data: bytes,
    *,
    content_type: str = "application/octet-stream",
    retries: int = 5,
    runner: SubprocessRunner = _real_runner,
) -> None:
    """Upload arbitrary bytes (e.g. run-metadata.json) to GCS with retries."""
    gcs_upload_object(
        bucket, object_name, data,
        content_type=content_type, retries=retries, runner=runner,
    )


def register_chunk_attempt(
    *,
    bucket: str,
    run_prefix: str,
    chunk_index: int,
    job_id: str,
    retries: int = 5,
    runner: SubprocessRunner = _real_runner,
) -> int:
    """Register this GitLab job and return its durable 1-based chunk attempt.

    Each GitLab retry has a distinct job id. Immutable markers survive even
    when the runner pod dies before GitLab can upload ``chunk-meta``. Re-running
    this function for the same job is idempotent.
    """
    if not job_id:
        raise CheckpointUploadError("CI_JOB_ID is required to register a chunk attempt")
    marker = chunk_attempt_object_name(run_prefix, chunk_index, job_id)
    payload = (
        json.dumps(
            {"chunk_index": int(chunk_index), "job_id": str(job_id)},
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    gcs_upload_bytes(
        bucket,
        marker,
        payload,
        content_type="application/json",
        retries=retries,
        runner=runner,
    )
    names = gcs_list_objects(
        bucket,
        chunk_attempt_prefix(run_prefix, chunk_index),
        runner=runner,
    )
    markers = {
        name
        for name in names
        if name.startswith(f"{chunk_attempt_prefix(run_prefix, chunk_index)}/job=")
        and name.endswith(".json")
    }
    if marker not in markers:
        raise CheckpointRestoreError(
            f"durable chunk-attempt marker was not listed after upload: {marker}"
        )
    return len(markers)


def restore_chunk_statuses(
    *,
    bucket: str,
    run_prefix: str,
    dest_dir: Path,
    chunk_count: int,
    runner: SubprocessRunner = _real_runner,
) -> int:
    """Restore the newest durable ``chunk-meta`` status for every chunk.

    Status objects are immutable and job-scoped. The payload's explicit
    ``chunk_attempt`` determines recency, so this remains correct even when
    GitLab job IDs are not lexically sortable. Existing GitLab artifact
    metadata is retained when it records an equal or newer attempt.
    """
    if chunk_count < 1:
        raise ValueError("chunk_count must be positive")

    meta_dir = dest_dir / "chunk-meta"
    restored = 0
    for chunk_index in range(chunk_count):
        names = gcs_list_objects(
            bucket,
            chunk_status_prefix(run_prefix, chunk_index),
            runner=runner,
        )
        latest: dict | None = None
        for name in names:
            if not name.endswith(".json"):
                continue
            data = gcs_download_object(bucket, name, runner=runner)
            if data is None:
                raise CheckpointRestoreError(
                    f"listed chunk status could not be downloaded: {name}"
                )
            status = _parse_chunk_status(data, name, expected_chunk=chunk_index)
            if latest is None or status["chunk_attempt"] > latest["chunk_attempt"]:
                latest = status

        if latest is None:
            continue

        meta_path = meta_dir / f"chunk-{chunk_index}.json"
        existing_attempt = 0
        if meta_path.is_file():
            try:
                existing = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(existing, dict) and isinstance(
                    existing.get("chunk_attempt"), int
                ):
                    existing_attempt = existing["chunk_attempt"]
            except (OSError, json.JSONDecodeError):
                existing_attempt = 0
        if existing_attempt >= latest["chunk_attempt"]:
            continue

        meta_dir.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(
            json.dumps(latest, indent=2) + "\n",
            encoding="utf-8",
        )
        restored += 1
    return restored


def _parse_chunk_status(
    data: bytes,
    source: str,
    *,
    expected_chunk: int,
) -> dict:
    try:
        status = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: {exc}"
        ) from exc
    if not isinstance(status, dict):
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: expected an object"
        )
    if status.get("chunk_index") != expected_chunk:
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: chunk_index does not match "
            f"{expected_chunk}"
        )
    if (
        not isinstance(status.get("chunk_attempt"), int)
        or status["chunk_attempt"] < 1
    ):
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: chunk_attempt must be positive"
        )
    if not isinstance(status.get("exit_code"), int):
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: exit_code must be an integer"
        )
    needs_retry = status.get("needs_retry")
    if not isinstance(needs_retry, list) or not all(
        isinstance(task, str) for task in needs_retry
    ):
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: needs_retry must be a string list"
        )
    if not isinstance(status.get("exhausted"), bool):
        raise CheckpointCorruptError(
            f"invalid chunk status {source}: exhausted must be boolean"
        )
    return status


# --- Restore orchestration (Phase 4) ---------------------------------------

@dataclass(frozen=True)
class RestoredTrial:
    """A trial restored from GCS checkpoints."""

    trial_id: str
    task_name: str
    trial_dir: Path
    source: str  # "gcs" | "gitlab"


@dataclass(frozen=True)
class RestoreResult:
    """Outcome of restoring checkpoints for one chunk."""

    restored: list[RestoredTrial]
    duplicates: int
    corrupt: int
    missing: int


def restore_chunk_checkpoints(
    *,
    bucket: str,
    run_prefix: str,
    chunk_index: int,
    dest_dir: Path,
    runner: SubprocessRunner = _real_runner,
    on_object: Callable[[str, bool], None] | None = None,
) -> RestoreResult:
    """Download + validate + extract every checkpoint for one chunk.

    Tolerates repeated downloads, duplicate trial ids, interrupted restores,
    empty checkpoint prefixes, listing pagination, and GitLab overlap. A
    listed object that cannot be downloaded or validated raises explicitly so
    callers never rerun expensive work after silently discarding durable data.
    """
    prefix = f"{chunk_prefix(run_prefix, chunk_index)}/trials/"
    names = gcs_list_objects(bucket, prefix, runner=runner)

    restored: list[RestoredTrial] = []
    seen: set[str] = set()
    duplicates = 0
    corrupt = 0

    for name in names:
        object_name = name
        try:
            data = gcs_download_object(bucket, object_name, runner=runner)
            inspected = inspect_archive(data) if data is not None else None
        except Exception as exc:
            if on_object:
                on_object(object_name, False)
            raise CheckpointCorruptError(
                f"corrupt checkpoint {object_name}: {exc}"
            ) from exc
        if data is None or inspected is None or not inspected.ok:
            if on_object:
                on_object(object_name, False)
            raise CheckpointCorruptError(
                f"corrupt or unreadable checkpoint {object_name}"
            )
        trial_id = inspected.meta.trial_id
        if trial_id in seen:
            duplicates += 1
            continue
        restored_trial = _reuse_or_restore_trial(
            archive_bytes=data,
            dest_dir=dest_dir,
            inspected=inspected,
        )
        seen.add(trial_id)
        restored.append(restored_trial)
        if on_object:
            on_object(object_name, True)

    return RestoreResult(
        restored=restored,
        duplicates=duplicates,
        corrupt=corrupt,
        missing=0,
    )


def _find_existing_trial_dir(dest_dir: Path, trial_id: str) -> Path | None:
    """Find an existing top-level or Harbor-style nested trial by exact id."""
    immediate = dest_dir / trial_id
    if immediate.is_dir():
        return immediate
    if not dest_dir.is_dir():
        return None
    for run_dir in sorted(path for path in dest_dir.iterdir() if path.is_dir()):
        candidate = run_dir / trial_id
        if candidate.is_dir():
            return candidate
    return None


def _restored_trial_matches(
    trial_dir: Path,
    inspected: InspectedArchive,
) -> bool:
    """Verify that a checkpoint-restored directory is complete."""
    meta_path = trial_dir / CHECKPOINT_META_NAME
    try:
        local_meta = _parse_meta(meta_path.read_bytes())
        members = [
            member
            for member in _collect_trial_members(trial_dir)
            if member[0] != f"{inspected.meta.trial_id}/{CHECKPOINT_META_NAME}"
        ]
    except OSError:
        return False
    return (
        local_meta == inspected.meta
        and sorted(name for name, _ in members) == sorted(inspected.members)
        and _payload_checksum(members) == inspected.meta.payload_sha256
    )


def _gitlab_trial_matches(
    trial_dir: Path,
    inspected: InspectedArchive,
) -> bool:
    """Verify that a GitLab artifact copy is complete and has the same identity.

    GitLab copies may contain an enriched ``result.json`` written after the
    checkpoint hook ran, so byte-for-byte checksum comparison would reject a
    legitimate local copy. Instead, require every checkpoint payload member to
    exist and validate the authoritative trial/task identity in ``result.json``.
    """
    try:
        result = json.loads((trial_dir / "result.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(result, dict):
        return False

    trial_name = result.get("trial_name")
    task_name = result.get("task_name")
    if (
        trial_name != inspected.meta.trial_id
        or not isinstance(task_name, str)
        or task_name.rsplit("/", 1)[-1] != inspected.meta.task_name
    ):
        return False

    for member_name in inspected.members:
        parts = PurePosixPath(member_name).parts
        local_member = trial_dir.joinpath(*parts[1:])
        if not local_member.is_file() or local_member.is_symlink():
            return False
    return True


def _reuse_or_restore_trial(
    *,
    archive_bytes: bytes,
    dest_dir: Path,
    inspected: InspectedArchive,
) -> RestoredTrial:
    """Reuse a valid overlap, otherwise replace it with the durable checkpoint."""
    trial_id = inspected.meta.trial_id
    restore_root = dest_dir / CHECKPOINT_RESTORE_DIR
    existing = _find_existing_trial_dir(dest_dir, trial_id)
    if existing is not None:
        is_checkpoint_copy = existing.parent == restore_root
        valid = (
            _restored_trial_matches(existing, inspected)
            if is_checkpoint_copy
            else _gitlab_trial_matches(existing, inspected)
        )
        if valid:
            return RestoredTrial(
                trial_id=trial_id,
                task_name=inspected.meta.task_name,
                trial_dir=existing,
                source="gcs" if is_checkpoint_copy else "gitlab",
            )

        # Replace an invalid overlap in its original run directory. Leaving it
        # in place would let reconciliation prefer it over _checkpoint-restored
        # on the next scan because local run directories have higher priority.
        logger.warning(
            "replacing incomplete local trial with durable checkpoint: %s",
            existing,
        )
        extraction_root = existing.parent
    else:
        extraction_root = restore_root

    extracted = extract_trial_archive(archive_bytes, extraction_root)
    return RestoredTrial(
        trial_id=trial_id,
        task_name=inspected.meta.task_name,
        trial_dir=extracted,
        source="gcs",
    )


def restore_all_chunk_checkpoints(
    *,
    bucket: str,
    run_prefix: str,
    dest_dir: Path,
    runner: SubprocessRunner = _real_runner,
    chunk_count: int | None = None,
) -> RestoreResult:
    """Restore checkpoints across every chunk (used by the summary job).

    When ``chunk_count`` is given, iterates ``chunk=0..chunk_count-1``;
    otherwise lists the whole ``_checkpoints/`` namespace and groups by the
    ``chunk=N`` segment. Either way, trial-id deduplication is global so a
    trial that appears under two chunks (shouldn't happen, but defensively)
    is counted once.
    """
    if chunk_count is not None:
        restored: list[RestoredTrial] = []
        dups = corrupt = 0
        for ci in range(chunk_count):
            r = restore_chunk_checkpoints(
                bucket=bucket, run_prefix=run_prefix, chunk_index=ci,
                dest_dir=dest_dir, runner=runner,
            )
            # Dedup against what we already restored.
            existing_ids = {t.trial_id for t in restored}
            for t in r.restored:
                if t.trial_id in existing_ids:
                    dups += 1
                    continue
                restored.append(t)
                existing_ids.add(t.trial_id)
            dups += r.duplicates
            corrupt += r.corrupt
        return RestoreResult(restored=restored, duplicates=dups, corrupt=corrupt, missing=0)

    # Fall back to a full namespace listing.
    names = gcs_list_objects(bucket, checkpoint_prefix(run_prefix), runner=runner)
    restored = []
    seen: set[str] = set()
    dups = corrupt = 0
    for name in names:
        if "/trials/" not in name or not name.endswith(".tar.gz"):
            continue
        data = gcs_download_object(bucket, name, runner=runner)
        if data is None:
            raise CheckpointRestoreError(
                f"listed checkpoint could not be downloaded: {name}"
            )
        try:
            inspected = inspect_archive(data)
        except Exception as exc:
            raise CheckpointCorruptError(
                f"corrupt checkpoint {name}: {exc}"
            ) from exc
        if not inspected.ok:
            raise CheckpointCorruptError(f"corrupt checkpoint {name}")
        tid = inspected.meta.trial_id
        if tid in seen:
            dups += 1
            continue
        restored_trial = _reuse_or_restore_trial(
            archive_bytes=data,
            dest_dir=dest_dir,
            inspected=inspected,
        )
        seen.add(tid)
        restored.append(restored_trial)
    return RestoreResult(restored=restored, duplicates=dups, corrupt=corrupt, missing=0)


# --- Errors ----------------------------------------------------------------

class CheckpointError(Exception):
    """Base class for checkpoint infrastructure failures."""


class CheckpointUploadError(CheckpointError):
    """A checkpoint could not be made durable after all retries."""


class CheckpointRestoreError(CheckpointError):
    """Checkpoint storage could not be enumerated or downloaded reliably."""


class CheckpointCorruptError(CheckpointError):
    """A downloaded checkpoint failed schema/checksum verification."""


__all__ = [
    "CHECKPOINT_META_NAME",
    "CHECKPOINT_NAMESPACE",
    "CHECKPOINT_RESTORE_DIR",
    "CHECKPOINT_SCHEMA_VERSION",
    "ArchiveMeta",
    "CheckpointCorruptError",
    "CheckpointError",
    "CheckpointRestoreError",
    "CheckpointUploadError",
    "InspectedArchive",
    "RestoreResult",
    "RestoredTrial",
    "SubprocessRunner",
    "checkpoint_prefix",
    "chunk_attempt_object_name",
    "chunk_attempt_prefix",
    "chunk_prefix",
    "chunk_status_object_name",
    "chunk_status_prefix",
    "create_trial_archive",
    "extract_trial_archive",
    "gcs_download_object",
    "gcs_list_objects",
    "gcs_object_checksum",
    "gcs_upload_bytes",
    "gcs_upload_object",
    "inspect_archive",
    "register_chunk_attempt",
    "restore_all_chunk_checkpoints",
    "restore_chunk_checkpoints",
    "restore_chunk_statuses",
    "run_metadata_lookup_object_name",
    "run_metadata_object_name",
    "task_from_trial_id",
    "trial_id_from_dir",
    "trial_object_name",
]
