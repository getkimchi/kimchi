#!/usr/bin/env python3
"""Summarize benchmark analysis files from GCS using Claude Opus and post to Discord.

This script runs as a standalone CI job. It:
1. Lists metadata.json files from GCS for today and yesterday.
2. Downloads and filters them by time window, target_ref, and full-run criteria.
3. Downloads analysis.html for qualifying runs and extracts text.
4. Splits runs into ferment and non-ferment groups.
5. Calls Claude Opus to summarize each group (under 2000 chars).
6. Posts results to Discord via webhook.

No GitLab API dependency — all discovery happens through GCS.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib import error, request

from extract_analysis_text import extract_text


# --- Constants ---

OPUS_MODEL = "claude-opus-4-6"
OPUS_API_URL = "https://llm.kimchi.dev/openai/v1/chat/completions"
OPUS_SYSTEM_PROMPT = (
    "Analyze Terminal-Bench 2.1 benchmark results across multiple model runs "
    "on the same 89-task suite. Context: each task has a fixed wall-clock timeout "
    "invisible to the agent. Timeout retries are disabled. "
    "Report at most 5 issues that cause low pass rates, high timeout counts, "
    "or high error rates. Include critical and high-impact findings only; "
    "disregard low-impact ones. For each issue: state the impact with real numbers "
    "from the data (which models, how many tasks/trials affected, tokens wasted), "
    "name the suspected root cause layer, and give a one-line recommendation. "
    "Keep output under 2000 characters."
)
DISCORD_MAX_CHARS = 2000  # Used by _post_long_message for chunking
MAX_RETRIES = 3
DISCORD_API_BASE = "https://discord.com/api/v10"


# --- Helpers ---

def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def require_env(name: str) -> str:
    value = getenv(name)
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def run(cmd: list[str]) -> str:
    """Run a command and return stdout."""
    print(f"Running: {' '.join(cmd)}", flush=True)
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    stdout = result.stdout.strip()
    if result.stderr:
        print(f"  stderr: {result.stderr.strip()}", flush=True)
    return stdout


def compute_lookback_dates(now: datetime) -> tuple[str, str]:
    """Return (yesterday_str, today_str) as YYYY-MM-DD."""
    yesterday = now - timedelta(days=1)
    return yesterday.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")


def is_in_time_window(created_at: datetime, now: datetime) -> bool:
    """Check if created_at is between yesterday 17:00 and today 06:00 UTC."""
    window_start = (now - timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0)
    window_end = now.replace(hour=6, minute=0, second=0, microsecond=0)
    return window_start <= created_at <= window_end


def is_full_run(metadata: dict[str, Any]) -> bool:
    """Check if the run used the full task suite (89 tasks)."""
    run_meta = metadata.get("run_metadata", {})
    tasks_all = run_meta.get("tasks_all")
    if isinstance(tasks_all, bool):
        return tasks_all
    # Fallback: count selected_tasks
    selected = run_meta.get("selected_tasks", [])
    return len(selected) >= 89


def filter_metadata(metadata: dict[str, Any], now: datetime) -> bool:
    """Apply all filter criteria to a metadata dict.

    Returns True if the run qualifies for summarization.
    """
    # Time window
    created_at_str = metadata.get("created_at", "")
    if not created_at_str:
        return False
    try:
        created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if not is_in_time_window(created_at, now):
        return False

    # Target ref
    gitlab = metadata.get("gitlab", {})
    if not isinstance(gitlab, dict):
        return False
    if gitlab.get("target_ref") != "master":
        return False

    # Full runs only
    if not is_full_run(metadata):
        return False

    return True


def split_by_ferment(runs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split runs into (ferment, non_ferment) groups based on the 'ferment' field."""
    ferment: list[dict[str, Any]] = []
    non_ferment: list[dict[str, Any]] = []
    for run_meta in runs:
        if run_meta.get("ferment") is True:
            ferment.append(run_meta)
        else:
            non_ferment.append(run_meta)
    return ferment, non_ferment


# --- Opus summarization ---

