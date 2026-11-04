#!/usr/bin/env python3
"""Deterministic synthetic fixtures for the kimchi perf gate.

Three generators, all seeded and reproducible:
  - write_big_session(): a large multi-compaction session JSONL for the resume gate.
  - make_repo(): a small git repository with real commits and reflog.
  - aged_home(): a kimchi HOME whose accumulated data (ledger, bookkeeping,
    reporting queue) matches the *shape* of a long-lived real install at a
    reduced, CI-sized scale.

No real user data is copied; the shapes are transcriptions of the product's
validators and must stay in lockstep with them (see README "Fixtures"):
  - src/extensions/pr-cost-reporting/ledger/schema.ts (LEDGER_SCHEMA, SCHEMA_VERSION)
  - src/extensions/pr-cost-reporting/queue.ts (ReportingState, validateEntry, FrozenSnapshot)
  - src/extensions/pr-cost-reporting/snapshot.ts (WireSnapshot/validateSnapshot)
  - src/extensions/work-attribution/summary.ts (record() journal validation)
  - src/extensions/work-attribution/file-transitions.ts (isTransition)
The `--selfcheck` mode of scenarios.py asserts the engagement of the parts
that drift silently (state.json loads, frozen notes scan, journals import).
"""
import contextlib
import time
import datetime
import hashlib
import json
import os
import sqlite3
import subprocess
import uuid

