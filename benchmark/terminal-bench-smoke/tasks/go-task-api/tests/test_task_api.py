"""Black-box verifier for the go-task-api task.

Builds the agent's server binary, runs it, and exercises the documented
HTTP contract end-to-end. Also runs the agent's own service-layer unit tests.
"""

import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

APP_DIR = Path("/app/task-api")
SERVER_BIN = "/tmp/taskapi-server"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_directory_exists():
    assert APP_DIR.is_dir(), f"missing {APP_DIR}"
    assert (APP_DIR / "go.mod").is_file(), "missing go.mod"
    assert (APP_DIR / "cmd" / "server" / "main.go").is_file(), "missing cmd/server/main.go"


def test_unit_tests_pass():
    res = subprocess.run(
        ["go", "test", "./..."],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert res.returncode == 0, f"go test failed:\nstdout:\n{res.stdout}\nstderr:\n{res.stderr}"


@pytest.fixture(scope="module")
def server():
    build = subprocess.run(
        ["go", "build", "-o", SERVER_BIN, "./cmd/server"],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert build.returncode == 0, f"go build failed:\n{build.stderr}"

    port = _free_port()
    env = os.environ.copy()
    env["PORT"] = str(port)
    proc = subprocess.Popen(
        [SERVER_BIN],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            httpx.get(base_url + "/tasks", timeout=0.5)
            break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("server did not become ready")

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def test_create_returns_201_with_id(server):
    r = httpx.post(server + "/tasks", json={"title": "buy milk", "description": "2L"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body.get("id"), f"missing id in {body}"
    assert body.get("title") == "buy milk"
    assert body.get("description") == "2L"
    assert body.get("status") == "todo"


def test_list_includes_created(server):
    r = httpx.post(server + "/tasks", json={"title": "task A", "description": ""})
    assert r.status_code == 201
    created_id = r.json()["id"]

    r = httpx.get(server + "/tasks")
    assert r.status_code == 200
    items = r.json()
    assert isinstance(items, list)
    assert any(t.get("id") == created_id for t in items)


def test_get_by_id_and_404(server):
    r = httpx.post(server + "/tasks", json={"title": "x", "description": ""})
    tid = r.json()["id"]

    r = httpx.get(f"{server}/tasks/{tid}")
    assert r.status_code == 200
    assert r.json()["id"] == tid

    r = httpx.get(f"{server}/tasks/does-not-exist-xyz")
    assert r.status_code == 404


def test_patch_status(server):
    r = httpx.post(server + "/tasks", json={"title": "p", "description": ""})
    tid = r.json()["id"]

    r = httpx.patch(f"{server}/tasks/{tid}", json={"status": "in-progress"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "in-progress"

    r = httpx.patch(f"{server}/tasks/{tid}", json={"status": "bogus"})
    assert r.status_code == 400

    r = httpx.patch(f"{server}/tasks/missing-xyz", json={"status": "done"})
    assert r.status_code == 404


def test_delete(server):
    r = httpx.post(server + "/tasks", json={"title": "d", "description": ""})
    tid = r.json()["id"]

    r = httpx.delete(f"{server}/tasks/{tid}")
    assert r.status_code == 204

    r = httpx.get(f"{server}/tasks/{tid}")
    assert r.status_code == 404

    r = httpx.delete(f"{server}/tasks/missing-xyz")
    assert r.status_code == 404
