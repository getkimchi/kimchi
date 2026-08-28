import os
import subprocess
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent


def _run_until_uv(tmp_path: Path, script_name: str, extra_env: dict[str, str]) -> list[str]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_uv = fake_bin / "uv"
    fake_uv.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n')
    fake_uv.chmod(0o755)

    env = os.environ.copy()
    for name in ("DATASET", "JOBS_DIR", "MODEL", "PI_VERSION"):
        env.pop(name, None)
    env.update(extra_env)
    env["PATH"] = f"{fake_bin}{os.pathsep}{env['PATH']}"

    result = subprocess.run(
        ["bash", str(SCRIPTS_DIR / script_name)],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()


def _option_value(arguments: list[str], option: str) -> str:
    return arguments[arguments.index(option) + 1]


def test_pi_runner_uses_current_kimchi_model_and_terminal_bench_2_1(tmp_path: Path) -> None:
    arguments = _run_until_uv(
        tmp_path,
        "run-pi-kimchi.sh",
        {"KIMCHI_API_KEY": "test-key"},
    )

    assert _option_value(arguments, "--model") == "kimchi-dev/kimi-k2.7"
    assert _option_value(arguments, "-d") == "terminal-bench/terminal-bench-2-1"


def test_cursor_runner_defaults_to_terminal_bench_2_1(tmp_path: Path) -> None:
    arguments = _run_until_uv(
        tmp_path,
        "run-cursor.sh",
        {"CURSOR_API_KEY": "test-key"},
    )

    assert _option_value(arguments, "-d") == "terminal-bench/terminal-bench-2-1"


def test_cursor_runner_accepts_dataset_override(tmp_path: Path) -> None:
    arguments = _run_until_uv(
        tmp_path,
        "run-cursor.sh",
        {
            "CURSOR_API_KEY": "test-key",
            "DATASET": "terminal-bench/terminal-bench-2",
        },
    )

    assert _option_value(arguments, "-d") == "terminal-bench/terminal-bench-2"
