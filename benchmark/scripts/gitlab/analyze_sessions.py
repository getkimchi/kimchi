#!/usr/bin/env python3
"""Analyze benchmark session files with Kimchi and produce an HTML report.

The script is intended to run in the GitLab CI postprocess stage, after
summary.json has been generated. It discovers the benchmark results directory,
locates all session JSONL files, and invokes the Kimchi CLI with a prompt that
asks it to analyze the sessions, identify patterns and potential issues, and
write a structured HTML report.

The analysis and retry prompts are loaded from sibling text files
(analysis_prompt.txt, retry_prompt.txt) so they can be edited as plain text
without touching Python string syntax.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def find_summary(summary_path: Path) -> Path | None:
    return summary_path if summary_path.is_file() else None


def find_session_files(results_dir: Path) -> list[Path]:
    """Return sorted list of session JSONL files under results_dir."""
    if not results_dir.is_dir():
        return []
    return sorted(p for p in results_dir.rglob("*.jsonl") if p.is_file() and "agent/sessions" in str(p))


def _kimchi_binary() -> str:
    return getenv("KIMCHI_CODE_BINARY", "kimchi")


def _kimchi_model() -> str:
    return getenv("KIMCHI_ANALYSIS_MODEL", "kimchi-dev/glm-5.2-fp8")


def _load_prompt(filename: str, **substitutions: object) -> str:
    """Load a prompt template from a sibling text file and substitute placeholders."""
    prompt_dir = Path(__file__).resolve().parent
    template = (prompt_dir / filename).read_text(encoding="utf-8")
    return template.format(**substitutions)


def build_analysis_prompt(
    *,
    results_dir: Path,
    summary_path: Path,
    draft_path: Path,
) -> str:
    """Build the prompt that instructs Kimchi to analyze sessions and write HTML."""
    return _load_prompt(
        "analysis_prompt.txt",
        results_dir=results_dir,
        summary_path=summary_path,
        draft_path=draft_path,
    )


def build_retry_prompt(*, draft_path: Path, validation_error: str) -> str:
    """Build a corrective prompt for a resumed analysis session."""
    return _load_prompt(
        "retry_prompt.txt",
        draft_path=draft_path,
        validation_error=validation_error,
    )


def run_kimchi_attempt(
    *,
    prompt: str,
    session_dir: Path,
    timeout_seconds: int,
    continue_session: bool,
) -> bool:
    """Run one Kimchi analysis turn, optionally resuming the isolated session."""
    binary = _kimchi_binary()
    model = _kimchi_model()
    cmd = [binary]
    if continue_session:
        cmd.append("--continue")
    cmd.extend([
        "-p",
        prompt,
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--model",
        model,
        "--tools",
        "read,write,edit,grep,find,ls,bash,Agent",
        "--session-dir",
        str(session_dir),
    ])

    display_cmd = [binary]
    if continue_session:
        display_cmd.append("--continue")
    display_cmd.extend(["-p", "<prompt>", *cmd[cmd.index(prompt) + 1 :]])
    print(
        f"Running Kimchi analysis: {shlex.join(display_cmd)}",
        flush=True,
    )
    print(f"Timeout: {timeout_seconds}s", flush=True)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        print(f"Kimchi analysis timed out after {timeout_seconds}s", file=sys.stderr, flush=True)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        return False

    if result.stdout:
        print(result.stdout, flush=True)
    if result.stderr:
        print(result.stderr, file=sys.stderr, flush=True)

    if result.returncode != 0:
        print(f"Kimchi analysis failed with exit code {result.returncode}", file=sys.stderr, flush=True)
        return False

    return True


def read_analysis_draft(draft_path: Path) -> tuple[str | None, str | None]:
    """Read and validate the draft, returning its content and any validation error."""
    try:
        content = draft_path.read_text(encoding="utf-8").strip()
    except OSError:
        return None, f"analysis draft was not written at {draft_path}"
    return content, validate_analysis_html(content)


def run_kimchi_analysis(
    *,
    results_dir: Path,
    summary_path: Path,
    draft_path: Path,
    session_dir: Path,
    timeout_seconds: int,
    max_retries: int,
) -> str | None:
    """Run the analysis and resume the session to repair invalid drafts."""
    prompt = build_analysis_prompt(
        results_dir=results_dir,
        summary_path=summary_path,
        draft_path=draft_path,
    )

    for attempt in range(max_retries + 1):
        if not run_kimchi_attempt(
            prompt=prompt,
            session_dir=session_dir,
            timeout_seconds=timeout_seconds,
            continue_session=attempt > 0,
        ):
            return None

        content, validation_error = read_analysis_draft(draft_path)
        if validation_error is None:
            return content

        print(
            f"Analysis draft validation failed after attempt {attempt + 1}/{max_retries + 1}: {validation_error}",
            file=sys.stderr,
            flush=True,
        )
        if attempt == max_retries:
            return None
        prompt = build_retry_prompt(draft_path=draft_path, validation_error=validation_error)

    return None


def validate_analysis_html(content: str) -> str | None:
    """Return a validation error, or None when content is a safe complete HTML document."""
    if not content:
        return "analysis output is empty"

    lowered = content.lower()
    if not lowered.startswith("<!doctype html"):
        return "analysis output must start with <!doctype html>"
    if "<html" not in lowered or "</html>" not in lowered:
        return "analysis output is missing a complete <html> document"
    if "<body" not in lowered or "</body>" not in lowered:
        return "analysis output is missing a complete <body> element"
    if "<script" in lowered:
        return "analysis output must not contain scripts"
    if re.search(r"<(?:iframe|object|embed|link)\b", lowered):
        return "analysis output must not contain externally loaded or embedded resources"
    if re.search(r"\s(?:src|srcset)\s*=", lowered) or re.search(r"(?:@import|url\s*\()", lowered):
        return "analysis output must not reference external resources"
    if re.search(r"\son[a-z]+\s*=", lowered):
        return "analysis output must not contain inline event handlers"
    return None


def write_analysis_html(output_path: Path, content: str) -> None:
    """Atomically replace output_path with a validated report."""
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    temporary_path.write_text(f"{content}\n", encoding="utf-8")
    temporary_path.replace(output_path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze benchmark sessions with Kimchi and produce an HTML report.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=Path(getenv("BENCHMARK_RESULTS_DIR", "benchmark/terminal-bench-2/jobs")),
        help="Path to benchmark results directory containing trial outputs.",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=Path(getenv("BENCHMARK_SUMMARY_PATH", ".benchmark/summary.json")),
        help="Path to summary.json.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(getenv("BENCHMARK_ANALYSIS_OUTPUT", ".benchmark/analysis.html")),
        help="Path where the HTML analysis report will be written.",
    )
    parser.add_argument(
        "--draft",
        type=Path,
        default=Path(getenv("BENCHMARK_ANALYSIS_DRAFT", ".benchmark/analysis-work/report.html")),
        help="Path Kimchi uses to iteratively write the report draft.",
    )
    parser.add_argument(
        "--session-dir",
        type=Path,
        default=Path(
            getenv("BENCHMARK_ANALYSIS_SESSION_DIR", f".benchmark/analysis-session-{os.getpid()}")
        ),
        help="Isolated Kimchi session directory used for corrective retries.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(getenv("KIMCHI_ANALYSIS_TIMEOUT_SECONDS", "3600")),
        help="Maximum seconds to wait for the Kimchi analysis subprocess.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=int(getenv("KIMCHI_ANALYSIS_MAX_RETRIES", "2")),
        help="Maximum corrective retries after draft validation failures.",
    )
    args = parser.parse_args()

    results_dir = args.results_dir
    if not results_dir.is_absolute():
        results_dir = Path.cwd() / results_dir

    summary_path = args.summary
    if not summary_path.is_absolute():
        summary_path = Path.cwd() / summary_path

    output_path = args.output
    if not output_path.is_absolute():
        output_path = Path.cwd() / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f".{output_path.name}.tmp")
    output_path.unlink(missing_ok=True)
    temporary_path.unlink(missing_ok=True)

    draft_path = args.draft
    if not draft_path.is_absolute():
        draft_path = Path.cwd() / draft_path
    draft_path.parent.mkdir(parents=True, exist_ok=True)
    draft_path.unlink(missing_ok=True)

    session_dir = args.session_dir
    if not session_dir.is_absolute():
        session_dir = Path.cwd() / session_dir
    session_dir.mkdir(parents=True, exist_ok=True)

    if not find_summary(summary_path):
        print(f"Error: summary not found at {summary_path}", file=sys.stderr, flush=True)
        return 1

    session_files = find_session_files(results_dir)
    print(f"Found {len(session_files)} session files under {results_dir}", flush=True)
    if not session_files:
        print("Error: no session files found; nothing to analyze", file=sys.stderr, flush=True)
        return 1

    analysis_html = run_kimchi_analysis(
        results_dir=results_dir,
        summary_path=summary_path,
        draft_path=draft_path,
        session_dir=session_dir,
        timeout_seconds=args.timeout,
        max_retries=max(0, args.max_retries),
    )
    if analysis_html is None:
        return 1

    validation_error = validate_analysis_html(analysis_html)
    if validation_error:
        print(f"Error: {validation_error}", file=sys.stderr, flush=True)
        return 1

    write_analysis_html(output_path, analysis_html)

    print(f"Analysis HTML written to {output_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
