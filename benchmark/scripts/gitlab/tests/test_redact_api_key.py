"""Tests for the reusable redact_tree helper (Phase 2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from redact_api_key import REDACTED_MARKER, redact_tree


def _write(root: Path, rel: str, data: bytes) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)


def test_redact_tree_replaces_secret_in_all_files(tmp_path: Path) -> None:
    secret = b"sk-secret-123"
    _write(tmp_path, "a.txt", b"hello " + secret + b" world")
    _write(tmp_path, "nested/b/c.json", secret)
    _write(tmp_path, "clean.log", b"no secret here")

    redact_tree(tmp_path, [secret])

    assert (tmp_path / "a.txt").read_bytes() == b"hello " + REDACTED_MARKER + b" world"
    assert (tmp_path / "nested" / "b" / "c.json").read_bytes() == REDACTED_MARKER
    assert (tmp_path / "clean.log").read_bytes() == b"no secret here"


def test_redact_tree_noop_when_no_secrets(tmp_path: Path) -> None:
    _write(tmp_path, "a.txt", b"sk-secret")
    redact_tree(tmp_path, [])
    assert (tmp_path / "a.txt").read_bytes() == b"sk-secret"


def test_redact_tree_handles_multiple_secrets(tmp_path: Path) -> None:
    a, b = b"sk-a", b"sk-b"
    _write(tmp_path, "a.txt", a + b" " + b)
    redact_tree(tmp_path, [a, b])
    assert (tmp_path / "a.txt").read_bytes() == REDACTED_MARKER + b" " + REDACTED_MARKER


def test_redact_tree_skips_symlinks(tmp_path: Path) -> None:
    secret = b"sk-secret"
    # The target is a regular file inside the tree, so it WILL be redacted.
    # The point of this test: a symlink that points OUTSIDE the tree is not
    # followed (and never dereferenced into a write), so redaction never escapes
    # the tree. We verify by checking a symlink whose target lives outside root
    # is left as a symlink and the out-of-tree target is untouched.
    outside = tmp_path / "outside.txt"
    outside.write_bytes(secret)
    link = tmp_path / "tree" / "link.txt"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(outside)
    redact_tree(tmp_path / "tree", [secret])
    assert link.is_symlink()
    assert outside.read_bytes() == secret


def test_redact_tree_multiple_occurrences_in_one_file(tmp_path: Path) -> None:
    secret = b"sk-secret"
    _write(tmp_path, "a.txt", secret + b" " + secret + b" " + secret)
    redact_tree(tmp_path, [secret])
    assert (tmp_path / "a.txt").read_bytes() == (REDACTED_MARKER + b" ") * 2 + REDACTED_MARKER


def test_redact_tree_fails_closed_when_secret_file_cannot_be_rewritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    secret = b"sk-secret"
    target = tmp_path / "agent.log"
    target.write_bytes(b"key=" + secret)
    original_write_bytes = Path.write_bytes

    def fail_target_write(path: Path, data: bytes) -> int:
        if path == target:
            raise PermissionError("read-only checkpoint staging file")
        return original_write_bytes(path, data)

    monkeypatch.setattr(Path, "write_bytes", fail_target_write)

    with pytest.raises(PermissionError, match="read-only"):
        redact_tree(tmp_path, [secret])