def call_opus(user_content: str, api_key: str) -> str | None:
    """Call Claude Opus via the OpenAI-compatible API and return the summary text.

    Returns None if all retries fail.
    """
    payload = json.dumps({
        "model": OPUS_MODEL,
        "messages": [
            {"role": "system", "content": OPUS_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": 4096,
    }).encode()

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "kimchi-benchmark-summarizer/1.0",
    }

    for attempt in range(MAX_RETRIES):
        try:
            req = request.Request(OPUS_API_URL, data=payload, headers=headers, method="POST")
            with request.urlopen(req, timeout=120) as response:
                if response.status != 200:
                    print(f"Opus API returned status {response.status}", file=sys.stderr, flush=True)
                    if attempt < MAX_RETRIES - 1:
                        time.sleep(2 ** (attempt + 1))
                    continue
                data = json.loads(response.read().decode())
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    return content.strip()
                print("Opus API returned empty content", file=sys.stderr, flush=True)
        except (error.URLError, error.HTTPError, OSError) as exc:
            print(f"Opus API attempt {attempt + 1} failed: {exc}", file=sys.stderr, flush=True)
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** (attempt + 1))

    return None


# --- Discord posting ---

def _discord_post(url: str, bot_token: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    """POST JSON to Discord API with bot auth. Returns parsed response or None on failure."""
    data = json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bot {bot_token}",
        "Content-Type": "application/json",
        "User-Agent": "curl/8.7.1",
    }
    try:
        req = request.Request(url, data=data, headers=headers, method="POST")
        with request.urlopen(req, timeout=30) as response:
            body = response.read().decode()
            return json.loads(body) if body else {}
    except (error.URLError, error.HTTPError, OSError, json.JSONDecodeError) as exc:
        print(f"Discord API call to {url} failed: {exc}", file=sys.stderr, flush=True)
        return None


def _post_long_message(url: str, bot_token: str, content: str) -> bool:
    """Post a message that may exceed Discord's 2000-char limit by splitting into multiple messages."""
    chunks = []
    remaining = content
    while len(remaining) > DISCORD_MAX_CHARS:
        # Try to split at the last paragraph boundary (\n\n) within the limit
        split_at = remaining.rfind("\n\n", 0, DISCORD_MAX_CHARS)
        if split_at >= DISCORD_MAX_CHARS // 2:
            split_at += 2  # include the \n\n in the first chunk
        else:
            # Fall back to single newline
            split_at = remaining.rfind("\n", 0, DISCORD_MAX_CHARS)
            if split_at >= DISCORD_MAX_CHARS // 2:
                split_at += 1
            else:
                # Fall back to sentence boundary
                split_at = remaining.rfind(". ", 0, DISCORD_MAX_CHARS)
                if split_at >= DISCORD_MAX_CHARS // 2:
                    split_at += 2
                else:
                    # Hard cut
                    split_at = DISCORD_MAX_CHARS
        chunks.append(remaining[:split_at])
        remaining = remaining[split_at:]
    chunks.append(remaining)

    for chunk in chunks:
        resp = _discord_post(url, bot_token, {"content": chunk})
        if resp is None:
            return False
    return True


def post_to_discord(bot_token: str, channel_id: str, headline: str, thread_name: str, summary: str) -> bool:
    """Create a thread in the channel, then post the headline and summary inside it.

    Uses the Discord Bot API (v10). Creates a standalone thread (not attached to a message)
    to avoid requiring READ_MESSAGE_HISTORY permission.
    Returns True on success, False on failure.
    """
    # Step 1: Create a thread (type 11 = PUBLIC_THREAD, no message reference needed)
    thread_url = f"{DISCORD_API_BASE}/channels/{channel_id}/threads"
    print(f"Discord: creating thread '{thread_name}' in channel {channel_id}", flush=True)
    thread_resp = _discord_post(thread_url, bot_token, {"name": thread_name, "type": 11})
    if thread_resp is None:
        print("Discord thread creation failed; posting summary as channel messages", file=sys.stderr, flush=True)
        # Fall back: post summary as regular messages in the channel (split if needed)
        messages_url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
        return _post_long_message(messages_url, bot_token, summary)

    thread_channel_id = str(thread_resp.get("id", ""))
    if not thread_channel_id:
        print("Discord thread creation returned no channel id", file=sys.stderr, flush=True)
        return False
    print(f"Discord: thread created, thread_channel_id={thread_channel_id}", flush=True)

    # Step 2: Post the headline and full summary in the thread (split if > 2000 chars)
    thread_messages_url = f"{DISCORD_API_BASE}/channels/{thread_channel_id}/messages"
    full_content = f"{headline}\n\n{summary}"
    print(f"Discord: posting summary ({len(full_content)} chars) to thread {thread_channel_id}", flush=True)
    success = _post_long_message(thread_messages_url, bot_token, full_content)
    if success:
        print("Discord: summary posted successfully", flush=True)
    return success


