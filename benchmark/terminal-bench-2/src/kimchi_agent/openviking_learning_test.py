from pathlib import Path

import pytest
from openviking_learning import (
    TRAINING_CASE_SPEC_HEADER,
    TRAINING_MEMORY_POLICY,
    OpenVikingClient,
    OpenVikingIdentity,
    attempt_identity,
    captured_session_id,
    create_task_root,
    extract_reward,
    extraction_archive_uri,
    feedback_content,
    feedback_session_id,
    harbor_command,
    render_memory_diff,
    require_agent_evolution,
    search_items,
    verified_training_messages,
    verifier_output,
    warm_ollama,
)


def test_warm_identity_is_stable_and_cold_identity_changes_per_attempt(monkeypatch) -> None:
    monkeypatch.setenv("OPENVIKING_ACCOUNT", "tb-account")
    monkeypatch.setenv("OPENVIKING_USER", "kimchi")

    warm_one = attempt_identity("terminal-bench/fix-git", "chain-1", "warm", 1)
    warm_two = attempt_identity("terminal-bench/fix-git", "chain-1", "warm", 2)
    cold_one = attempt_identity("terminal-bench/fix-git", "chain-1", "cold", 1)
    cold_two = attempt_identity("terminal-bench/fix-git", "chain-1", "cold", 2)

    assert warm_one == warm_two
    assert cold_one.peer != cold_two.peer
    assert warm_one.account == "tb-account"
    assert warm_one.user == "kimchi"


def test_search_items_and_diff_report_new_relevant_memory() -> None:
    before = {
        "result": {
            "memories": [{"uri": "viking://memory/old", "score": 0.7, "abstract": "Old lesson"}]
        }
    }
    after = {
        "result": {
            "memories": [
                {"uri": "viking://memory/old", "score": 0.8, "abstract": "Old lesson"},
                {"uri": "viking://memory/new", "score": 0.9, "abstract": "Verified fix"},
            ]
        }
    }

    assert set(search_items(after)) == {"viking://memory/old", "viking://memory/new"}
    report = render_memory_diff(before, after)
    assert "New relevant memories" in report
    assert "viking://memory/new" in report
    assert "Verified fix" in report


def test_search_retries_transient_openviking_failure(monkeypatch) -> None:
    identity = OpenVikingIdentity(account=None, user=None, peer="task-peer")
    client = OpenVikingClient("https://memory.example.test", identity=identity)
    responses: list[object] = [RuntimeError("timeout"), {"status": "ok", "result": {}}]

    def request(*_args, **_kwargs):
        response = responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(client, "request", request)
    monkeypatch.setattr("openviking_learning.time.sleep", lambda _seconds: None)

    assert client.search("task lesson") == {"status": "ok", "result": {}}
    assert responses == []


def test_ollama_warmup_is_optional(monkeypatch) -> None:
    monkeypatch.delenv("OPENVIKING_OLLAMA_URL", raising=False)

    warm_ollama()


def test_ollama_warmup_loads_embedding_model(monkeypatch) -> None:
    requests = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b"{}"

    def urlopen(request, *, timeout):
        requests.append((request, timeout))
        return Response()

    monkeypatch.setenv("OPENVIKING_OLLAMA_URL", "http://ollama.test/")
    monkeypatch.setenv("OPENVIKING_OLLAMA_EMBEDDING_MODEL", "embedding-test")
    monkeypatch.setattr("openviking_learning.urllib.request.urlopen", urlopen)

    warm_ollama()

    request, timeout = requests[0]
    assert request.full_url == "http://ollama.test/v1/embeddings"
    assert b'"model": "embedding-test"' in request.data
    assert timeout > 0


def test_wait_for_task_waits_for_background_extraction(monkeypatch) -> None:
    identity = OpenVikingIdentity(account=None, user=None, peer="task-peer")
    client = OpenVikingClient("https://memory.example.test", identity=identity)
    responses = [
        {"result": {"task_id": "task-1", "status": "running"}},
        {"result": {"task_id": "task-1", "status": "completed"}},
    ]
    monkeypatch.setattr(client, "request", lambda *_args, **_kwargs: responses.pop(0))
    monkeypatch.setattr("openviking_learning.time.sleep", lambda _seconds: None)

    result = client.wait_for_task("task-1", 10)

    assert result["result"]["status"] == "completed"
    assert responses == []


