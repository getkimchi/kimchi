#!/usr/bin/env python3
"""Deterministic fake LLM/platform server for kimchi perf gates.

Chat behaviour (keyed on the latest user message):
  - contains "BIGTOOLS turn=<t> reads=<r>": first reply = r read calls on distinct
    big<k>.txt files; after tool results reply text marker. Tool results seen in
    requests are counted (min size = hydration check for #1405's store).
  - contains "TOOLS": first reply = tool calls (bash + read); after tool results reply text marker.
  - otherwise: stream LONG_CHUNKS text chunks then a marker "BENCH_DONE_<n>".
Every request is counted per route (to spot background polling).

Platform behaviour, keyed on State.upload_failure / State.accept_uploads:
  - "forbidden" (default): the API key verifies as the account the aged queue
    was recorded under, but every upload is refused with HTTP 403 — a user
    whose key lacks the upload permission. The client backs off 4xx for
    hours, so the queue sits full and idle work is the aged-install steady
    state (the regime the gate measures).
  - "verify-empty" (reference only; no lane runs it): the legacy stuck
    regime — the key check returns an empty account the client rejects, so
    the worker fails before any upload is attempted.
  - accept_uploads ("healthy"): uploads acknowledged the way a working
    server does — snapshots echo their revision, event batches get one
    accepted receipt per event — so the queue drains and idle settles.
"""
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fixtures  # noqa: E402

LONG_CHUNKS = 300
# Thinking-turn fixture (thinking-stall lane): a long thinking block streamed as
# small reasoning deltas, then a short answer. Any delta field of
# reasoning_content/reasoning/reasoning_text maps to pi's thinking_delta events;
# thinking_text is kept as plain content so the screen shows something grepable.
THINK_CHUNKS = 400
THINK_PIECE_CHARS = 900
THINK_GAP_S = 0.04
BASH_CMD = ("echo x >> mod0.ts && git add -A && git commit -qm bench && git status --short && "
            "git log --oneline -3 && git diff --stat HEAD~1 && echo BENCH_BASH_OK; echo EXIT=$?")


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.routes = {}
        self.chat_count = 0
        self.tool_results = []  # bash tool outputs seen in follow-up requests
        self.accept_uploads = False
        # "forbidden": key verifies, uploads refused with 403 (default)
        # "verify-empty": legacy regime, key check fails before any upload
        self.upload_failure = "forbidden"
        self.uploads_accepted = 0
        self.reset_tool_stats()

    def reset_tool_stats(self):
        """BIGTOOLS lane: distinct read results the model received, the smallest
        one in any request, and the largest request body."""
        self.big_ids = set()
        self.big_min_chars = None
        self.max_request_bytes = 0

    def tool_stats(self):
        with self.lock:
            return {"tool_results_seen": len(self.big_ids), "min_tool_result_chars": self.big_min_chars,
                    "max_request_bytes": self.max_request_bytes}

    def record(self, method, path):
        key = f"{method} {path.split('?')[0]}"
        with self.lock:
            self.routes[key] = self.routes.get(key, 0) + 1

    def snapshot(self):
        with self.lock:
            return dict(self.routes), None


MODELS = [{
    "slug": "basic", "display_name": "Fake Basic", "provider": "openai", "reasoning": False,
    "input_modalities": ["text"], "is_serverless": True,
    "limits": {"context_window": 128000, "max_output_tokens": 4096},
}]


def _content_text(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in c)
    return ""


MAX_BODY_BYTES = 64 * 1024 * 1024


