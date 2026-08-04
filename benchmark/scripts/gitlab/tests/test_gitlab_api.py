"""Tests for paginated GitLab pipeline-job discovery."""

from __future__ import annotations

import json

import pytest

from gitlab_api import list_pipeline_jobs


class _Response:
    def __init__(self, value: object, *, next_page: str = "") -> None:
        self._data = json.dumps(value).encode("utf-8")
        self.headers = {"X-Next-Page": next_page}

    def read(self) -> bytes:
        return self._data

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> bool:
        return False


def test_list_pipeline_jobs_follows_x_next_page() -> None:
    seen_urls: list[str] = []

    def fake_urlopen(request, timeout):
        del timeout
        seen_urls.append(request.full_url)
        if "&page=1" in request.full_url:
            return _Response([{"id": 200}], next_page="2")
        if "&page=2" in request.full_url:
            return _Response([{"id": 150}])
        raise AssertionError(f"unexpected URL: {request.full_url}")

    jobs = list_pipeline_jobs(
        api_url="https://gitlab.example/api/v4",
        project_id="7",
        pipeline_id="100",
        headers={"JOB-TOKEN": "token"},
        urlopen=fake_urlopen,
    )

    assert [job["id"] for job in jobs] == [200, 150]
    assert len(seen_urls) == 2
    assert all("include_retried=true" in url for url in seen_urls)
    assert all("per_page=100" in url for url in seen_urls)


def test_list_pipeline_jobs_rejects_invalid_next_page() -> None:
    with pytest.raises(ValueError, match="X-Next-Page"):
        list_pipeline_jobs(
            api_url="https://gitlab.example/api/v4",
            project_id="7",
            pipeline_id="100",
            headers={"JOB-TOKEN": "token"},
            urlopen=lambda request, timeout: _Response(
                [{"id": 200}], next_page="not-a-page"
            ),
        )


def test_list_pipeline_jobs_rejects_non_list_response() -> None:
    with pytest.raises(ValueError, match="did not return a list"):
        list_pipeline_jobs(
            api_url="https://gitlab.example/api/v4",
            project_id="7",
            pipeline_id="100",
            headers={"JOB-TOKEN": "token"},
            urlopen=lambda request, timeout: _Response({"id": 200}),
        )
