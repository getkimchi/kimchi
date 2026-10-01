import pytest

from kimchi_agent.config import DEFAULT_GITHUB_REPO, KimchiAgentConfig


def test_release_downloads_default_to_github_source_of_truth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GITHUB_REPO", raising=False)
    monkeypatch.delenv("KIMCHI_CODE_BINARY", raising=False)

    assert DEFAULT_GITHUB_REPO == "getkimchi/kimchi"
    assert KimchiAgentConfig().github_repo == "getkimchi/kimchi"
