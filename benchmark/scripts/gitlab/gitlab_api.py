"""Small GitLab API helpers shared by benchmark recovery scripts."""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from typing import Any, Protocol


class _Response(Protocol):
    headers: Any

    def read(self) -> bytes: ...

    def __enter__(self) -> _Response: ...

    def __exit__(self, *args: object) -> bool | None: ...


UrlOpen = Callable[..., _Response]


def list_pipeline_jobs(
    *,
    api_url: str,
    project_id: str,
    pipeline_id: str,
    headers: dict[str, str],
    timeout: float = 30,
    urlopen: UrlOpen | None = None,
) -> list[dict[str, Any]]:
    """List every job in a pipeline, including retried attempts.

    GitLab paginates this endpoint and defaults to a small first page. Follow
    ``X-Next-Page`` so an older retry attempt cannot disappear merely because
    unrelated pipeline jobs received newer IDs.
    """
    jobs: list[dict[str, Any]] = []
    page = 1
    seen_pages: set[int] = set()
    open_url = urlopen or urllib.request.urlopen

    while page not in seen_pages:
        seen_pages.add(page)
        list_url = (
            f"{api_url}/projects/{project_id}/pipelines/{pipeline_id}/jobs"
            f"?include_retried=true&per_page=100&page={page}"
        )
        request = urllib.request.Request(list_url, headers=headers)
        with open_url(request, timeout=timeout) as response:
            value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, list):
                raise ValueError(
                    f"GitLab pipeline jobs page {page} did not return a list"
                )
            jobs.extend(job for job in value if isinstance(job, dict))
            response_headers = getattr(response, "headers", {})
            next_page_raw = response_headers.get("X-Next-Page", "")

        next_page_text = str(next_page_raw).strip()
        if not next_page_text:
            break
        try:
            next_page = int(next_page_text)
        except ValueError as exc:
            raise ValueError(
                f"GitLab returned invalid X-Next-Page={next_page_text!r}"
            ) from exc
        if next_page < 1:
            raise ValueError(
                f"GitLab returned invalid X-Next-Page={next_page_text!r}"
            )
        page = next_page

    return jobs


__all__ = ["list_pipeline_jobs"]