def test_learning_chain_rejects_disabled_agent_evolution() -> None:
    extraction_status = {
        "result": {
            "status": "completed",
            "result": {
                "agent_evolution_enabled": False,
                "agent_memory_skip_reason": "agent_evolution_disabled",
            },
        }
    }

    with pytest.raises(RuntimeError, match="Agent Evolution is disabled"):
        require_agent_evolution(extraction_status)


def test_learning_chain_accepts_enabled_agent_evolution() -> None:
    extraction_status = {
        "result": {"status": "completed", "result": {"agent_evolution_enabled": True}}
    }

    require_agent_evolution(extraction_status)


def test_extraction_archive_uri_reads_nested_task_result() -> None:
    extraction_status = {
        "result": {
            "status": "completed",
            "result": {"archive_uri": "viking://session/archive_001"},
        }
    }

    assert extraction_archive_uri(extraction_status) == "viking://session/archive_001"


def test_get_archive_reads_raw_jsonl_when_summary_is_disabled(monkeypatch) -> None:
    client = OpenVikingClient(
        "https://memory.example.test",
        identity=OpenVikingIdentity(account=None, user=None, peer="task-peer"),
    )
    requests = []

    def request(path, **_kwargs):
        requests.append(path)
        return {
            "status": "ok",
            "result": (
                '{"role":"user","parts":[{"type":"text","text":"task"}]}\n'
                '{"role":"assistant","parts":[{"type":"text","text":"done"}]}\n'
            ),
        }

    monkeypatch.setattr(client, "request", request)

    archive = client.get_archive("viking://session/history/archive_001")

    assert archive["result"]["archive_id"] == "archive_001"
    assert [message["role"] for message in archive["result"]["messages"]] == [
        "user",
        "assistant",
    ]
    assert requests[0].startswith("/api/v1/content/read?")
    assert "raw=true" in requests[0]


def test_feedback_records_reward_exception_and_verifier_output() -> None:
    result = {"exception_info": {"exception_type": "AgentTimeoutError"}}

    content = feedback_content(
        task="terminal-bench/fix-git",
        attempt=2,
        reward=0.0,
        result=result,
        output="one assertion failed",
        output_truncated=False,
    )

    assert "Attempt: 2" in content
    assert "Verifier reward: 0.0" in content
    assert "AgentTimeoutError" in content
    assert "one assertion failed" in content


def test_verified_training_messages_replay_rollout_with_structured_outcome() -> None:
    archive = {
        "result": {
            "messages": [
                {
                    "id": "ignored-id",
                    "role": "user",
                    "parts": [{"type": "text", "text": "Recover my missing changes"}],
                    "peer_id": "capture-peer",
                },
                {
                    "role": "assistant",
                    "parts": [{"type": "text", "text": "Used git reflog and cherry-pick"}],
                    "peer_id": "capture-peer",
                },
            ]
        }
    }

    messages = verified_training_messages(
        task="terminal-bench/fix-git",
        attempt=1,
        reward=1.0,
        feedback="Verifier reward: 1.0",
        archive=archive,
        peer_id="lesson-peer",
    )

    case_text = messages[0]["parts"][0]["text"]
    evaluation_text = messages[-1]["parts"][0]["text"]
    assert case_text.startswith(TRAINING_CASE_SPEC_HEADER)
    assert '"protocol": "openviking.batch_train.case_spec.v1"' in case_text
    assert '"user_query": "Recover my missing changes"' in case_text
    assert messages[1]["role"] == "user"
    assert "id" not in messages[1]
    assert '"passed": true' in evaluation_text
    assert '"score": 1.0' in evaluation_text


