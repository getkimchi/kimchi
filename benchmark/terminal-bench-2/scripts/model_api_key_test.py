import os
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).with_name("model_api_key.sh")
ALL_ROUTES = ("kimchi-dev", "multi-model", "openrouter", "anthropic", "moonshotai", "zai", "openai")


@pytest.mark.parametrize(
    ("model", "env_name"),
    [
        ("kimchi-dev/kimi-k2.7", "KIMCHI_API_KEY"),
        ("multi-model", "KIMCHI_API_KEY"),
        ("openrouter/example/model", "OPENROUTER_API_KEY"),
        ("anthropic/claude-sonnet-5", "ANTHROPIC_API_KEY"),
        ("moonshotai/kimi-k3", "MOONSHOT_API_KEY"),
        ("zai/glm-5.2", "ZAI_API_KEY"),
        ("openai/gpt-5.6-luna", "OPENAI_API_KEY"),
    ],
)
def test_resolves_model_route_to_required_api_key(model: str, env_name: str) -> None:
    env = {**os.environ, env_name: "test-key"}
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; shift; require_model_api_key "$@"; printf "%s" "$MODEL_API_KEY_ENV"',
            "bash",
            str(HELPER),
            model,
            *ALL_ROUTES,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 0
    assert result.stdout == env_name


def test_reports_the_route_specific_missing_key() -> None:
    env = os.environ.copy()
    env.pop("MOONSHOT_API_KEY", None)
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; require_model_api_key moonshotai/kimi-k3 moonshotai',
            "bash",
            str(HELPER),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 1
    assert result.stderr == "MOONSHOT_API_KEY is required for moonshotai/kimi-k3\n"


def test_rejects_a_known_route_not_supported_by_the_runner() -> None:
    env = {**os.environ, "ANTHROPIC_API_KEY": "test-key"}
    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"; require_model_api_key anthropic/claude-sonnet-5 kimchi-dev openrouter moonshotai',
            "bash",
            str(HELPER),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )

    assert result.returncode == 1
    assert result.stderr == (
        "model route anthropic is not supported by this runner: "
        "anthropic/claude-sonnet-5\n"
    )
