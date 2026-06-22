"""Pure function for slicing a task list across chunk jobs.

Given a list of selected tasks and the chunk index/count, returns the slice
of tasks owned by this chunk. Uses ceiling division so the first few chunks
get one extra task when the total doesn't divide evenly.
"""

from __future__ import annotations


def slice_tasks(tasks: list[str], *, chunk_index: int, chunk_count: int) -> list[str]:
    """Return the subset of `tasks` owned by chunk `chunk_index` (0-based).

    Distribution uses ceiling division so all tasks are covered:
      - 84 tasks, 8 chunks → first 4 chunks get 11 tasks, last 4 get 10
      - 10 tasks, 8 chunks → first 2 chunks get 2 tasks, rest get 1
    """
    if chunk_count <= 0:
        raise ValueError(f"chunk_count must be > 0, got {chunk_count}")
    if chunk_index < 0 or chunk_index >= chunk_count:
        raise ValueError(f"chunk_index {chunk_index} out of range [0, {chunk_count})")
    if not tasks:
        return []

    n = len(tasks)
    base = n // chunk_count
    remainder = n % chunk_count
    # First `remainder` chunks get one extra task
    if chunk_index < remainder:
        start = chunk_index * (base + 1)
        end = start + base + 1
    else:
        start = remainder * (base + 1) + (chunk_index - remainder) * base
        end = start + base
    return tasks[start:end]


__all__ = ["slice_tasks"]