def test_verified_lesson_uses_agent_only_training_policy(monkeypatch) -> None:
    client = OpenVikingClient(
        "https://memory.example.test",
        identity=OpenVikingIdentity(account=None, user=None, peer="lesson-peer"),
    )
    requests = []

    def request(path, *, method="GET", body=None, timeout_seconds=None):
        requests.append((path, method, body, timeout_seconds))
        return {"status": "ok", "result": {"task_id": "task-1"}}

    monkeypatch.setattr(client, "request", request)

    response = client.add_verified_lesson("lesson-1", [{"role": "user", "content": "lesson"}])

    assert response["result"]["task_id"] == "task-1"
    assert requests[0][2] == {
        "session_id": "lesson-1",
        "memory_policy": TRAINING_MEMORY_POLICY,
    }
    assert requests[1][0].endswith("/messages/batch")
    assert requests[1][2] == {"messages": [{"role": "user", "content": "lesson"}]}
    assert requests[2][0].endswith("/commit")


def test_verifier_output_keeps_bounded_tail(tmp_path: Path) -> None:
    trial_dir = tmp_path / "trial"
    verifier_dir = trial_dir / "verifier"
    verifier_dir.mkdir(parents=True)
    (verifier_dir / "test-stdout.txt").write_text("prefix-important\nTAIL")

    output, truncated = verifier_output(trial_dir, 4)

    assert output == "TAIL"
    assert truncated is True


def test_captured_session_id_uses_pi_session_header(tmp_path: Path) -> None:
    session_dir = tmp_path / "agent" / "sessions"
    session_dir.mkdir(parents=True)
    (session_dir / "main.jsonl").write_text(
        '{"type":"session","id":"session-123"}\n{"type":"message","message":{}}\n'
    )

    assert captured_session_id(tmp_path) == "pi-session-123"


def test_harbor_command_uses_openviking_agent_and_single_attempt(monkeypatch, tmp_path: Path) -> None:
    extension_dir = tmp_path / "openviking"
    extension_dir.mkdir()
    (extension_dir / "index.ts").write_text("export default function () {}\n")
    monkeypatch.setenv("KIMCHI_API_KEY", "kimchi-key")
    monkeypatch.setenv("OPENVIKING_EXTENSION_DIR", str(extension_dir))
    monkeypatch.setenv("OPENVIKING_URL", "https://memory.example.test")
    identity = OpenVikingIdentity(account="account", user="user", peer="task-peer")

    command = harbor_command(
        task="terminal-bench/fix-git",
        model="kimchi-dev/kimi-k2.7",
        dataset="terminal-bench/terminal-bench-2-1",
        job_name="attempt-01",
        jobs_dir=tmp_path / "jobs",
        identity=identity,
        extra_args=["--timeout-multiplier", "0.5"],
    )
    rendered = " ".join(command)

    assert "kimchi_agent:KimchiOpenViking" in command
    assert "OPENVIKING_PEER_ID=task-peer" in command
    assert "--n-concurrent 1" in rendered
    assert "--n-attempts 1" in rendered
    assert "--agent kimchi_agent:KimchiOpenViking" in rendered
    assert "--env docker --model" in rendered
    assert "--allow-agent-host memory.example.test" in rendered
    assert rendered.endswith("--timeout-multiplier 0.5")


def test_reward_and_feedback_session_id_are_deterministic() -> None:
    result = {"verifier_result": {"rewards": {"reward": 1}}}

    assert extract_reward(result) == 1.0
    first = feedback_session_id("terminal-bench/fix-git", "chain", 1)
    second = feedback_session_id("terminal-bench/fix-git", "chain", 1)
    assert first == second
    assert first.startswith("tb-feedback-")


def test_create_task_root_refuses_to_overwrite_a_chain(tmp_path: Path) -> None:
    task_root = create_task_root(tmp_path, "terminal-bench/fix-git", "chain-1", "warm")

    assert task_root == tmp_path / "fix-git" / "chain-1" / "warm"
    with pytest.raises(FileExistsError, match="new --chain-id"):
        create_task_root(tmp_path, "terminal-bench/fix-git", "chain-1", "warm")
