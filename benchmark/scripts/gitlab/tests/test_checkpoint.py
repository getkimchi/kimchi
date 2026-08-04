"""Unit tests for checkpoint.py — archive semantics, transport, restore, redaction.

Covers Phase 1 (naming/schema), Phase 2 (redaction reuse), Phase 3 (archive
build + checksum), Phase 4 (restore/dedup/corrupt), and the "no secret in
checkpoint storage" acceptance criterion.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

import checkpoint as ckpt

_RUN_PREFIX = "runs/benchmark=tb2/coding_agent=kimchi/run=gitlab-p1"
_BUCKET = "bench-checkpoints"


# ---------------------------------------------------------------------------
# Phase 1: deterministic GCS object naming
# ---------------------------------------------------------------------------

class TestObjectNaming:
    def test_trial_object_name_is_deterministic_and_chunk_scoped(self) -> None:
        name = ckpt.trial_object_name(_RUN_PREFIX, chunk_index=0, trial_id="fix-git__abc1234")
        assert name == f"{_RUN_PREFIX}/{ckpt.CHECKPOINT_NAMESPACE}/chunk=0/trials/fix-git__abc1234.tar.gz"

    def test_checkpoint_namespace_is_separate_from_jobs_tar(self) -> None:
        # jobs.tar.gz lands at <run-prefix>/jobs.tar.gz; checkpoints live under
        # _checkpoints/ — they must never collide.
        trial = ckpt.trial_object_name(_RUN_PREFIX, 0, "t__1")
        jobs = f"{_RUN_PREFIX}/jobs.tar.gz"
        assert not trial.startswith(jobs)
        assert ckpt.CHECKPOINT_NAMESPACE in trial
        assert ckpt.CHECKPOINT_NAMESPACE not in jobs

    def test_run_metadata_object_name_lives_under_checkpoints(self) -> None:
        name = ckpt.run_metadata_object_name(_RUN_PREFIX)
        assert name == f"{_RUN_PREFIX}/{ckpt.CHECKPOINT_NAMESPACE}/run-metadata.json"

    def test_chunk_status_object_name_is_attempt_scoped(self) -> None:
        name = ckpt.chunk_status_object_name(
            _RUN_PREFIX,
            chunk_index=2,
            job_id="12345",
        )
        assert name == (
            f"{_RUN_PREFIX}/{ckpt.CHECKPOINT_NAMESPACE}/"
            "chunk=2/status/job=12345.json"
        )

    def test_sanitize_trial_id_replaces_unsafe_chars(self) -> None:
        # Defensive: Harbor trial ids are already safe, but a future task id
        # must never produce a path-traversal object name.
        name = ckpt.trial_object_name(_RUN_PREFIX, 0, "ev/..../il")
        assert ".." not in name.split("/")[-1]
        assert name.endswith(".tar.gz")

    def test_trial_id_and_task_helpers(self, tmp_path: Path) -> None:
        trial_dir = tmp_path / "fix-git__abc"
        assert ckpt.trial_id_from_dir(trial_dir) == "fix-git__abc"
        assert ckpt.task_from_trial_id("fix-git__abc") == "fix-git"


# ---------------------------------------------------------------------------
# Phase 1 + 3: archive build / inspect / extract (checksum + schema)
# ---------------------------------------------------------------------------

def _make_trial(trial_dir: Path, *, result: dict | None = None, extra: dict[str, bytes] | None = None) -> None:
    trial_dir.mkdir(parents=True, exist_ok=True)
    (trial_dir / "result.json").write_text(json.dumps(result or {
        "trial_name": trial_dir.name,
        "verifier_result": {"rewards": {"reward": 1.0}},
        "task_name": trial_dir.name.split("__", 1)[0],
    }))
    (trial_dir / "config.json").write_text("{}")
    (trial_dir / "lock.json").write_text("{}")
    (trial_dir / "agent").mkdir()
    (trial_dir / "agent" / "kimchi.txt").write_text("agent log\n")
    (trial_dir / "verifier").mkdir()
    (trial_dir / "verifier" / "test-stdout.txt").write_text("tests passed\n")
    for rel, data in (extra or {}).items():
        p = trial_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


class TestArchiveRoundTrip:
    def test_build_then_inspect_validates(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, sha = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        assert sha and isinstance(archive, bytes)

        inspected = ckpt.inspect_archive(archive)
        assert inspected.ok is True
        assert inspected.meta.schema_version == ckpt.CHECKPOINT_SCHEMA_VERSION
        assert inspected.meta.task_name == "fix-git"
        assert inspected.meta.trial_id == "fix-git__abc1234"
        assert inspected.meta.payload_sha256 == sha

    def test_extract_reproduces_trial_dir(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=2)
        dest = tmp_path / "restore"
        extracted = ckpt.extract_trial_archive(archive, dest)
        assert extracted.name == "fix-git__abc1234"
        assert (extracted / "result.json").is_file()
        assert (extracted / "agent" / "kimchi.txt").read_text() == "agent log\n"

    def test_checksum_is_reproducible_across_builds(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        _, sha1 = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        _, sha2 = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        assert sha1 == sha2

    def test_archive_bytes_are_reproducible_across_build_times(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Immutable object retries must rebuild byte-identical archives."""
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        now = [100.0]
        monkeypatch.setattr(ckpt.time, "time", lambda: now[0])

        archive1, _ = ckpt.create_trial_archive(
            trial, task_name="fix-git", chunk_index=0
        )
        now[0] = 200.0
        archive2, _ = ckpt.create_trial_archive(
            trial, task_name="fix-git", chunk_index=0
        )

        assert archive1 == archive2

    def test_checksum_changes_when_content_changes(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        _, sha1 = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        (trial / "agent" / "kimchi.txt").write_text("changed log\n")
        _, sha2 = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        assert sha1 != sha2

    def test_archive_does_not_follow_symlinks_outside_trial(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        outside = tmp_path / "host-credential"
        outside.write_bytes(b"credential-that-must-not-be-uploaded")
        (trial / "artifacts").mkdir()
        (trial / "artifacts" / "credential-link").symlink_to(outside)

        archive, _ = ckpt.create_trial_archive(
            trial,
            task_name="fix-git",
            chunk_index=0,
        )

        assert outside.read_bytes() not in archive
        inspected = ckpt.inspect_archive(archive)
        assert inspected.ok is True
        assert not any(name.endswith("credential-link") for name in inspected.members)

    def test_corrupt_archive_detected_on_inspect(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        # Flip a byte in the payload (not the metadata) to break the checksum.
        # Easier: rebuild with content changed, then tamper with result.json
        # bytes inside the archive so the recomputed checksum mismatches.
        buf = io.BytesIO(archive)
        with tarfile.open(fileobj=buf, mode="r:gz") as tf:
            members = [m for m in tf.getmembers() if m.name.endswith("result.json")]
            assert members
            tampered = tf.extractfile(members[0]).read()
        tampered = tampered.replace(b'"reward": 1.0', b'"reward": 0.0')
        # Rebuild archive with tampered member.
        new_buf = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf_in, \
             tarfile.open(fileobj=new_buf, mode="w:gz") as tf_out:
            for m in tf_in.getmembers():
                if m.name.endswith("result.json"):
                    info = tarfile.TarInfo(name=m.name)
                    info.size = len(tampered)
                    info.mtime = 0
                    tf_out.addfile(info, io.BytesIO(tampered))
                else:
                    tf_out.addfile(m, tf_in.extractfile(m))
        corrupted = new_buf.getvalue()
        inspected = ckpt.inspect_archive(corrupted)
        assert inspected.ok is False

    def test_missing_metadata_sidecar_is_corrupt(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        # Strip the metadata sidecar from the archive.
        new_buf = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf_in, \
             tarfile.open(fileobj=new_buf, mode="w:gz") as tf_out:
            for m in tf_in.getmembers():
                if m.name.endswith(ckpt.CHECKPOINT_META_NAME):
                    continue
                tf_out.addfile(m, tf_in.extractfile(m))
        inspected = ckpt.inspect_archive(new_buf.getvalue())
        assert inspected.ok is False

    def test_wrong_schema_version_is_corrupt(self, tmp_path: Path) -> None:
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        # Rewrite the metadata sidecar with a future schema version.
        new_buf = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf_in, \
             tarfile.open(fileobj=new_buf, mode="w:gz") as tf_out:
            for m in tf_in.getmembers():
                if m.name.endswith(ckpt.CHECKPOINT_META_NAME):
                    raw = tf_in.extractfile(m).read()
                    meta = json.loads(raw)
                    meta["schema_version"] = ckpt.CHECKPOINT_SCHEMA_VERSION + 1
                    payload = json.dumps(meta, sort_keys=True).encode()
                    info = tarfile.TarInfo(name=m.name)
                    info.size = len(payload)
                    info.mtime = 0
                    tf_out.addfile(info, io.BytesIO(payload))
                else:
                    tf_out.addfile(m, tf_in.extractfile(m))
        inspected = ckpt.inspect_archive(new_buf.getvalue())
        assert inspected.ok is False

    @pytest.mark.parametrize(
        "replacement",
        ["../../outside/result.json", "different-trial/result.json"],
    )
    def test_valid_checksum_with_invalid_member_root_is_corrupt(
        self,
        tmp_path: Path,
        replacement: str,
    ) -> None:
        """Path validation is part of archive integrity, not a best-effort skip."""
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(
            trial, task_name="fix-git", chunk_index=0
        )

        payload: list[tuple[str, bytes]] = []
        meta: dict | None = None
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf:
            for member in tf.getmembers():
                content = tf.extractfile(member).read()
                if member.name.endswith(ckpt.CHECKPOINT_META_NAME):
                    meta = json.loads(content)
                elif member.name.endswith("/result.json"):
                    payload.append((replacement, content))
                else:
                    payload.append((member.name, content))
        assert meta is not None
        meta["payload_sha256"] = ckpt._payload_checksum(payload)

        rebuilt = io.BytesIO()
        with tarfile.open(fileobj=rebuilt, mode="w:gz") as tf:
            for name, content in payload:
                info = tarfile.TarInfo(name=name)
                info.size = len(content)
                tf.addfile(info, io.BytesIO(content))
            meta_bytes = json.dumps(meta, sort_keys=True).encode()
            meta_info = tarfile.TarInfo(
                name=f"{meta['trial_id']}/{ckpt.CHECKPOINT_META_NAME}"
            )
            meta_info.size = len(meta_bytes)
            tf.addfile(meta_info, io.BytesIO(meta_bytes))

        malformed = rebuilt.getvalue()
        assert ckpt.inspect_archive(malformed).ok is False
        with pytest.raises(ckpt.CheckpointCorruptError):
            ckpt.extract_trial_archive(malformed, tmp_path / "restore")


# ---------------------------------------------------------------------------
# Phase 2: redaction before upload (never upload the original unredacted)
# ---------------------------------------------------------------------------

class TestRedactionBeforeUpload:
    def test_api_key_scrubbed_from_archive(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        secret = "sk-super-secret-key-12345"
        monkeypatch.setenv("KIMCHI_API_KEY", secret)
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial, extra={"agent/kimchi.txt": f"key={secret}\n".encode()})
        archive, _ = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        assert secret.encode() not in archive

    def test_original_trial_dir_is_not_mutated(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        secret = "sk-super-secret-key-12345"
        monkeypatch.setenv("KIMCHI_API_KEY", secret)
        trial = tmp_path / "fix-git__abc1234"
        original = f"key={secret}\n"
        _make_trial(trial, extra={"agent/kimchi.txt": original.encode()})
        ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        # The original must still contain the secret (staging copy was redacted).
        assert (trial / "agent" / "kimchi.txt").read_text() == original

    def test_no_secrets_env_unset_still_builds(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("KIMCHI_API_KEY", raising=False)
        trial = tmp_path / "fix-git__abc1234"
        _make_trial(trial)
        archive, sha = ckpt.create_trial_archive(trial, task_name="fix-git", chunk_index=0)
        assert sha and archive


# ---------------------------------------------------------------------------
# Phase 4: restore orchestration (dedup, corrupt, missing, overlap)
# ---------------------------------------------------------------------------

class _FakeRunner:
    """In-memory gcloud transport for restore tests."""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self._objects = dict(objects)

    def __call__(self, cmd: list[str], *, timeout: float | None = None) -> tuple[int, str, str]:
        # gcloud storage objects describe <url> --format=md5_hash
        if "objects" in cmd and "describe" in cmd:
            url = next(a for a in cmd if a.startswith("gs://"))
            obj = url.removeprefix(f"gs://{_BUCKET}/")
            if obj in self._objects:
                import hashlib
                digest = hashlib.md5(self._objects[obj]).digest()
                return 0, base64.b64encode(digest).decode("ascii"), ""
            return 1, "", "not found"
        # gcloud storage ls <prefix>/**
        if "ls" in cmd:
            url = next(a for a in cmd if a.startswith("gs://"))
            prefix = url.removeprefix(f"gs://{_BUCKET}/").removesuffix("/**")
            urls = [f"gs://{_BUCKET}/{n}" for n in self._objects if n.startswith(prefix)]
            return 0, "\n".join(urls), ""
        # gcloud storage cp <src> <dst>
        if "cp" in cmd:
            src = cmd[cmd.index("cp") + 1]
            dst = cmd[cmd.index("cp") + 2]
            if src.startswith("gs://"):
                obj = src.removeprefix(f"gs://{_BUCKET}/")
                if obj not in self._objects:
                    return 1, "", "not found"
                Path(dst).write_bytes(self._objects[obj])
                return 0, "", ""
            else:
                self._objects[dst.removeprefix(f"gs://{_BUCKET}/")] = Path(src).read_bytes()
                return 0, "", ""
        return 1, "", f"unhandled: {cmd}"


def _build_checkpoint_objects(tmp_path: Path, *trials: tuple[str, str, int]) -> dict[str, bytes]:
    """Build checkpoint archive bytes for (task_name, trial_id, chunk_index)."""
    objects: dict[str, bytes] = {}
    for task_name, trial_id, chunk_index in trials:
        trial_dir = tmp_path / "src" / trial_id
        _make_trial(trial_dir, result={
            "trial_name": trial_id, "task_name": task_name,
            "verifier_result": {"rewards": {"reward": 1.0}},
        })
        archive, _ = ckpt.create_trial_archive(trial_dir, task_name=task_name, chunk_index=chunk_index)
        name = ckpt.trial_object_name(_RUN_PREFIX, chunk_index, trial_id)
        objects[name] = archive
    return objects


class TestRestore:
    def test_listing_uses_supported_flat_recursive_gcloud_output(self) -> None:
        calls: list[list[str]] = []

        def runner(
            cmd: list[str], *, timeout: float | None = None
        ) -> tuple[int, str, str]:
            calls.append(cmd)
            return 0, "", ""

        assert ckpt.gcs_list_objects(_BUCKET, "some/prefix", runner=runner) == []
        assert calls == [
            [
                "gcloud",
                "storage",
                "ls",
                f"gs://{_BUCKET}/some/prefix/**",
            ]
        ]

    def test_restore_downloads_and_extracts_each_trial(self, tmp_path: Path) -> None:
        objects = _build_checkpoint_objects(tmp_path, ("fix-git", "fix-git__a", 0), ("fix-git", "fix-git__b", 0))
        runner = _FakeRunner(objects)
        dest = tmp_path / "jobs"
        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET, run_prefix=_RUN_PREFIX, chunk_index=0, dest_dir=dest, runner=runner,
        )
        assert len(result.restored) == 2
        assert {r.trial_id for r in result.restored} == {"fix-git__a", "fix-git__b"}
        assert (
            dest
            / ckpt.CHECKPOINT_RESTORE_DIR
            / "fix-git__a"
            / "result.json"
        ).is_file()
        assert result.duplicates == 0
        assert result.corrupt == 0

    def test_restore_deduplicates_by_trial_id(self, tmp_path: Path) -> None:
        # Same trial id appearing twice (shouldn't happen, but defensively).
        objects = _build_checkpoint_objects(tmp_path, ("fix-git", "fix-git__a", 0))
        name = ckpt.trial_object_name(_RUN_PREFIX, 0, "fix-git__a")
        objects[name + ".dup"] = objects[name]
        runner = _FakeRunner(objects)
        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET, run_prefix=_RUN_PREFIX, chunk_index=0, dest_dir=tmp_path / "jobs", runner=runner,
        )
        assert len(result.restored) == 1
        assert result.duplicates == 1

    def test_restore_raises_for_corrupt_durable_archive(self, tmp_path: Path) -> None:
        objects = _build_checkpoint_objects(tmp_path, ("fix-git", "fix-git__a", 0))
        name = ckpt.trial_object_name(_RUN_PREFIX, 0, "fix-git__a")
        objects[name] = b"this is not a valid gzip archive at all"
        runner = _FakeRunner(objects)
        with pytest.raises(ckpt.CheckpointCorruptError, match="fix-git__a"):
            ckpt.restore_chunk_checkpoints(
                bucket=_BUCKET,
                run_prefix=_RUN_PREFIX,
                chunk_index=0,
                dest_dir=tmp_path / "jobs",
                runner=runner,
            )

    def test_restore_raises_when_checkpoint_listing_fails(self, tmp_path: Path) -> None:
        def failing_runner(
            cmd: list[str], *, timeout: float | None = None
        ) -> tuple[int, str, str]:
            return 1, "", "permission denied"

        with pytest.raises(ckpt.CheckpointRestoreError, match="permission denied"):
            ckpt.restore_chunk_checkpoints(
                bucket=_BUCKET,
                run_prefix=_RUN_PREFIX,
                chunk_index=0,
                dest_dir=tmp_path / "jobs",
                runner=failing_runner,
            )

    def test_restore_handles_missing_checkpoints(self, tmp_path: Path) -> None:
        runner = _FakeRunner({})
        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET, run_prefix=_RUN_PREFIX, chunk_index=0, dest_dir=tmp_path / "jobs", runner=runner,
        )
        assert len(result.restored) == 0

    def test_restore_handles_gcloud_no_objects_response(self, tmp_path: Path) -> None:
        def no_objects_runner(
            cmd: list[str], *, timeout: float | None = None
        ) -> tuple[int, str, str]:
            return 1, "", "One or more URLs matched no objects."

        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
            dest_dir=tmp_path / "jobs",
            runner=no_objects_runner,
        )
        assert result.restored == []

    def test_restore_does_not_clobber_existing_local_trial(self, tmp_path: Path) -> None:
        # GitLab artifact already placed the trial dir; GCS restore must not overwrite.
        objects = _build_checkpoint_objects(tmp_path, ("fix-git", "fix-git__a", 0))
        dest = tmp_path / "jobs" / "fix-git__a"
        _make_trial(dest, result={
            "trial_name": "fix-git__a",
            "task_name": "terminal-bench/fix-git",
            "verifier_result": {"rewards": {"reward": 0.0}},
        })
        runner = _FakeRunner(objects)
        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET, run_prefix=_RUN_PREFIX, chunk_index=0, dest_dir=tmp_path / "jobs", runner=runner,
        )
        assert len(result.restored) == 1
        assert result.restored[0].source == "gitlab"
        # The existing (reward=0.0) file is preserved.
        assert json.loads((dest / "result.json").read_text())["verifier_result"]["rewards"]["reward"] == 0.0

    @pytest.mark.parametrize(
        "invalid_result",
        [
            None,
            b"{not-json",
            json.dumps({
                "trial_name": "another-trial__a",
                "task_name": "terminal-bench/fix-git",
            }).encode(),
            json.dumps({
                "trial_name": "fix-git__a",
                "task_name": "terminal-bench/another-task",
            }).encode(),
        ],
        ids=[
            "missing-result",
            "malformed-result",
            "wrong-trial-id",
            "wrong-task-name",
        ],
    )
    def test_restore_replaces_invalid_gitlab_trial_with_checkpoint(
        self,
        tmp_path: Path,
        invalid_result: bytes | None,
    ) -> None:
        objects = _build_checkpoint_objects(
            tmp_path,
            ("fix-git", "fix-git__a", 0),
        )
        local_trial = tmp_path / "jobs" / "run-prior" / "fix-git__a"
        _make_trial(local_trial)
        if invalid_result is None:
            (local_trial / "result.json").unlink()
        else:
            (local_trial / "result.json").write_bytes(invalid_result)

        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
            dest_dir=tmp_path / "jobs",
            runner=_FakeRunner(objects),
        )

        assert len(result.restored) == 1
        assert result.restored[0].source == "gcs"
        assert result.restored[0].trial_dir == local_trial
        restored_result = json.loads((local_trial / "result.json").read_text())
        assert restored_result["trial_name"] == "fix-git__a"
        assert restored_result["task_name"] == "fix-git"

    def test_restore_replaces_structurally_incomplete_gitlab_trial(
        self,
        tmp_path: Path,
    ) -> None:
        objects = _build_checkpoint_objects(
            tmp_path,
            ("fix-git", "fix-git__a", 0),
        )
        local_trial = tmp_path / "jobs" / "run-prior" / "fix-git__a"
        _make_trial(local_trial, result={
            "trial_name": "fix-git__a",
            "task_name": "terminal-bench/fix-git",
        })
        (local_trial / "lock.json").unlink()

        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
            dest_dir=tmp_path / "jobs",
            runner=_FakeRunner(objects),
        )

        assert result.restored[0].source == "gcs"
        assert result.restored[0].trial_dir == local_trial
        assert (local_trial / "lock.json").is_file()

    def test_full_namespace_restore_replaces_invalid_gitlab_trial(
        self,
        tmp_path: Path,
    ) -> None:
        objects = _build_checkpoint_objects(
            tmp_path,
            ("fix-git", "fix-git__a", 0),
        )
        local_trial = tmp_path / "jobs" / "run-prior" / "fix-git__a"
        _make_trial(local_trial)
        (local_trial / "result.json").write_text("{not-json")

        result = ckpt.restore_all_chunk_checkpoints(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            dest_dir=tmp_path / "jobs",
            runner=_FakeRunner(objects),
        )

        assert len(result.restored) == 1
        assert result.restored[0].source == "gcs"
        assert result.restored[0].trial_dir == local_trial
        assert json.loads((local_trial / "result.json").read_text())["trial_name"] == "fix-git__a"

    def test_restore_replaces_partial_checkpoint_extraction(self, tmp_path: Path) -> None:
        """An interrupted restore must be completed from the durable archive."""
        objects = _build_checkpoint_objects(tmp_path, ("fix-git", "fix-git__a", 0))
        partial = (
            tmp_path
            / "jobs"
            / ckpt.CHECKPOINT_RESTORE_DIR
            / "fix-git__a"
        )
        partial.mkdir(parents=True)
        (partial / "result.json").write_text('{"trial_name": "fix-git__a"}')

        result = ckpt.restore_chunk_checkpoints(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=0,
            dest_dir=tmp_path / "jobs",
            runner=_FakeRunner(objects),
        )

        assert len(result.restored) == 1
        assert result.restored[0].source == "gcs"
        assert (partial / "config.json").is_file()
        assert (partial / "lock.json").is_file()
        assert (partial / ckpt.CHECKPOINT_META_NAME).is_file()

    def test_restore_blocks_zip_slip(self, tmp_path: Path) -> None:
        # Build an archive with a traversal member.
        trial = tmp_path / "src" / "evil__1"
        _make_trial(trial)
        archive, _ = ckpt.create_trial_archive(trial, task_name="evil", chunk_index=0)
        # Inject an evil member into the archive.
        new_buf = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tf_in, \
             tarfile.open(fileobj=new_buf, mode="w:gz") as tf_out:
            for m in tf_in.getmembers():
                tf_out.addfile(m, tf_in.extractfile(m))
            evil = b"pwned"
            info = tarfile.TarInfo(name="../../etc/evil.conf")
            info.size = len(evil)
            info.mtime = 0
            tf_out.addfile(info, io.BytesIO(evil))
        objects = {ckpt.trial_object_name(_RUN_PREFIX, 0, "evil__1"): new_buf.getvalue()}
        runner = _FakeRunner(objects)
        dest = tmp_path / "jobs"
        with pytest.raises(ckpt.CheckpointCorruptError):
            ckpt.restore_chunk_checkpoints(
                bucket=_BUCKET,
                run_prefix=_RUN_PREFIX,
                chunk_index=0,
                dest_dir=dest,
                runner=runner,
            )
        assert not (tmp_path / "etc" / "evil.conf").exists()

    def test_restore_chunk_statuses_selects_latest_attempt(
        self, tmp_path: Path
    ) -> None:
        objects = {
            ckpt.chunk_status_object_name(_RUN_PREFIX, 0, "100"): json.dumps(
                {
                    "chunk_index": 0,
                    "chunk_attempt": 1,
                    "exit_code": 1,
                    "needs_retry": ["task-a"],
                    "exhausted": False,
                }
            ).encode(),
            ckpt.chunk_status_object_name(_RUN_PREFIX, 0, "300"): json.dumps(
                {
                    "chunk_index": 0,
                    "chunk_attempt": 3,
                    "exit_code": 0,
                    "needs_retry": ["task-a"],
                    "exhausted": True,
                }
            ).encode(),
        }

        restored = ckpt.restore_chunk_statuses(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            dest_dir=tmp_path / "jobs",
            chunk_count=1,
            runner=_FakeRunner(objects),
        )

        assert restored == 1
        status = json.loads(
            (tmp_path / "jobs/chunk-meta/chunk-0.json").read_text()
        )
        assert status["chunk_attempt"] == 3
        assert status["exhausted"] is True

    def test_restore_chunk_statuses_rejects_wrong_chunk(
        self, tmp_path: Path
    ) -> None:
        objects = {
            ckpt.chunk_status_object_name(_RUN_PREFIX, 0, "100"): json.dumps(
                {
                    "chunk_index": 1,
                    "chunk_attempt": 1,
                    "exit_code": 0,
                    "needs_retry": [],
                    "exhausted": False,
                }
            ).encode(),
        }

        with pytest.raises(ckpt.CheckpointCorruptError, match="chunk_index"):
            ckpt.restore_chunk_statuses(
                bucket=_BUCKET,
                run_prefix=_RUN_PREFIX,
                dest_dir=tmp_path / "jobs",
                chunk_count=1,
                runner=_FakeRunner(objects),
            )


