#!/usr/bin/env python3
"""Run sequential Terminal-Bench attempts backed by task-scoped OpenViking memory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_DATASET = "terminal-bench/terminal-bench-2-1"
DEFAULT_MODEL = "kimchi-dev/kimi-k2.7"
DEFAULT_ATTEMPTS = 5
DEFAULT_VERIFIER_MAX_CHARS = 4_000
DEFAULT_MEMORY_WAIT_SECONDS = 1_800
DEFAULT_SEARCH_TIMEOUT_SECONDS = 120
DEFAULT_SEARCH_ATTEMPTS = 3
DEFAULT_OLLAMA_WARMUP_TIMEOUT_SECONDS = 180
TRAINING_CASE_SPEC_HEADER = "# OpenViking Batch Training CaseSpec v1"
TRAINING_CASE_SPEC_PROTOCOL = "openviking.batch_train.case_spec.v1"
TRAINING_MEMORY_POLICY = {
    "memory_types": ["cases", "trajectories", "experiences"],
    "working_memory": {"enabled": False},
}


def safe_id(value: str, max_length: int = 120) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return (normalized or "terminal-bench")[:max_length]


def utc_timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%d-%H%M%S")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def warm_ollama() -> None:
    base_url = os.environ.get("OPENVIKING_OLLAMA_URL", "").rstrip("/")
    if not base_url:
        return
    model = os.environ.get("OPENVIKING_OLLAMA_EMBEDDING_MODEL", "qwen3-embedding:4b")
    request = urllib.request.Request(
        f"{base_url}/v1/embeddings",
        data=json.dumps(
            {
                "model": model,
                "input": "Warm OpenViking retrieval for a Terminal-Bench coding task.",
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=DEFAULT_OLLAMA_WARMUP_TIMEOUT_SECONDS,
        ) as response:
            response.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"Ollama embedding warmup failed for {model}: {exc}") from exc


@dataclass(frozen=True)
class OpenVikingIdentity:
    account: str | None
    user: str | None
    peer: str


class OpenVikingClient:
    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        identity: OpenVikingIdentity,
        timeout_seconds: float = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.identity = identity
        self.timeout_seconds = timeout_seconds

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if self.identity.account:
            headers["X-OpenViking-Account"] = self.identity.account
        if self.identity.user:
            headers["X-OpenViking-User"] = self.identity.user
        headers["X-OpenViking-Actor-Peer"] = self.identity.peer
        return headers

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=self._headers(),
            method=method,
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=timeout_seconds or self.timeout_seconds,
            ) as response:
                payload = json.loads(response.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"OpenViking request failed: {method} {path}: {exc}") from exc
        if not isinstance(payload, dict):
            raise RuntimeError(f"OpenViking returned a non-object response for {method} {path}")
        if payload.get("status") == "error":
            raise RuntimeError(f"OpenViking returned an error for {method} {path}: {payload.get('error')}")
        return payload

    def health(self) -> dict[str, Any]:
        return self.request("/health")

    def search(self, query: str, limit: int = 20) -> dict[str, Any]:
        last_error: RuntimeError | None = None
        for attempt in range(1, DEFAULT_SEARCH_ATTEMPTS + 1):
            try:
                return self.request(
                    "/api/v1/search/find",
                    method="POST",
                    body={"query": query, "limit": limit, "score_threshold": 0},
                    timeout_seconds=DEFAULT_SEARCH_TIMEOUT_SECONDS,
                )
            except RuntimeError as exc:
                last_error = exc
                if attempt < DEFAULT_SEARCH_ATTEMPTS:
                    time.sleep(attempt * 2)
        assert last_error is not None
        raise last_error

    def get_archive(self, archive_uri: str) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {"uri": f"{archive_uri.rstrip('/')}/messages.jsonl", "raw": "true"}
        )
        response = self.request(f"/api/v1/content/read?{query}")
        raw_messages = response.get("result")
        if not isinstance(raw_messages, str):
            raise RuntimeError(f"OpenViking archive did not contain JSONL messages: {response}")
        messages: list[dict[str, Any]] = []
        for line_number, line in enumerate(raw_messages.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"OpenViking archive contains invalid JSON on line {line_number}"
                ) from exc
            if not isinstance(message, dict):
                raise RuntimeError(
                    f"OpenViking archive message on line {line_number} is not an object"
                )
            messages.append(message)
        if not messages:
            raise RuntimeError(f"OpenViking archive contains no messages: {archive_uri}")
        return {
            "status": "ok",
            "result": {
                "archive_id": archive_uri.rstrip("/").rsplit("/", 1)[-1],
                "archive_uri": archive_uri,
                "messages": messages,
            },
        }

    def add_verified_lesson(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self.request(
            "/api/v1/sessions",
            method="POST",
            body={"session_id": session_id, "memory_policy": TRAINING_MEMORY_POLICY},
        )
        self.request(
            f"/api/v1/sessions/{urllib.parse.quote(session_id, safe='')}/messages/batch",
            method="POST",
            body={"messages": messages},
        )
        return self.request(
            f"/api/v1/sessions/{urllib.parse.quote(session_id, safe='')}/commit",
            method="POST",
            body={"keep_recent_count": 0},
        )

    def wait_for_commit(self, session_id: str, timeout_seconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last: dict[str, Any] = {}
        session_path = f"/api/v1/sessions/{urllib.parse.quote(session_id, safe='')}"
        while time.monotonic() < deadline:
            last = self.request(session_path)
            result = last.get("result", last)
            if isinstance(result, dict) and int(result.get("commit_count", 0)) >= 1:
                return last
            time.sleep(2)
        raise TimeoutError(
            f"OpenViking did not finish feedback commit for {session_id} within {timeout_seconds}s; "
            f"last response: {last}"
        )

    def wait_for_task(self, task_id: str, timeout_seconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last: dict[str, Any] = {}
        path = f"/api/v1/tasks/{urllib.parse.quote(task_id, safe='')}"
        while time.monotonic() < deadline:
            last = self.request(path)
            result = last.get("result", last)
            status = result.get("status") if isinstance(result, dict) else None
            if status == "completed":
                return last
            if status in {"failed", "cancelled"}:
                raise RuntimeError(f"OpenViking task {task_id} ended with status {status}: {last}")
            time.sleep(2)
        raise TimeoutError(
            f"OpenViking task {task_id} did not complete within {timeout_seconds}s; last response: {last}"
        )

    def wait_for_session_extraction(self, session_id: str, timeout_seconds: int) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        query = urllib.parse.urlencode(
            {
                "task_type": "session_commit",
                "resource_id": session_id,
                "limit": 1,
            }
        )
        list_path = f"/api/v1/tasks?{query}"
        while time.monotonic() < deadline:
            response = self.request(list_path)
            tasks = response.get("result", [])
            if isinstance(tasks, list) and tasks:
                task = tasks[0]
                task_id = task.get("task_id") if isinstance(task, dict) else None
                if isinstance(task_id, str) and task_id:
                    remaining = max(1, int(deadline - time.monotonic()))
                    return self.wait_for_task(task_id, remaining)
            time.sleep(2)
        raise TimeoutError(
            f"OpenViking did not expose an extraction task for {session_id} within {timeout_seconds}s"
        )


def search_items(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result = snapshot.get("result", snapshot)
    if not isinstance(result, dict):
        return {}
    items: dict[str, dict[str, Any]] = {}
    for bucket in ("memories", "resources", "skills"):
        values = result.get(bucket, [])
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict):
                continue
            uri = value.get("uri")
            if isinstance(uri, str) and uri:
                items[uri] = {"bucket": bucket, **value}
    return items


def require_agent_evolution(extraction_status: dict[str, Any]) -> None:
    task = extraction_status.get("result", extraction_status)
    extraction = task.get("result", task) if isinstance(task, dict) else {}
    if isinstance(extraction, dict) and extraction.get("agent_evolution_enabled") is False:
        raise RuntimeError(
            "OpenViking Agent Evolution is disabled for the benchmark account; "
            "enable server.agent_evolution.enabled (or the account override) before running "
            "a learning chain"
        )


def extraction_archive_uri(extraction_status: dict[str, Any]) -> str:
    task = extraction_status.get("result", extraction_status)
    extraction = task.get("result", task) if isinstance(task, dict) else {}
    archive_uri = extraction.get("archive_uri") if isinstance(extraction, dict) else None
    if not isinstance(archive_uri, str) or not archive_uri:
        raise RuntimeError(
            f"OpenViking extraction did not report an archive URI: {extraction_status}"
        )
    return archive_uri


def render_memory_diff(before: dict[str, Any], after: dict[str, Any]) -> str:
    before_items = search_items(before)
    after_items = search_items(after)
    added = sorted(set(after_items) - set(before_items))
    removed = sorted(set(before_items) - set(after_items))
    retained = sorted(set(before_items) & set(after_items))
    lines = ["# OpenViking learning diff", ""]
    lines.extend(_render_diff_section("New relevant memories", added, after_items))
    lines.extend(_render_diff_section("No longer retrieved", removed, before_items))
    lines.extend(_render_diff_section("Still retrieved", retained, after_items))
    return "\n".join(lines).rstrip() + "\n"


def _render_diff_section(
    title: str,
    uris: list[str],
    items: dict[str, dict[str, Any]],
) -> list[str]:
    lines = [f"## {title}", ""]
    if not uris:
        return [*lines, "None.", ""]
    for uri in uris:
        item = items[uri]
        abstract = str(item.get("abstract", "")).strip().replace("\n", " ")
        score = item.get("score")
        score_text = f" (score {score:.3f})" if isinstance(score, int | float) else ""
        lines.append(f"- `{uri}`{score_text}: {abstract or 'No abstract'}")
    lines.append("")
    return lines


def extract_reward(result: dict[str, Any]) -> float | None:
    verifier_result = result.get("verifier_result")
    if not isinstance(verifier_result, dict):
        return None
    rewards = verifier_result.get("rewards")
    if not isinstance(rewards, dict):
        return None
    reward = rewards.get("reward")
    if isinstance(reward, int | float):
        return float(reward)
    for value in rewards.values():
        if isinstance(value, int | float):
            return float(value)
    return None


def find_trial_dir(job_dir: Path) -> Path:
    candidates = sorted(path.parent for path in job_dir.glob("*/result.json"))
    if len(candidates) != 1:
        raise RuntimeError(f"Expected exactly one trial under {job_dir}, found {len(candidates)}")
    return candidates[0]


def verifier_output(trial_dir: Path, max_chars: int) -> tuple[str, bool]:
    path = trial_dir / "verifier" / "test-stdout.txt"
    if not path.is_file():
        return "Verifier produced no test-stdout.txt artifact.", False
    output = path.read_text(errors="replace")
    if len(output) <= max_chars:
        return output, False
    return output[-max_chars:], True


def captured_session_id(trial_dir: Path) -> str:
    session_path = trial_dir / "agent" / "sessions" / "main.jsonl"
    if not session_path.is_file():
        raise RuntimeError(f"Kimchi session artifact is missing: {session_path}")
    for line in session_path.read_text(errors="replace").splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and entry.get("type") == "session":
            session_id = entry.get("id")
            if isinstance(session_id, str) and session_id:
                return f"pi-{session_id}"
    raise RuntimeError(f"Kimchi session header is missing an id: {session_path}")


def feedback_content(
    *,
    task: str,
    attempt: int,
    reward: float | None,
    result: dict[str, Any],
    output: str,
    output_truncated: bool,
) -> str:
    exception = result.get("exception_info")
    return "\n".join(
        [
            "[Terminal-Bench verified attempt]",
            f"Task: {task}",
            f"Attempt: {attempt}",
            f"Verifier reward: {reward if reward is not None else 'unavailable'}",
            f"Verifier output truncated to tail: {'yes' if output_truncated else 'no'}",
            f"Harbor exception: {json.dumps(exception, sort_keys=True) if exception else 'none'}",
            "Verifier output:",
            output,
            "Use this verified outcome to retain successful strategies and avoid repeated failures on this task.",
        ]
    )


def verified_training_messages(
    *,
    task: str,
    attempt: int,
    reward: float | None,
    feedback: str,
    archive: dict[str, Any],
    peer_id: str,
) -> list[dict[str, Any]]:
    archive_result = archive.get("result", archive)
    raw_messages = archive_result.get("messages", []) if isinstance(archive_result, dict) else []
    if not isinstance(raw_messages, list) or not raw_messages:
        raise RuntimeError("OpenViking capture archive contains no messages")

    allowed_keys = {
        "role",
        "parts",
        "peer_id",
        "created_at",
        "turn_id",
        "message_kind",
        "source_message_ids",
    }
    rollout_messages = [
        {key: value for key, value in message.items() if key in allowed_keys}
        for message in raw_messages
        if isinstance(message, dict)
    ]
    if not rollout_messages:
        raise RuntimeError("OpenViking capture archive contains no valid rollout messages")

    user_query = _first_user_text(rollout_messages)
    case_name = safe_id(task.replace("/", "-"))
    score = reward if reward is not None else 0.0
    passed = reward is not None and reward >= 1.0
    case_payload = {
        "protocol": TRAINING_CASE_SPEC_PROTOCOL,
        "case": {
            "name": case_name,
            "task_signature": f"terminal-bench-2.1:{task}",
            "input": {
                "domain": "terminal-bench",
                "split": "terminal-bench-2.1",
                "task_id": task,
                "task_no": attempt,
                "user_query": user_query,
            },
            "metadata": {
                "attempt": attempt,
                "verifier_reward": reward,
                "evidence": f"Terminal-Bench verifier reward: {reward}",
            },
            "rubric": {
                "name": f"{case_name}-verifier",
                "description": "Terminal-Bench verifier outcome for the completed coding-agent rollout.",
                "criteria": [
                    {
                        "name": "terminal_bench_verifier",
                        "description": "The task's Terminal-Bench verifier passes.",
                        "required": True,
                        "weight": 1.0,
                    }
                ],
            },
        },
    }
    case_message = {
        "role": "system",
        "parts": [
            {
                "type": "text",
                "text": (
                    f"{TRAINING_CASE_SPEC_HEADER}\n\n"
                    "The following structured case and rubric describe the task that produced "
                    "this rollout. It is control-plane metadata for the batch training pipeline."
                    f"\n\n```json\n{json.dumps(case_payload, indent=2, sort_keys=True)}\n```"
                ),
            }
        ],
        "peer_id": peer_id,
    }
    evaluation_payload = {
        "evaluation": {
            "passed": passed,
            "score": score,
            "feedback": feedback,
            "criterion_results": [
                {
                    "criterion_name": "terminal_bench_verifier",
                    "passed": passed,
                    "score": score,
                    "feedback": f"Terminal-Bench verifier reward: {reward}",
                    "evidence": "Full verifier output is included in evaluation.feedback.",
                    "metadata": {"reward": reward, "attempt": attempt},
                }
            ],
        }
    }
    evaluation_message = {
        "role": "user",
        "parts": [
            {
                "type": "text",
                "text": (
                    "# OpenViking OutcomeEvaluation\n\n"
                    "The following structured evaluation describes the outcome of the preceding "
                    "rollout. Use it as the training signal when extracting training memories."
                    f"\n\n```json\n{json.dumps(evaluation_payload, indent=2, sort_keys=True)}\n```"
                ),
            }
        ],
        "peer_id": peer_id,
    }
    return [case_message, *rollout_messages, evaluation_message]


def _first_user_text(messages: list[dict[str, Any]]) -> str:
    for message in messages:
        if message.get("role") != "user":
            continue
        parts = message.get("parts", [])
        if not isinstance(parts, list):
            continue
        texts = [
            str(part.get("text"))
            for part in parts
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text")
        ]
        if texts:
            return "\n".join(texts)
    return "Terminal-Bench task request"


def openviking_agent_env(identity: OpenVikingIdentity) -> dict[str, str]:
    required = {
        "KIMCHI_API_KEY": os.environ.get("KIMCHI_API_KEY", ""),
        "OPENVIKING_EXTENSION_DIR": os.environ.get("OPENVIKING_EXTENSION_DIR", ""),
        "OPENVIKING_URL": os.environ.get("OPENVIKING_URL", os.environ.get("OPENVIKING_BASE_URL", "")),
        "OPENVIKING_PEER_ID": identity.peer,
        "OPENVIKING_WORKSPACE_PEER": "0",
        "OPENVIKING_RECALL_PEER_SCOPE": "actor",
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        raise ValueError(f"Missing required environment variables: {', '.join(missing)}")
    optional_keys = (
        "OPENVIKING_API_KEY",
        "OPENVIKING_BEARER_TOKEN",
        "OPENVIKING_ACCOUNT",
        "OPENVIKING_USER",
    )
    for key in optional_keys:
        value = os.environ.get(key)
        if value:
            required[key] = value
    return required


def harbor_command(
    *,
    task: str,
    model: str,
    dataset: str,
    job_name: str,
    jobs_dir: Path,
    identity: OpenVikingIdentity,
    extra_args: list[str],
) -> list[str]:
    command = [
        "harbor",
        "run",
        "--agent",
        "kimchi_agent:KimchiOpenViking",
        "--env",
        "docker",
        "--model",
        model,
        "--dataset",
        dataset,
        "--include-task-name",
        task,
        "--n-concurrent",
        "1",
        "--n-attempts",
        "1",
        "--jobs-dir",
        str(jobs_dir),
        "--job-name",
        job_name,
    ]
    agent_env = openviking_agent_env(identity)
    for key, value in agent_env.items():
        command.extend(["--agent-env", f"{key}={value}"])
    tags = f"bench:tb21,experiment:openviking-learning,attempt:{job_name.removeprefix('attempt-')}"
    command.extend(["--agent-env", f"KIMCHI_TAGS={tags}"])
    hostname = urllib.parse.urlparse(agent_env["OPENVIKING_URL"]).hostname
    if hostname:
        command.extend(["--allow-agent-host", hostname])
    command.extend(extra_args)
    return command


def lesson_query(task: str) -> str:
    return f"Terminal-Bench task {task}: verified solution strategies, commands, errors, and lessons"


def feedback_session_id(task: str, chain_id: str, attempt: int) -> str:
    raw = f"{task}\0{chain_id}\0{attempt}".encode()
    suffix = hashlib.sha256(raw).hexdigest()[:16]
    return f"tb-feedback-{safe_id(task, 48)}-{attempt}-{suffix}"


def attempt_identity(task: str, chain_id: str, condition: str, attempt: int) -> OpenVikingIdentity:
    peer_suffix = "" if condition == "warm" else f"-attempt-{attempt}"
    return OpenVikingIdentity(
        account=os.environ.get("OPENVIKING_ACCOUNT"),
        user=os.environ.get("OPENVIKING_USER"),
        peer=safe_id(f"tb21-{task}-{chain_id}{peer_suffix}"),
    )


def create_task_root(output_dir: Path, task: str, chain_id: str, condition: str) -> Path:
    task_name = task.split("/", 1)[-1]
    task_root = output_dir / safe_id(task_name) / safe_id(chain_id) / condition
    if task_root.exists():
        raise FileExistsError(
            f"Refusing to overwrite existing experiment output: {task_root}; use a new --chain-id"
        )
    task_root.mkdir(parents=True)
    return task_root


def run_attempt(
    *,
    task: str,
    attempt: int,
    chain_id: str,
    condition: str,
    model: str,
    dataset: str,
    task_root: Path,
    memory_wait_seconds: int,
    verifier_max_chars: int,
    harbor_args: list[str],
) -> dict[str, Any]:
    identity = attempt_identity(task, chain_id, condition, attempt)
    api_key = os.environ.get("OPENVIKING_API_KEY") or os.environ.get("OPENVIKING_BEARER_TOKEN")
    openviking_url = os.environ.get("OPENVIKING_URL") or os.environ.get("OPENVIKING_BASE_URL", "")
    client = OpenVikingClient(openviking_url, api_key=api_key, identity=identity)
    query = lesson_query(task)
    before = client.search(query)

    jobs_dir = task_root / "harbor"
    job_name = f"attempt-{attempt:02d}"
    job_dir = jobs_dir / job_name
    if job_dir.exists():
        raise FileExistsError(f"Refusing to overwrite existing attempt: {job_dir}")
    command = harbor_command(
        task=task,
        model=model,
        dataset=dataset,
        job_name=job_name,
        jobs_dir=jobs_dir,
        identity=identity,
        extra_args=harbor_args,
    )
    completed = subprocess.run(command, check=False)
    if not job_dir.exists():
        raise RuntimeError(f"Harbor exited {completed.returncode} without creating {job_dir}")
    trial_dir = find_trial_dir(job_dir)
    result = json.loads((trial_dir / "result.json").read_text())
    status_path = trial_dir / "agent" / "openviking-status.json"
    status = json.loads(status_path.read_text()) if status_path.is_file() else {"connected": False}
    if not status.get("connected"):
        raise RuntimeError(f"OpenViking was not connected inside the task container; see {status_path}")
    capture_session_id = captured_session_id(trial_dir)
    capture_commit_status = client.wait_for_commit(capture_session_id, memory_wait_seconds)
    capture_extraction_status = client.wait_for_session_extraction(
        capture_session_id,
        memory_wait_seconds,
    )
    require_agent_evolution(capture_extraction_status)

    reward = extract_reward(result)
    output, output_truncated = verifier_output(trial_dir, verifier_max_chars)
    content = feedback_content(
        task=task,
        attempt=attempt,
        reward=reward,
        result=result,
        output=output,
        output_truncated=output_truncated,
    )
    feedback_id = feedback_session_id(task, chain_id, attempt)
    archive = client.get_archive(extraction_archive_uri(capture_extraction_status))
    training_messages = verified_training_messages(
        task=task,
        attempt=attempt,
        reward=reward,
        feedback=content,
        archive=archive,
        peer_id=identity.peer,
    )
    commit_response = client.add_verified_lesson(feedback_id, training_messages)
    commit_status = client.wait_for_commit(feedback_id, memory_wait_seconds)
    commit_result = commit_response.get("result", commit_response)
    feedback_task_id = commit_result.get("task_id") if isinstance(commit_result, dict) else None
    if not isinstance(feedback_task_id, str) or not feedback_task_id:
        raise RuntimeError(f"OpenViking feedback commit did not return a task_id: {commit_response}")
    feedback_extraction_status = client.wait_for_task(feedback_task_id, memory_wait_seconds)
    warm_ollama()
    after = client.search(query)

    artifact_dir = trial_dir / "agent" / "openviking-learning"
    write_json(artifact_dir / "recall-before.json", before)
    write_json(
        artifact_dir / "capture-commit.json",
        {
            "archive": capture_commit_status,
            "extraction": capture_extraction_status,
        },
    )
    lesson = {
        "task": task,
        "attempt": attempt,
        "condition": condition,
        "reward": reward,
        "identity": {
            "account": identity.account,
            "user": identity.user,
            "peer": identity.peer,
        },
        "feedback_session_id": feedback_id,
        "capture_session_id": capture_session_id,
        "verifier_output_truncated": output_truncated,
        "content": content,
        "commit_response": commit_response,
        "commit_status": commit_status,
        "extraction_status": feedback_extraction_status,
    }
    write_json(artifact_dir / "lesson-submitted.json", lesson)
    write_json(artifact_dir / "memories-after.json", after)
    (artifact_dir / "memory-diff.md").write_text(render_memory_diff(before, after))
    return {
        "attempt": attempt,
        "reward": reward,
        "harbor_return_code": completed.returncode,
        "trial_dir": str(trial_dir),
        "peer": identity.peer,
        "capture_session_id": capture_session_id,
        "recalled_before": len(search_items(before)),
        "relevant_after": len(search_items(after)),
        "new_relevant_memories": len(set(search_items(after)) - set(search_items(before))),
    }


def parser() -> argparse.ArgumentParser:
    argument_parser = argparse.ArgumentParser(
        description="Run sequential Terminal-Bench attempts and preserve task-scoped OpenViking learning."
    )
    argument_parser.add_argument("--task", action="append", required=True, help="Task name; repeat for more tasks")
    argument_parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    argument_parser.add_argument("--condition", choices=("warm", "cold"), default="warm")
    argument_parser.add_argument("--model", default=DEFAULT_MODEL)
    argument_parser.add_argument("--dataset", default=DEFAULT_DATASET)
    argument_parser.add_argument("--chain-id", default=utc_timestamp())
    argument_parser.add_argument("--output-dir", type=Path, default=Path("learning"))
    argument_parser.add_argument("--memory-wait-seconds", type=int, default=DEFAULT_MEMORY_WAIT_SECONDS)
    argument_parser.add_argument("--verifier-max-chars", type=int, default=DEFAULT_VERIFIER_MAX_CHARS)
    argument_parser.add_argument(
        "harbor_args",
        nargs=argparse.REMAINDER,
        help="Extra arguments passed to `harbor run` after `--`.",
    )
    return argument_parser


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.attempts < 1:
        raise ValueError("--attempts must be at least 1")
    harbor_args = args.harbor_args
    if harbor_args[:1] == ["--"]:
        harbor_args = harbor_args[1:]

    bootstrap_identity = OpenVikingIdentity(
        account=os.environ.get("OPENVIKING_ACCOUNT"),
        user=os.environ.get("OPENVIKING_USER"),
        peer="tb21-bootstrap",
    )
    env = openviking_agent_env(bootstrap_identity)
    parsed_url = urllib.parse.urlparse(env["OPENVIKING_URL"])
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        raise ValueError("OPENVIKING_URL must be an absolute http(s) URL")
    if parsed_url.hostname in {"0.0.0.0", "127.0.0.1", "localhost", "::", "::1"}:
        raise ValueError(
            "OPENVIKING_URL points at loopback, which is not reachable from Terminal-Bench containers; "
            "use an authenticated container-reachable endpoint"
        )
    api_key = os.environ.get("OPENVIKING_API_KEY") or os.environ.get("OPENVIKING_BEARER_TOKEN")
    warm_ollama()
    OpenVikingClient(env["OPENVIKING_URL"], api_key=api_key, identity=bootstrap_identity).health()

    for task in args.task:
        task_root = create_task_root(args.output_dir, task, args.chain_id, args.condition)
        summary = {
            "task": task,
            "chain_id": args.chain_id,
            "condition": args.condition,
            "model": args.model,
            "dataset": args.dataset,
            "started_at": datetime.now(UTC).isoformat(),
            "attempts": [],
        }
        write_json(task_root / "summary.json", summary)
        for attempt in range(1, args.attempts + 1):
            attempt_summary = run_attempt(
                task=task,
                attempt=attempt,
                chain_id=args.chain_id,
                condition=args.condition,
                model=args.model,
                dataset=args.dataset,
                task_root=task_root,
                memory_wait_seconds=args.memory_wait_seconds,
                verifier_max_chars=args.verifier_max_chars,
                harbor_args=harbor_args,
            )
            summary["attempts"].append(attempt_summary)
            write_json(task_root / "summary.json", summary)
        summary["finished_at"] = datetime.now(UTC).isoformat()
        write_json(task_root / "summary.json", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