# --- Main ---

def main() -> int:
    now = datetime.now(UTC)
    yesterday_str, today_str = compute_lookback_dates(now)
    window_start = (now - timedelta(days=1)).replace(hour=17, minute=0, second=0, microsecond=0)
    window_end = now.replace(hour=6, minute=0, second=0, microsecond=0)

    print(f"Summarize analysis started at {now.strftime('%Y-%m-%d %H:%M:%S')} UTC", flush=True)
    print(f"Lookback window: {window_start.strftime('%Y-%m-%d %H:%M')} to {window_end.strftime('%Y-%m-%d %H:%M')} UTC", flush=True)
    print(f"GCS date prefixes: {yesterday_str}, {today_str}", flush=True)

    bucket = require_env("BENCHMARK_GCS_BUCKET")
    print(f"GCS bucket: {bucket}", flush=True)

    # Step 1: List metadata.json from GCS across both dates
    all_metadata_uris: list[str] = []
    for date_str in (yesterday_str, today_str):
        pattern = f"gs://{bucket}/runs/benchmark=*/coding_agent=*/model_provider=*/model=*/configuration=*/date={date_str}/run=*/metadata.json"
        print(f"Listing GCS for date={date_str}", flush=True)
        try:
            output = run(["gcloud", "storage", "ls", pattern])
        except subprocess.CalledProcessError as exc:
            print(f"GCS listing failed for date={date_str}: {exc.stderr}", file=sys.stderr, flush=True)
            continue
        uris = output.splitlines() if output else []
        print(f"  Found {len(uris)} metadata.json files for date={date_str}", flush=True)
        all_metadata_uris.extend(uris)

    if not all_metadata_uris:
        print("No metadata.json files found in GCS for the lookback window.", file=sys.stderr, flush=True)
        return 1

    print(f"Total metadata.json files found: {len(all_metadata_uris)}", flush=True)

    # Step 2: Download and filter each metadata.json
    work_dir = Path(getenv("CI_PROJECT_DIR", os.getcwd())) / ".benchmark-summary"
    work_dir.mkdir(mode=0o700, exist_ok=True)
    print(f"Working directory: {work_dir}", flush=True)

    qualifying_runs: list[dict[str, Any]] = []
    for idx, uri in enumerate(all_metadata_uris):
        local_path = work_dir / f"metadata-{idx}.json"
        print(f"[{idx + 1}/{len(all_metadata_uris)}] Downloading metadata: {uri}", flush=True)
        try:
            run(["gcloud", "storage", "cp", uri, str(local_path), "--quiet"])
        except subprocess.CalledProcessError as exc:
            print(f"  Failed to download: {exc.stderr}", file=sys.stderr, flush=True)
            continue

        try:
            metadata = json.loads(local_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  Failed to parse JSON: {exc}", file=sys.stderr, flush=True)
            continue

        # Log what we found
        created_at = metadata.get("created_at", "unknown")
        ferment = metadata.get("ferment", False)
        gitlab = metadata.get("gitlab", {})
        target_ref = gitlab.get("target_ref", "unknown") if isinstance(gitlab, dict) else "unknown"
        run_meta = metadata.get("run_metadata", {})
        tasks_all = run_meta.get("tasks_all") if isinstance(run_meta, dict) else None
        n_tasks = len(run_meta.get("selected_tasks", [])) if isinstance(run_meta, dict) else 0
        print(f"  created_at={created_at}, ferment={ferment}, target_ref={target_ref}, tasks_all={tasks_all}, n_tasks={n_tasks}", flush=True)

        if not filter_metadata(metadata, now):
            print("  SKIP — does not match filter criteria", flush=True)
            continue

        print("  PASS — qualifies for summarization", flush=True)

        # Check if analysis.html exists for this run
        prefix = metadata.get("gcs", {}).get("prefix", "")
        if not prefix:
            # Try to derive prefix from the metadata.json URI
            # URI format: gs://{bucket}/{prefix}/metadata.json
            if uri.startswith(f"gs://{bucket}/"):
                prefix = uri[len(f"gs://{bucket}/") :].rsplit("/", 1)[0]
                print(f"  Derived GCS prefix from URI: {prefix}", flush=True)

        analysis_uri = f"gs://{bucket}/{prefix}/analysis.html"
        analysis_local_path = work_dir / f"analysis-{idx}.html"
        print(f"  Checking for analysis.html: {analysis_uri}", flush=True)
        try:
            run(["gcloud", "storage", "cp", analysis_uri, str(analysis_local_path), "--quiet"])
            print(f"  Downloaded analysis.html ({analysis_local_path.stat().st_size} bytes)", flush=True)
        except subprocess.CalledProcessError:
            print("  No analysis.html found — run may still be in progress", file=sys.stderr, flush=True)
            continue

        metadata["_analysis_local_path"] = str(analysis_local_path)
        metadata["_gcs_prefix"] = prefix
        qualifying_runs.append(metadata)

    if not qualifying_runs:
        print("No qualifying runs found after filtering.", flush=True)
        return 0

    print(f"Qualifying runs: {len(qualifying_runs)}", flush=True)

    # Step 4: Split into groups
    ferment_runs, non_ferment_runs = split_by_ferment(qualifying_runs)

    print(f"Ferment group: {len(ferment_runs)} runs", flush=True)
    print(f"Non-ferment group: {len(non_ferment_runs)} runs", flush=True)

    # Step 5-6: Summarize each group with Opus and post to Discord
    api_key = getenv("KIMCHI_API_KEY")
    bot_token = getenv("DISCORD_BOT_TOKEN")
    channel_id = getenv("DISCORD_CHANNEL_ID")

    if not api_key:
        print("KIMCHI_API_KEY is not set; cannot call Opus", file=sys.stderr, flush=True)
        return 1

    discord_configured = bool(bot_token and channel_id)
    if not discord_configured:
        missing = []
        if not bot_token:
            missing.append("DISCORD_BOT_TOKEN")
        if not channel_id:
            missing.append("DISCORD_CHANNEL_ID")
        print(f"{' and '.join(missing)} not set; summaries will be printed but not posted to Discord", file=sys.stderr, flush=True)
    else:
        print(f"Discord configured: channel_id={channel_id}", flush=True)

    date_str = yesterday_str

    for group_name, group_runs in [("ferment", ferment_runs), ("non-ferment", non_ferment_runs)]:
        if not group_runs:
            print(f"No runs in {group_name} group; skipping", flush=True)
            continue

        # Extract text from analysis HTML and concatenate
        analyses: list[str] = []
        for run_meta in group_runs:
            analysis_path = Path(run_meta.get("_analysis_local_path", ""))
            try:
                html_content = analysis_path.read_text(encoding="utf-8")
                text = extract_text(html_content)
                if text.strip():
                    analyses.append(text.strip())
            except OSError as exc:
                print(f"Failed to read analysis for run: {exc}", file=sys.stderr, flush=True)

        if not analyses:
            print(f"No analysis content found for {group_name} group", file=sys.stderr, flush=True)
            continue

        combined = "\n\n".join(analyses)
        print(f"Calling Opus for {group_name} group ({len(group_runs)} runs, {len(combined)} chars total)", flush=True)
        summary = call_opus(combined, api_key)
        if summary is None:
            print(f"Opus summarization failed for {group_name} group after {MAX_RETRIES} retries", file=sys.stderr, flush=True)
            # Post error notification if Discord is configured
            if discord_configured:
                error_headline = f"⚠️ Opus summarization failed for {group_name} group — {date_str}"
                post_to_discord(bot_token, channel_id, error_headline, f"{group_name} runs — {date_str}", "Summarization failed after 3 retries.")
            return 1

        print(f"Opus returned summary ({len(summary)} chars)", flush=True)

        # Always print the summary to stdout
        print(f"\n{'=' * 80}", flush=True)
        print(f"{group_name.upper()} BENCHMARK SUMMARY — {date_str}", flush=True)
        print(f"{'=' * 80}", flush=True)
        print(summary, flush=True)
        print(f"{'=' * 80}\n", flush=True)

        # Post to Discord if configured
        if discord_configured:
            emoji = "🧪" if group_name == "ferment" else "🔬"
            headline = f"{emoji} {group_name.capitalize()} benchmark summary — {date_str}"
            thread_name = f"{group_name.capitalize()} runs — {date_str}"

            print(f"Posting {group_name} summary to Discord ({len(summary)} chars)", flush=True)
            if not post_to_discord(bot_token, channel_id, headline, thread_name, summary):
                print(f"Failed to post {group_name} summary to Discord", file=sys.stderr, flush=True)
        else:
            print(f"Discord not configured; skipping Discord post for {group_name} group", flush=True)

    print("Done.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