# ---------------------------------------------------------------------------
# Phase 3: idempotent upload (skip when bytes match)
# ---------------------------------------------------------------------------

class TestIdempotentUpload:
    def test_upload_skipped_when_md5_matches(self, tmp_path: Path) -> None:
        runner = _FakeRunner({})
        # Pre-seed the object so the checksum check finds a match.
        data = b"archive-bytes"
        runner._objects[ckpt.trial_object_name(_RUN_PREFIX, 0, "t__1")] = data  # type: ignore[attr-defined]
        ckpt.gcs_upload_object(_BUCKET, ckpt.trial_object_name(_RUN_PREFIX, 0, "t__1"), data, runner=runner)
        # No new upload happened (objects unchanged beyond the seed).
        assert len(runner._objects) == 1  # type: ignore[attr-defined]

    def test_upload_retries_then_succeeds(self, tmp_path: Path) -> None:
        state: dict[str, bytes] = {}
        attempts = {"n": 0}

        def flaky_runner(cmd: list[str], *, timeout: float | None = None) -> tuple[int, str, str]:
            attempts["n"] += 1
            # gcloud storage objects describe <url> --format=md5_hash
            if "objects" in cmd and "describe" in cmd:
                url = next(a for a in cmd if a.startswith("gs://"))
                obj = url.removeprefix(f"gs://{_BUCKET}/")
                if obj in state:
                    import hashlib
                    digest = hashlib.md5(state[obj]).digest()
                    return 0, base64.b64encode(digest).decode("ascii"), ""
                return 1, "", "not found"
            # gcloud storage cp <src> <dst>
            if "cp" in cmd:
                src = cmd[cmd.index("cp") + 1]
                dst = cmd[cmd.index("cp") + 2]
                if src.startswith("gs://"):
                    obj = src.removeprefix(f"gs://{_BUCKET}/")
                    if obj not in state:
                        return 1, "", "not found"
                    Path(dst).write_bytes(state[obj])
                    return 0, "", ""
                # upload: fail the first two attempts, succeed the third.
                if attempts["n"] < 4:
                    return 1, "", "transient"
                state[dst.removeprefix(f"gs://{_BUCKET}/")] = Path(src).read_bytes()
                return 0, "", ""
            return 1, "", f"unhandled: {cmd}"

        ckpt.gcs_upload_object(_BUCKET, "obj", b"data", retries=5, base_delay=0.0, runner=flaky_runner)
        assert attempts["n"] >= 3
        assert state.get("obj") == b"data"

    def test_upload_uses_create_only_precondition(self) -> None:
        calls: list[list[str]] = []
        state: dict[str, bytes] = {}

        def runner(
            cmd: list[str], *, timeout: float | None = None
        ) -> tuple[int, str, str]:
            calls.append(cmd)
            if "describe" in cmd:
                if not state:
                    return 1, "", "not found"
                digest = hashlib.md5(state["obj"]).digest()
                return 0, base64.b64encode(digest).decode("ascii"), ""
            src = cmd[cmd.index("cp") + 1]
            state["obj"] = Path(src).read_bytes()
            return 0, "", ""

        ckpt.gcs_upload_object(
            _BUCKET, "obj", b"data", retries=1, runner=runner
        )

        upload = next(cmd for cmd in calls if "cp" in cmd)
        assert "--if-generation-match=0" in upload

    def test_upload_raises_after_exhausting_retries(self, tmp_path: Path) -> None:
        def always_fail(cmd: list[str], *, timeout: float | None = None) -> tuple[int, str, str]:
            if "cp" in cmd and cmd[cmd.index("cp") + 1].startswith("/tmp"):
                return 1, "", "permanent"
            return 1, "", "fail"

        with pytest.raises(ckpt.CheckpointUploadError, match="failed to upload"):
            ckpt.gcs_upload_object(_BUCKET, "obj", b"data", retries=2, base_delay=0.0, runner=always_fail)


class TestDurableChunkAttempt:
    def test_register_is_idempotent_per_job_and_counts_distinct_jobs(
        self,
    ) -> None:
        runner = _FakeRunner({})

        first = ckpt.register_chunk_attempt(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=2,
            job_id="100",
            runner=runner,
        )
        repeated = ckpt.register_chunk_attempt(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=2,
            job_id="100",
            runner=runner,
        )
        second = ckpt.register_chunk_attempt(
            bucket=_BUCKET,
            run_prefix=_RUN_PREFIX,
            chunk_index=2,
            job_id="101",
            runner=runner,
        )

        assert (first, repeated, second) == (1, 1, 2)
        marker_names = [
            name
            for name in runner._objects
            if "/attempts/job=" in name
        ]
        assert len(marker_names) == 2
