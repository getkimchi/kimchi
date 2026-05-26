"""Black-box verifier for the go-rate-limiter task.

Builds the agent's demo server, runs it, and checks:
- agent's own `go test` passes
- 10 reqs/s succeed; the 11th in a burst returns 429
- Two distinct IPs are tracked independently
"""

import os
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

APP_DIR = Path("/app/rate-limiter")
SERVER_BIN = "/tmp/rl-server"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_directory_exists():
    assert APP_DIR.is_dir(), f"missing {APP_DIR}"
    assert (APP_DIR / "ratelimiter.go").is_file(), "missing ratelimiter.go"
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
            httpx.get(base_url + "/", timeout=0.5)
            break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("server did not become ready on :%d" % port)

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def _burst(url: str, ip: str, n: int) -> list[int]:
    statuses = []
    with httpx.Client(timeout=2.0) as c:
        for _ in range(n):
            r = c.get(url, headers={"X-Forwarded-For": ip})
            statuses.append(r.status_code)
    return statuses


def test_within_limit_passes(server):
    statuses = _burst(server + "/", "10.0.0.1", 10)
    assert statuses.count(200) == 10, f"expected 10x 200, got {statuses}"


def test_burst_exceeds_returns_429(server):
    statuses = _burst(server + "/", "10.0.0.2", 30)
    assert 429 in statuses, f"expected at least one 429, got {statuses}"
    # Token bucket: 10 burst capacity + refill during ~hundreds of ms of HTTP roundtrips.
    # Loose ceiling guarding against an effectively-disabled limiter.
    assert statuses.count(200) <= 20, f"too many 200s, limiter not enforcing: {statuses}"


def test_per_ip_isolation(server):
    time.sleep(1.1)
    a = _burst(server + "/", "10.0.0.3", 10)
    b = _burst(server + "/", "10.0.0.4", 10)
    assert a.count(200) == 10, f"ip A: {a}"
    assert b.count(200) == 10, f"ip B: {b}"