def make_handler(state: State):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None
            if not 0 <= n <= MAX_BODY_BYTES:
                return None
            raw = self.rfile.read(n) if n else b""
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                raw = b""
                while True:
                    line = self.rfile.readline(65536)
                    try:
                        size = int(line.strip() or b"0", 16)
                    except ValueError:
                        return None
                    if size == 0:
                        self.rfile.readline()
                        break
                    if size > MAX_BODY_BYTES - len(raw):
                        return None
                    raw += self.rfile.read(size)
                    self.rfile.readline()
            self.body_bytes = len(raw)
            try:
                return json.loads(raw) if raw else None
            except Exception:
                return None

        def _json(self, status, obj):
            data = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            state.record("GET", self.path)
            if self.path.startswith("/v1/models/metadata"):
                return self._json(200, {"models": MODELS})
            if self.path.startswith("/v1/credits"):
                return self._json(200, {"serverless": False})
            if self.path.startswith("/openai/v1/models") or self.path.startswith("/v1/models"):
                return self._json(200, {"object": "list", "data": [{"id": "basic", "object": "model"}]})
            return self._json(404, {"error": "unhandled"})

        def do_POST(self):
            body = self._body()
            state.record("POST", self.path)
            if self.path.startswith("/openai/v1/chat/completions") or self.path.startswith("/v1/chat/completions"):
                try:
                    return self._chat(body or {})
                except (BrokenPipeError, ConnectionResetError, ConnectionError):
                    return  # client vanished mid-stream; nothing to answer
            if "api-keys:verify" in self.path and (state.accept_uploads or state.upload_failure == "forbidden"):
                # The key belongs to the account the aged queue was recorded
                # under, so the worker proceeds to upload. In healthy mode the
                # server acknowledges (below); in "forbidden" mode it is
                # refused with 403 — a valid key without upload permission.
                # "verify-empty" keeps the legacy behaviour: the empty answer
                # fails the account check before any upload is attempted.
                return self._json(200, {"organizationId": fixtures.HEALTHY_ACCOUNT["organizationId"],
                                        "userId": fixtures.HEALTHY_ACCOUNT["userId"]})
            if "/pr-cost-snapshots" in self.path:
                if state.accept_uploads and isinstance(body, dict) and body.get("revision"):
                    with state.lock:
                        state.uploads_accepted += 1
                    return self._json(200, {"status": "accepted", "revision": str(body["revision"]),
                                            "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                if state.upload_failure == "forbidden":
                    # No upload permission: a permanent client-side failure —
                    # the queue stays full and the worker backs off for hours.
                    return self._json(403, {"error": {"code": "PERMISSION_DENIED"}})
                # "verify-empty" reference regime: the server-side body limit
                # real deployments enforce; keeps the reporting queue in its
                # retry regime so per-pass cost is measured.
                return self._json(413, {"error": {"code": "PR_COST_LIMIT", "scope": "snapshot",
                                                 "limit": "bytes", "maximum": 10485760}})
            if "pr-cost-events:batchIngest" in self.path:
                if state.upload_failure == "forbidden" and not state.accept_uploads:
                    return self._json(403, {"error": {"code": "PERMISSION_DENIED"}})
                if state.accept_uploads and isinstance(body, dict):
                    events = body.get("events") if isinstance(body.get("events"), list) else []
                    with state.lock:
                        state.uploads_accepted += 1
                    return self._json(200, {"batchId": body.get("id"),
                                            "receiveTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                            "receipts": [{"id": e.get("id"), "status": "accepted", "revision": e.get("revision")}
                                                         for e in events if isinstance(e, dict)]})
            return self._json(200, {})

        def _sse(self, obj):
            data = f"data: {json.dumps(obj)}\n\n".encode()
            try:
                self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            except (BrokenPipeError, ConnectionResetError):
                raise ConnectionError("client vanished mid-stream")

        def _chat(self, body):
            with state.lock:
                state.chat_count += 1
                n = state.chat_count
            msgs = body.get("messages") or []
            first = msgs[0] if msgs else {}
            first_text = _content_text(first.get("content"))
            last = msgs[-1] if msgs else {}
            last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), {})
            user_text = _content_text(last_user.get("content"))
            model = body.get("model", "basic")
            big = [m for m in msgs if m.get("role") == "tool" and str(m.get("tool_call_id", "")).startswith("big_")]
            if big:
                sizes = [len(_content_text(m.get("content"))) for m in big]
                with state.lock:
                    state.big_ids.update(m.get("tool_call_id") for m in big)
                    lo = min(sizes)
                    state.big_min_chars = lo if state.big_min_chars is None else min(state.big_min_chars, lo)
                    state.max_request_bytes = max(state.max_request_bytes, getattr(self, "body_bytes", 0))
            if last.get("role") == "tool" or any(m.get("role") == "tool" for m in msgs[-3:]):
                for m in msgs[-3:]:
                    if m.get("role") == "tool" and m.get("tool_call_id") == "call_b1":
                        with state.lock:
                            state.tool_results.append(_content_text(m.get("content"))[-600:])
            if body.get("stream") is False:
                text = '{"decision":"unknown"}' if first_text.startswith(("Decide whether", "Compare a new", "Read a new")) else "Bench title"
                return self._json(200, {"id": "x", "object": "chat.completion", "created": int(time.time()), "model": model,
                                        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                        "usage": {"prompt_tokens": 10, "completion_tokens": 5}})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def chunk(delta, finish=None, usage=None):
                o = {"id": "x", "object": "chat.completion.chunk", "created": int(time.time()), "model": model,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage:
                    o["usage"] = usage
                self._sse(o)

            chunk({"role": "assistant"})
            if first_text.startswith(("Decide whether", "Compare a new", "Read a new")):
                chunk({"content": '{"decision":"unknown"}'})
                chunk({}, "stop")
            elif "BIGTOOLS" in user_text and last.get("role") == "user":
                # Must precede the TOOLS branch ("BIGTOOLS" contains "TOOLS").
                mt = re.search(r"turn=(\d+)", user_text)
                mr = re.search(r"reads=(\d+)", user_text)
                turn, reads = int(mt.group(1)) if mt else 0, int(mr.group(1)) if mr else 1
                for j in range(reads):
                    k = turn * reads + j
                    chunk({"tool_calls": [{"index": j, "id": f"big_{k}", "type": "function",
                                           "function": {"name": "read", "arguments": json.dumps({"path": f"big{k}.txt"})}}]})
                chunk({}, "tool_calls", {"prompt_tokens": 2000, "completion_tokens": 50})
            elif "TOOLS" in user_text and last.get("role") == "user":
                calls = [
                    ("call_b1", "bash", {"command": BASH_CMD}),
                    ("call_r1", "read", {"path": "big.txt"}),
                ]
                for i, (cid, name, args) in enumerate(calls):
                    chunk({"tool_calls": [{"index": i, "id": cid, "type": "function",
                                           "function": {"name": name, "arguments": json.dumps(args)}}]})
                chunk({}, "tool_calls", {"prompt_tokens": 2000, "completion_tokens": 50})
            elif "THINK" in user_text and last.get("role") == "user":
                # Step-shaped thinking: the derivation/posting cost in the #1645
                # class grows with the NUMBER of steps (newline-separated
                # thoughts), not raw bytes, so the piece carries many short
                # lines instead of one long one.
                line = "thinking-" + _content_text(last.get("content"))[:20] + " lorem ipsum dolor\n"
                piece = (line * (THINK_PIECE_CHARS // len(line) + 1))[:THINK_PIECE_CHARS]
                for _ in range(THINK_CHUNKS):
                    chunk({"reasoning_content": piece})
                    time.sleep(THINK_GAP_S)
                m = re.search(r"TOK(\w+)", user_text)
                chunk({"content": f"\n\nBENCH_DONE_{m.group(1) if m else n}"})
                chunk({}, "stop", {"prompt_tokens": 2000, "completion_tokens": 400})
            else:
                for i in range(LONG_CHUNKS):
                    chunk({"content": f"word{i} " + ("\n" if i % 12 == 11 else "")})
                    if i % 10 == 0:
                        time.sleep(0.005)
                # older builds append reminder/nudge user messages after tool results:
                # take the token from the most recent user message that carries one
                m = None
                for um in reversed(msgs):
                    if um.get("role") == "user":
                        m = re.search(r"TOK(\w+)", _content_text(um.get("content")))
                        if m:
                            break
                chunk({"content": f"\n\nBENCH_DONE_{m.group(1) if m else n}"})
                chunk({}, "stop", {"prompt_tokens": 2000, "completion_tokens": 400})
            try:
                data = b"data: [DONE]\n\n"
                self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    return H


def start():
    state = State()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    srv.daemon_threads = True
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, state, f"http://127.0.0.1:{srv.server_address[1]}"
