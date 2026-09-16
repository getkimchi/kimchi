"""Describe recorded communication attempts without inferring understanding or causality."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


ACCEPTED = {"queued_for_parent", "queued_before_session", "queued_for_running_session", "resume_attempt_completed"}
MESSAGE_TOOLS = {"send_agent_message", "reply_to_agent_message"}


def text_content(message):
    content = message.get("content", [])
    if isinstance(content, str):
        return content
    return "".join(block.get("text", "") for block in content if block.get("type") == "text")


def analyze(paths):
    """Count all recorded attempts, including abandoned branches. Do not score quality."""
    usage = Counter(input=0, output=0, cacheRead=0, cacheWrite=0)
    calls = {}
    results = set()
    reads = []
    routes = []
    checks = []
    warnings = []
    sessions = []
    identities = {}
    loaded = []
    for path in sorted(set(map(Path, paths))):
        rows = []
        for line_number, line in enumerate(path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path.name}:{line_number}: invalid JSON; capture may be incomplete") from error
            if not isinstance(row, dict):
                raise ValueError(f"{path.name}:{line_number}: expected a JSON object")
            rows.append((line_number, row))
            if row.get("customType") == "subagents:record":
                record = row.get("data", {})
                if record.get("sessionFile") and record.get("id"):
                    identities[Path(record["sessionFile"]).name] = record["id"]
        loaded.append((path, rows))

    for path, rows in loaded:
        headers = [row for _, row in rows if row.get("type") == "session"]
        if len(headers) != 1:
            raise ValueError(f"{path.name}: expected exactly one session header")
        header = headers[0]
        session = header["id"]
        if session in sessions:
            raise ValueError(f"Duplicate capture for session {session}")
        sessions.append(session)
        actor = identities.get(path.name)
        reader_role = "worker" if actor else "parent" if not header.get("parentSession") else "unknown"
        for line_number, row in rows:
            if row.get("type") != "message":
                continue
            message = row["message"]
            role = message.get("role")
            location = {"file": path.name, "line": line_number, "session_id": session}
            if role == "assistant":
                for key in usage:
                    usage[key] += message.get("usage", {}).get(key, 0)
                for block in message.get("content", []):
                    if block.get("type") == "toolCall":
                        calls[(session, block["id"])] = block
                continue
            if role != "toolResult":
                continue
            key = (session, message.get("toolCallId"))
            if key in results:
                warnings.append({**location, "reason": "duplicate tool result", "tool_call_id": key[1]})
                continue
            results.add(key)
            call = calls.get(key)
            tool = message.get("toolName")
            if not call or call["name"] != tool:
                warnings.append({**location, "reason": "result without matching earlier call", "tool_call_id": key[1]})
                continue
            observation = {**location, "tool_call_id": key[1], "timestamp": message.get("timestamp")}
            if tool in {"read", "bash", "edit", "write", "apply_patch"}:
                checks.append({**observation, "tool": tool, "is_error": bool(message.get("isError"))})
            if tool not in MESSAGE_TOOLS | {"read_agent_board"}:
                continue
            try:
                receipt = json.loads(text_content(message))
            except json.JSONDecodeError:
                warnings.append({**observation, "reason": "non-JSON communication result", "tool": tool})
                continue
            if not isinstance(receipt, dict):
                warnings.append({**observation, "reason": "non-object communication result", "tool": tool})
                continue
            if tool == "read_agent_board":
                if message.get("isError") or receipt.get("ok") is not True:
                    continue
                for entry in receipt.get("entries", []):
                    # Summaries and count/latest-ID hints do not contain a body.
                    if not isinstance(entry.get("body"), str) or not entry.get("id"):
                        warnings.append({**observation, "reason": "board result entry lacks body or id"})
                        continue
                    author = entry.get("authorAgentId")
                    reads.append({
                        **observation,
                        "entry_id": entry["id"],
                        "author_id": author,
                        "reader_agent_id": actor,
                        "reader_role": reader_role,
                        "own_entry": actor == author if actor and author else None,
                        "kind": entry.get("kind"),
                        "body_sha256": hashlib.sha256(entry["body"].encode()).hexdigest(),
                    })
            else:
                args = call.get("arguments", {})
                payload = args.get("payload", {})
                routes.append({
                    **observation,
                    "kind": payload.get("kind", "answer" if tool == "reply_to_agent_message" else None),
                    "message_id": receipt.get("messageId"),
                    "reply_to": args.get("message_id") if tool == "reply_to_agent_message" else args.get("reply_to", payload.get("reply_to")),
                    "status": receipt.get("status"),
                    "accepted": not message.get("isError", False) and receipt.get("status") in ACCEPTED,
                })

    successful_replies = {route["reply_to"] for route in routes if route["accepted"] and route["kind"] in {"answer", "decline"}}
    questions = [route for route in routes if route["accepted"] and route["kind"] == "question"]
    return {
        "schema_version": 1,
        "scope": "All recorded attempts, including abandoned branches; tool output is not proof of provider delivery, understanding or causal benefit.",
        "sessions": len(sessions),
        "usage": dict(usage),
        "summary": {
            "recorded_message_calls": sum(call["name"] in MESSAGE_TOOLS for call in calls.values()),
            "parsed_message_receipts": len(routes),
            "board_body_returns": len(reads),
            "unique_reader_entry_pairs": len({(read["session_id"], read["entry_id"]) for read in reads}),
            "known_peer_body_returns": sum(read["own_entry"] is False for read in reads),
            "parent_body_returns": sum(read["reader_role"] == "parent" for read in reads),
            "unclassified_body_returns": sum(read["reader_role"] == "unknown" for read in reads),
            "accepted_questions": len(questions),
            "questions_with_recorded_accepted_reply": sum(bool(q["message_id"]) and q["message_id"] in successful_replies for q in questions),
        },
        "board_reads": reads,
        "message_routes": routes,
        "artifact_actions": checks,
        "warnings": warnings,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_dir", type=Path)
    args = parser.parse_args()
    paths = list(args.session_dir.glob("*.jsonl"))
    if not paths:
        parser.error("no session JSONL files found")
    print(json.dumps(analyze(paths), indent=2))
