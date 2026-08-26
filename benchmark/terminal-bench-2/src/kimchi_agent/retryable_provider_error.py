import shlex
from collections.abc import Callable
from typing import Any

from harbor.environments.base import BaseEnvironment

# Mirrors retryable status handling in src/llm-gateway-error.ts.
RETRYABLE_API_STATUSES = frozenset({408, 409, 425, 429, 500, 502, 503, 504, 524, 529})
RETRYABLE_API_ERROR_MESSAGE_LIMIT = 2_000


class RetryableApiError(RuntimeError):
    """Raised when the agent failed because an upstream provider returned a transient error."""

    def __init__(self, status: int | None, detail: str) -> None:
        self.status = status
        detail = detail.strip()
        suffix = f": {detail}" if detail else ""
        code = f" {status}" if status is not None else ""
        super().__init__(f"Retryable provider error{code}{suffix}")


def retryable_api_error_detail(detail: str) -> str:
    if len(detail) > RETRYABLE_API_ERROR_MESSAGE_LIMIT:
        return f"{detail[:RETRYABLE_API_ERROR_MESSAGE_LIMIT]}..."
    return detail


async def retryable_api_error_from_remote_file(
    environment: BaseEnvironment,
    path: str,
    parser: Callable[[str], RetryableApiError | None],
    logger: Any,
    label: str,
) -> RetryableApiError | None:
    try:
        result = await environment.exec(f"cat {shlex.quote(path)}", timeout_sec=10)
    except Exception:
        logger.debug("Failed to read %s for API error classification", label, exc_info=True)
        return None
    if result.return_code != 0 or not result.stdout:
        return None
    return parser(result.stdout)