NS = uuid.UUID("b3a1c0de-0000-4000-8000-000000000000")
BASE_MS = 1770000000000  # fixed epoch: deterministic timestamps

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal_cursor (
	path TEXT PRIMARY KEY, dev INTEGER NOT NULL, ino INTEGER NOT NULL,
	generation INTEGER NOT NULL, offset INTEGER NOT NULL, boundary_hash TEXT NOT NULL,
	updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_records (
	record_hash TEXT PRIMARY KEY, type TEXT NOT NULL, work_id TEXT NOT NULL,
	session_id TEXT NOT NULL, body TEXT NOT NULL, source_path TEXT NOT NULL,
	source_generation INTEGER NOT NULL, source_offset INTEGER, imported_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS work_records_work ON work_records(work_id);
CREATE INDEX IF NOT EXISTS work_records_session ON work_records(session_id);
CREATE INDEX IF NOT EXISTS work_records_type ON work_records(type);
CREATE TABLE IF NOT EXISTS pending_translation (
	record_hash TEXT PRIMARY KEY, work_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_projection_head (
	work_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS work_projection_rows (
	work_id TEXT NOT NULL, log TEXT NOT NULL, key TEXT NOT NULL, pos INTEGER NOT NULL, body TEXT NOT NULL,
	PRIMARY KEY (work_id, log, key));
CREATE TABLE IF NOT EXISTS outbox_events (
	id TEXT PRIMARY KEY, account_key TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL,
	body BLOB NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER,
	blocked TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox_events(account_key, acked_at, created_at);
CREATE INDEX IF NOT EXISTS outbox_entity ON outbox_events(entity_id);
CREATE TABLE IF NOT EXISTS outbox_batches (
	id TEXT PRIMARY KEY, account_key TEXT NOT NULL, body BLOB NOT NULL, event_ids BLOB NOT NULL,
	created_at INTEGER NOT NULL, order_key TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS delivery_state (
	account_key TEXT PRIMARY KEY, retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL,
	last_error TEXT, batch_bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostics (code TEXT PRIMARY KEY, count INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookkeeping (
	work_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL,
	PRIMARY KEY (work_id, name));
CREATE TABLE IF NOT EXISTS work_dirty (work_id TEXT PRIMARY KEY);
"""
# Mirrors SCHEMA_VERSION in src/extensions/pr-cost-reporting/ledger/schema.ts;
# a mismatch makes the store refuse to open, so keep them in lockstep.
SCHEMA_VERSION = 1


def _work_id(i):
    return str(uuid.uuid5(NS, f"work-{i}"))


def _session_id(i):
    return str(uuid.uuid5(NS, f"session-{i}"))


def _sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def _iso(ms):
    dt = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def js(obj):
    """JSON.stringify-compatible serialization: no spaces, non-ASCII kept verbatim.

    queue.ts composes state keys and frozen ids from JSON.stringify output and
    compares them byte-for-byte, so every embedded blob must round-trip the
    same way JavaScript would write it.
    """
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------- clean HOME
def seed_clean_home(home, base_url):
    """A minimal, migration-complete kimchi HOME against the fake provider."""
    cfg_dir = os.path.join(home, ".config", "kimchi")
    agent = os.path.join(cfg_dir, "harness")
    os.makedirs(agent, exist_ok=True)
    with open(os.path.join(home, ".gitconfig"), "w") as g:
        g.write("[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n")
    cfg = {"apiKey": "fake", "llmEndpoint": base_url, "skillPaths": [], "migrationState": "done",
           "onboarding": {"hideSessionModeDialog": True}, "telemetry": {"enabled": True},
           "telemetry_notice_shown": True}
    json.dump(cfg, open(os.path.join(cfg_dir, "config.json"), "w"), indent=1)
    # hideThinkingBlock: false = the expanded thinking view, whose renderer is
    # the expensive path in the streaming-stall class (#1645): it rebuilds the
    # full thinking component per delta. The hidden view renders a cheap tail
    # preview and would never trip the gap detector.
    json.dump({"extensions": ["-builtin:mcp"], "quietStartup": False, "hideThinkingBlock": False},
              open(os.path.join(agent, "settings.json"), "w"), indent=1)
    models = {"providers": {"fake": {
        "baseUrl": f"{base_url}/openai/v1", "apiKey": "fake", "api": "openai-completions", "authHeader": True,
        "models": [{"id": "basic", "name": "Fake Basic", "reasoning": True, "input": ["text"],
                    "contextWindow": 128000, "maxTokens": 4096,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}
    json.dump(models, open(os.path.join(agent, "models.json"), "w"), indent=1)


# ---------------------------------------------------------------- session
def write_big_session(path, cwd, target_bytes=31 * 1024 * 1024, compact_every=40):
    """A v3 session JSONL: many user/assistant/tool turns and regular compactions.

    Mirrors the recorded shape of real long sessions: session header, one
    model_change, then turn groups of (user, assistant-with-tool-use, tool
    result, assistant text), with a compaction line every `compact_every`
    turns. Pre-compaction history stays in the file, so resume renders it
    all — the exact path that regressed 3-9x once.
    """
    state = {"prev": None, "count": 0}
    written = 0
    session_id = _session_id(0)

    def emit(f, obj):
        obj["id"] = f"{state['count']:08x}"
        state["count"] += 1
        obj["parentId"] = state["prev"]
        obj["timestamp"] = _iso(BASE_MS + state["count"] * 100)
        state["prev"] = obj["id"]
        line = json.dumps(obj) + "\n"
        f.write(line)
        return len(line)

    def words(n, seed):
        return " ".join(f"{seed}{j}" for j in range(n))

    with open(path, "w") as f:
        written += emit(f, {"type": "session", "version": 3, "id": session_id, "cwd": cwd})
        written += emit(f, {"type": "model_change", "provider": "fake", "modelId": "basic"})
        written += emit(f, {"type": "thinking_level_change", "thinkingLevel": "low"})
        turn = 0
        while written < target_bytes:
            tok = f"{turn:06d}"
            written += emit(f, {"type": "message", "message": {
                "role": "user",
                "content": [{"type": "text", "text": f"please do task {turn} TOK{tok} now"}],
                "timestamp": BASE_MS + turn * 1000}})
            written += emit(f, {"type": "message", "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": words(260, f"think{turn}-"),
                     "thinkingSignature": "CAQS" + _sha(f"sig{turn}")[:60]},
                    {"type": "text", "text": words(220, f"answer{turn}-")},
                    {"type": "tool_use", "id": f"toolu_{turn:06d}", "name": "bash",
                     "input": {"command": f"echo task {turn} && ls -la"}},
                ],
                "api": "openai-completions", "provider": "fake", "model": "basic",
                "usage": {"input": 4000, "output": 300, "cacheRead": 1000, "cacheWrite": 2000,
                          "totalTokens": 7300, "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                                        "cacheWrite": 0, "total": 0}},
                "stopReason": "toolUse", "timestamp": BASE_MS + turn * 1000 + 50}})
            written += emit(f, {"type": "message", "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": f"toolu_{turn:06d}",
                             "content": words(180, f"output{turn}-")}],
                "timestamp": BASE_MS + turn * 1000 + 100}})
            written += emit(f, {"type": "message", "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": words(200, f"think2-{turn}-"),
                     "thinkingSignature": "CAQS" + _sha(f"sig2{turn}")[:60]},
                    {"type": "text", "text": words(300, f"final{turn}-") + f"\n\nBENCH_DONE_{tok}"},
                ],
                "api": "openai-completions", "provider": "fake", "model": "basic",
                "usage": {"input": 9000, "output": 400, "cacheRead": 3000, "cacheWrite": 6000,
                          "totalTokens": 18400, "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                                        "cacheWrite": 0, "total": 0}},
                "stopReason": "stop", "timestamp": BASE_MS + turn * 1000 + 150}})
            turn += 1
            if turn % compact_every == 0:
                written += emit(f, {"type": "compaction",
                                    "summary": "## Goal\n" + words(700, f"compact{turn}-"),
                                    "firstKeptEntryId": state["prev"], "tokensBefore": 240000 + turn * 25,
                                    "details": {"readFiles": [f"{cwd}/src/mod{j}.ts" for j in range(12)],
                                                "modifiedFiles": [f"{cwd}/src/mod{j}.ts" for j in range(6)]},
                                    "usage": {"input": 130000, "output": 2000, "cacheRead": 100, "cacheWrite": 0,
                                              "reasoning": 10, "totalTokens": 132000,
                                              "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                                       "cacheWrite": 0, "total": 0}}})
    return turn


# ---------------------------------------------------------------- git repos
def make_repo(path, name, commits=6, git="git"):
    """A real git repository: tracked files, history, reflog. Byte-deterministic."""
    os.makedirs(path, exist_ok=True)
    home = path + "-home"
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
           "GIT_CONFIG_NOSYSTEM": "1", "HOME": home}
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, ".gitconfig"), "w") as g:
        g.write("[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n")
    for c in (["init", "-q"], ["add", "."]):
        subprocess.run([git] + c, cwd=path, env=env, check=True, capture_output=True)
    for i in range(commits):
        # Pin author/committer timestamps: otherwise the objects embed wall
        # clock time and the fixture stops being byte-identical across runs.
        stamp = f"@{BASE_MS // 1000 + i} +0000"
        cenv = dict(env, GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
        for j in range(3):
            with open(os.path.join(path, f"mod{j}.ts"), "a") as f:
                f.write(f"export const v{i}_{j} = {i * 10 + j}\n")
        subprocess.run([git, "add", "."], cwd=path, env=env, check=True, capture_output=True)
        subprocess.run([git, "-c", "user.email=b@b", "-c", "user.name=b", "commit", "-qm", f"bench {name} {i}"],
                       cwd=path, env=cenv, check=True, capture_output=True)
    return path


# ---------------------------------------------------------------- aged HOME
def _wire_snapshot(repo_i, producer_id, pulls=40, windowed_ids=800, requests=4000):
    """A WireSnapshot that passes validateSnapshot byte-for-byte.

    Every field follows the product's validators: numeric provider ids,
    isWorkId billing ids, merged/closed time rules, allocation kinds with
    their required pullRequestIds counts, windowed cap 2000, and the 8MB
    overall bound.
    """
    repo = {"provider": "github", "host": "github.com", "id": str(4000 + repo_i), "name": f"repo{repo_i}"}
    prs = []
    for n in range(pulls):
        merged = n % 2 == 0
        pr = {"id": str(50000 + repo_i * 100 + n), "number": 100 + n,
              "url": f"https://github.com/bench/repo{repo_i}/pull/{100 + n}",
              "state": "merged" if merged else "closed",
              "title": " ".join(f"title{repo_i}-{n}-{w}" for w in range(12))}
        # Optional keys must be absent (not null): the validators check !== undefined.
        if merged:
            pr["mergedAt"] = _iso(BASE_MS + n * 60000)
        else:
            pr["closedAt"] = _iso(BASE_MS + n * 60000)
        prs.append(pr)
    pull_ids = [pr["id"] for pr in prs]
    reqs = []
    for n in range(requests):
        kind, ids = (("pull-request", [pull_ids[n % pulls]]) if n % 3 == 0 else
                     ("shared", [pull_ids[n % pulls], pull_ids[(n + 1) % pulls]]) if n % 3 == 1 else
                     ("unlinked", []))
        reqs.append({"requestId": str(uuid.uuid5(NS, f"req-{repo_i}-{n}")),
                    "billingRecordIds": [str(uuid.uuid5(NS, f"bill-{repo_i}-{n}-{k}")) for k in range(4)],
                    "startedAt": _iso(BASE_MS + n * 30000),
                    "allocation": {"kind": kind, "pullRequestIds": ids,
                                   "method": "native" if n % 2 else "session"}})
    return {"repository": repo,
            "windowedPullRequestIds": [str(60000 + repo_i * 100 + n) for n in range(windowed_ids)],
            "pullRequests": prs, "requests": reqs,
            "coverage": {"observedRequests": requests, "unpricedRequests": requests // 10,
                         "historyComplete": True, "lastCostRefreshAt": _iso(BASE_MS)},
            "schemaVersion": 1, "producerId": producer_id,
            "revision": "17", "generatedAt": _iso(BASE_MS)}


def _transition_body(repo_path, i):
    return {
        "version": 1,
        "type": "file_transition",
        "workId": _work_id(i),
        "sessionId": _session_id(i % 12),
        "transitionId": f"tr-{i}", "toolCallId": f"call_{i}", "requestId": f"req_{i}",
        "cwd": repo_path, "repository": repo_path, "worktree": repo_path,
        "path": f"src/mod{i % 3}.ts",
        "before": {"blob": _sha(f"before{i}"), "mode": "100644"},
        "after": {"blob": _sha(f"after{i}"), "mode": "100644"},
        "baseline": None,
        "baselineFile": {"blob": _sha(f"base{i}"), "mode": "100644"},
        "cursor": {"bytes": 1024 * (i + 1), "digest": _sha(f"digest{i}")},
        "branch": "main", "recordedAt": _iso(BASE_MS + i * 1000),
    }


def _commit_body(repo_path, i):
    return {
        "version": 1,
        "type": "commit",
        "workId": _work_id(i % 40), "sessionId": _session_id(i % 12),
        "sha": _sha(f"commit{i}"), "repository": repo_path, "worktree": repo_path,
        "message": f"bench commit {i} " + " ".join(f"w{j}" for j in range(24)),
        "toolCallId": f"call_{i}", "requestId": f"req_{i}",
        "recordedAt": _iso(BASE_MS + i * 1000),
    }


def _request_body(repo_path, i):
    return {
        "version": 1,
        "type": "request",
        "workId": _work_id(i % 40), "sessionId": _session_id(i % 12),
        "requestId": str(uuid.uuid5(NS, f"req-{i}")), "repository": repo_path, "worktree": repo_path,
        "startedAt": _iso(BASE_MS + i * 500),
        "summary": " ".join(f"word{j}" for j in range(140)),
    }


def _tool_execution_body(repo_path, i):
    return {
        "version": 1,
        "type": "tool_execution",
        "workId": _work_id(i % 40), "sessionId": _session_id(i % 12),
        "requestId": str(uuid.uuid5(NS, f"req-{i}")), "toolCallId": f"call_{i}",
        "repository": repo_path, "worktree": repo_path,
        "toolName": "bash", "outcome": "succeeded",
        "command": " ".join(f"cmd{j}" for j in range(40)),
        "recordedAt": _iso(BASE_MS + i * 700),
    }


def _costs_note(repo_i, requests=200):
    """A `costs` bookkeeping note in the recorded real-world shape."""
    body = {"version": 1, "workId": _work_id(repo_i), "pullRequests": [], "requests": []}
    for n in range(requests):
        body["requests"].append({
            "requestId": str(uuid.uuid5(NS, f"creq-{repo_i}-{n}")),
            "account": {"apiUrl": "https://bench.invalid/api", "organizationId": _work_id(repo_i + 100),
                        "userId": _work_id(repo_i + 200)},
            "segment": {"id": str(uuid.uuid5(NS, f"seg-{repo_i}-{n}")), "attribution": "native",
                        "reason": "observed"},
            "workIds": [_work_id(repo_i)], "sessionIds": [_session_id(n % 12)],
            "startedAt": _iso(BASE_MS + n * 1000), "pullRequestIds": [],
            "allocation": "pull-request",
        })
    body["unallocated"] = {
        k: {"requestIds": [str(uuid.uuid5(NS, f"{k}-{repo_i}-{j}")) for j in range(20)],
            "knownCostUsd": "12.345678", "totalCostUsd": "45.678901"}
        for k in ("inferred", "shared", "unlinked", "unmerged")}
    return json.dumps(body)


def aged_home(home, base_url, repos, transitions_per_repo=140, commits_per_repo=40,
              filler_per_repo=900, producer_id=None):
    """Seed a kimchi HOME with an aged, reporting-active install.

    Layout under <home>/.config/kimchi: config.json + harness/settings.json +
    models.json (fake provider), pr-cost-reporting/ledger.db with work records
    (mirrored into legacy journals, as real installs keep both), bookkeeping
    costs notes, frozen snapshot queues under the 'legacy-pr-cost-snapshots'
    work id, and pr-cost-reporting/state.json whose queue entries hold
    pending snapshots the endpoint keeps rejecting (413), so every pass
    re-reads and re-serializes them.
    """
    producer_id = producer_id or str(uuid.uuid5(NS, "producer"))
    seed_clean_home(home, base_url)
    agent = os.path.join(home, ".config", "kimchi", "harness")
    pr_cost = os.path.join(agent, "pr-cost-reporting")
    os.makedirs(pr_cost, exist_ok=True)

    # ---- ledger + legacy journals (real installs keep both; the importer leaves journals behind)
    journals_dir = os.path.join(agent, "work-attribution", "transitions")
    os.makedirs(journals_dir, exist_ok=True)
    db_path = os.path.join(pr_cost, "ledger.db")
    with contextlib.closing(sqlite3.connect(db_path)) as con:
        con.executescript(LEDGER_SCHEMA)
        con.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('projectionVersion', '1')")
        offset = 0
        for ri, repo in enumerate(repos):
            records = ([_transition_body(repo, ri * 100000 + i) for i in range(transitions_per_repo)] +
                       [_commit_body(repo, ri * 100000 + i) for i in range(commits_per_repo)])
            for kind, gen in (("request", _request_body), ("tool_execution", _tool_execution_body)):
                records += [gen(repo, ri * 100000 + i) for i in range(filler_per_repo // 2)]
            with open(os.path.join(journals_dir, f"j{ri}.jsonl"), "w") as j:
                for body in records:
                    j.write(js(body) + "\n")
            for body in records:
                text = js(body)
                con.execute("INSERT INTO work_records VALUES (?,?,?,?,?,?,?,?,?)",
                            (_sha(text), body["type"], body["workId"], body["sessionId"], text,
                             f"{journals_dir}/j{ri}.jsonl", 1, offset, BASE_MS))
                offset += len(text) + 1
        con.commit()

        # ---- bookkeeping: costs notes + frozen snapshot queues (big bodies, re-read every pass)
        account = {"apiUrl": base_url, "organizationId": _work_id(900), "userId": _work_id(901)}
        account_key = js([base_url, _work_id(900), _work_id(901)])
        for ri, repo in enumerate(repos):
            con.execute("INSERT OR REPLACE INTO bookkeeping VALUES (?,?,?,?)",
                        (_work_id(ri), "costs", _costs_note(ri), BASE_MS))
            repository = {"provider": "github", "host": "github.com", "id": str(4000 + ri)}
            snapshot = _wire_snapshot(ri, producer_id)
            wire_body = js(snapshot)
            frozen_id = _sha(f"{account_key}\0{wire_body}")
            entry = {"account": account, "repository": repository,
                     "revision": "17", "requestHashes": [], "attempts": 3, "retryAt": 0}
            # decodeFrozen runs validateEntry on this key: it is the full state-entry
            # key (accountKey:repositoryKey), matching freezeState in queue.ts.
            frozen_key = f"{account_key}:{js(['github', 'github.com', str(4000 + ri)])}"
            frozen = js({"version": 1, "id": frozen_id, "key": frozen_key,
                         "body": wire_body, "entry": entry})
            # Readers scan bookkeeping by work id 'legacy-pr-cost-snapshots'; the note
            # name is the content-addressed frozen id decodeFrozen verifies.
            con.execute("INSERT OR REPLACE INTO bookkeeping VALUES (?,?,?,?)",
                        ("legacy-pr-cost-snapshots", frozen_id, frozen, BASE_MS))
        con.commit()

    # ---- reporting state: pending queue entries that never drain (endpoint 413s)
    entries = {}
    for ri, repo in enumerate(repos):
        account = {"apiUrl": base_url, "organizationId": _work_id(900), "userId": _work_id(901)}
        repository = {"provider": "github", "host": "github.com", "id": str(4000 + ri)}
        # validateEntry: key === accountKey + ":" + repositoryKey, both JSON.stringify-minified
        key = js([base_url, _work_id(900), _work_id(901)]) + ":" + js(["github", "github.com", str(4000 + ri)])
        snap = _wire_snapshot(ri, producer_id, pulls=40, windowed_ids=800, requests=600)
        entries[key] = {"account": account, "repository": repository,
                        "revision": "17", "requestHashes": [], "attempts": 2, "retryAt": 0,
                        "pending": snap, "uploadedAt": BASE_MS - 400000}
    state = {"version": 1, "enabled": True, "followsTelemetry": True, "defaultNoticeShown": True,
             "producerId": producer_id, "entries": entries}
    json.dump(state, open(os.path.join(pr_cost, "state.json"), "w"))
    return db_path


def retire_queue_retries(home, horizon_ms=3_600_000):
    """Move every pending retry deadline past the measurement window: the
    queue stays full and the endpoint keeps refusing, but nothing is due.

    This is the stuck-but-quiet contrast for the idle lane: a gate that
    honours retry deadlines shows background work collapse to ~zero after
    the one change-absorbing pass, while any code that re-runs the cycle on
    its own timer keeps paying full passes forever — regardless of when the
    queue's own bookkeeping last changed.

    The edit is deliberately a FOREIGN write (plain file + sqlite writes,
    and the version sidecar is bumped like any third-party writer would):
    the running binary must notice it exactly once, re-freeze the new
    deadlines, and then sleep — which is precisely the behaviour that
    distinguishes the fixed reconcile from the pre-fix one.
    """
    agent = os.path.join(home, ".config", "kimchi", "harness")
    pr_cost = os.path.join(agent, "pr-cost-reporting")
    retry_at = int(time.time() * 1000) + horizon_ms

    sp = os.path.join(pr_cost, "state.json")
    state = json.load(open(sp))
    for entry in state["entries"].values():
        entry["retryAt"] = retry_at
    json.dump(state, open(sp, "w"))
    # The sidecar reads before state.json in the product's own write path; a
    # foreign writer bumps it after, which can only over-open, never close.
    vp = os.path.join(pr_cost, "state.version")
    cur = 0
    try:
        cur = int(open(vp).read().strip())
    except (OSError, ValueError):
        pass
    open(vp, "w").write(str(cur + 1) + "\n")

    db_path = os.path.join(pr_cost, "ledger.db")
    with contextlib.closing(sqlite3.connect(db_path)) as con:
        rows = con.execute("SELECT work_id, name, body FROM bookkeeping").fetchall()
        for work_id, name, body in rows:
            try:
                obj = json.loads(body)
            except (ValueError, TypeError):
                continue
            entry = obj.get("entry") if isinstance(obj, dict) else None
            if not isinstance(entry, dict) or "retryAt" not in entry:
                continue
            entry["retryAt"] = retry_at
            con.execute("UPDATE bookkeeping SET body = ? WHERE work_id = ? AND name = ?",
                        (json.dumps(obj, separators=(",", ":")), work_id, name))
        con.commit()
