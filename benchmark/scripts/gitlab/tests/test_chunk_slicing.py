"""Unit tests for chunk_slicing — pure function that maps (chunk_index, chunk_count, tasks) → slice."""

from __future__ import annotations

from chunk_slicing import slice_tasks


def test_first_chunk_of_eight() -> None:
    tasks = [f"task-{i}" for i in range(84)]
    # 84 / 8 = 10.5 → first 4 chunks get 11 tasks, last 4 get 10
    assert slice_tasks(tasks, chunk_index=0, chunk_count=8) == tasks[0:11]


def test_last_chunk_of_eight() -> None:
    tasks = [f"task-{i}" for i in range(84)]
    # Chunks 0-3: tasks[0:11], [11:22], [22:33], [33:44]
    # Chunks 4-7: tasks[44:54], [54:64], [64:74], [74:84]
    assert slice_tasks(tasks, chunk_index=7, chunk_count=8) == tasks[74:84]


def test_middle_chunk_distribution() -> None:
    tasks = [f"task-{i}" for i in range(84)]
    assert slice_tasks(tasks, chunk_index=3, chunk_count=8) == tasks[33:44]  # last of the 11-task chunks
    assert slice_tasks(tasks, chunk_index=4, chunk_count=8) == tasks[44:54]  # first of the 10-task chunks


def test_empty_when_selected_excludes_chunk() -> None:
    tasks = [f"task-{i}" for i in range(84)]
    selected = tasks[0:3]  # 3 tasks across 8 chunks → chunks 0-2 get 1 task each, chunks 3-7 get 0
    assert slice_tasks(selected, chunk_index=3, chunk_count=8) == []


def test_ceiling_distribution_when_remainder() -> None:
    tasks = [f"task-{i}" for i in range(10)]
    # 10 / 8 = 1.25, ceil → first 2 chunks get 2 tasks, rest get 1
    chunk_0 = slice_tasks(tasks, chunk_index=0, chunk_count=8)
    chunk_7 = slice_tasks(tasks, chunk_index=7, chunk_count=8)
    assert len(chunk_0) == 2
    assert len(chunk_7) == 1


def test_zero_tasks_returns_empty() -> None:
    assert slice_tasks([], chunk_index=0, chunk_count=8) == []
    assert slice_tasks([], chunk_index=4, chunk_count=8) == []


def test_single_task_only_first_chunk() -> None:
    tasks = ["only-task"]
    assert slice_tasks(tasks, chunk_index=0, chunk_count=8) == ["only-task"]
    assert slice_tasks(tasks, chunk_index=5, chunk_count=8) == []
