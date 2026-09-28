"""Timestamp agreement diagnostic: public evidence and independent component checks."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile


TASK = """# Extend the event bridge

producer.encode(event) converts {id, at_ms, payload} to {id, timestamp, payload}.
consumer.decode(wire) does the inverse. Internal at_ms is an integer, including
negative values. Implement encode_many and decode_many, preserving input order,
IDs, payloads and inputs. Reject bool/non-integer at_ms with ValueError. Reject
bool/non-numeric/non-finite wire timestamps with ValueError. No other validation
is required. Decimal seconds representing whole milliseconds must round-trip.

The existing shared agreement is seconds on the wire. upstream.json is the
authoritative captured endpoint contract and example; operator-note.txt is an
unverified advisory. The host will publish one new evidence revision after the
first producer.py or consumer.py change. It may confirm or invalidate the old
agreement, and an advisory may be wrong. Read evidence after editing and verify
the final revision=2 before declaring completion. No sleeping/polling for it.

Two workers own producer.py and consumer.py respectively. They are not alone;
preserve each other's edits. Both can read every task file. Use your available
channels and ordinary shared notes when another owner's assumption needs to
change; verify claims against evidence. No posting quota. Parent coordinates,
collects results and may repair both components after workers finish. Add tests
as useful and run python3 verify.py. A round trip alone cannot prove the wire
contract: two mutually compatible components can both use the wrong unit.

Do not modify TASK.md, upstream.json, operator-note.txt or verify.py. Do not
install dependencies, access other trials or personal data, commit or publish.
"""

BASELINE = {
    "producer.py": 'def encode(event):\n    return {"id": event["id"], "timestamp": event["at_ms"] / 1000, "payload": event["payload"]}\n',
    "consumer.py": 'def decode(wire):\n    return {"id": wire["id"], "at_ms": round(wire["timestamp"] * 1000), "payload": wire["payload"]}\n',
}
VERIFY = '''import json
from pathlib import Path
from producer import encode, encode_many
from consumer import decode, decode_many
contract = json.loads(Path("upstream.json").read_text())
assert contract["revision"] == 2, "Final upstream evidence has not arrived"
event = {"id": "sample", "at_ms": 1700000000123, "payload": False}
wire = contract["example"]
assert encode(event) == wire, (encode(event), wire)
assert decode(wire) == event, (decode(wire), event)
assert encode_many([event]) == [wire]
assert decode_many([wire]) == [event]
print("Independent endpoint and batch checks passed")
'''


def evidence(case, revision=2):
    unit = "milliseconds" if revision == 2 and case == "changed" else "seconds"
    return dict(revision=revision, unit=unit, example={
        "id": "sample", "timestamp": 1700000000123 if unit == "milliseconds" else 1700000000.123,
        "payload": False,
    })


def seed(path):
    path.mkdir(parents=True)
    for name, content in {**BASELINE, "TASK.md": TASK, "verify.py": VERIFY,
                          "upstream.json": json.dumps(evidence("unchanged", 1)),
                          "operator-note.txt": "Existing agreement: seconds on the wire.\n"}.items():
        (path / name).write_text(content)


def publish(path, case):
    # Each replacement is atomic; upstream revision is the publication marker.
    note = ("An operator believes the endpoint now uses milliseconds. Verify this claim.\n"
            if case in {"changed", "mistaken"} else "No unit change is reported.\n")
    (path / "operator-note.txt").write_text(note)
    pending = path / "upstream.pending"
    pending.write_text(json.dumps(evidence(case)))
    pending.replace(path / "upstream.json")


def grade(path, case):
    modules = {}
    errors = []
    for name in ["producer", "consumer"]:
        try:
            spec = importlib.util.spec_from_file_location(name, path / f"{name}.py")
            modules[name] = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(modules[name])
        except Exception as error:
            errors.append(f"{name}: {type(error).__name__}: {error}")
    results = []

    def check(name, operation):
        try:
            operation()
            results.append(dict(name=name, passed=True))
        except Exception as error:
            results.append(dict(name=name, passed=False, error=f"{type(error).__name__}: {error}"))

    def equal(actual, expected):
        assert actual == expected, (actual, expected)
        if isinstance(expected, dict):
            for key in expected:
                equal(actual[key], expected[key])
        elif isinstance(expected, list):
            for left, right in zip(actual, expected):
                equal(left, right)
        elif isinstance(expected, (int, float)):
            assert isinstance(actual, bool) == isinstance(expected, bool), (actual, expected)

    scale = 1 if case == "changed" else 1000
    events = [dict(id=str(index), at_ms=stamp, payload=value) for index, (stamp, value) in enumerate([
        (0, None), (-1, False), (1, 0), (1001, "é"), (-1001, []), (1700000000123, {"nested": True}),
    ])]
    wires = [dict(id=event["id"], timestamp=event["at_ms"] if scale == 1 else event["at_ms"] / scale,
                  payload=event["payload"]) for event in events]
    for index, (event, wire) in enumerate(zip(events, wires)):
        check(f"encode-{index}", lambda event=event, wire=wire: equal(modules["producer"].encode(dict(event)), wire))
        check(f"decode-{index}", lambda event=event, wire=wire: equal(modules["consumer"].decode(dict(wire)), event))
    for name, function, inputs, expected in [("producer", "encode_many", events, wires), ("consumer", "decode_many", wires, events)]:
        def batch(name=name, function=function, inputs=inputs, expected=expected):
            copied = json.loads(json.dumps(inputs))
            equal(getattr(modules[name], function)(copied), expected)
            equal(copied, inputs)
        check(function, batch)
        check(function + "-empty", lambda name=name, function=function: equal(getattr(modules[name], function)([]), []))
    for name, function, key, invalid in [("producer", "encode", "at_ms", [True, 1.5, "1"]),
                                          ("consumer", "decode", "timestamp", [True, "1", float("inf"), float("nan")])]:
        def rejects(name=name, function=function, key=key, invalid=invalid):
            for value in invalid:
                try:
                    getattr(modules[name], function)({"id": "bad", key: value, "payload": None})
                except ValueError:
                    continue
                raise AssertionError(f"did not reject {value!r} with ValueError")
        check(function + "-invalid", rejects)
    return dict(passed=sum(row["passed"] for row in results), total=len(results), errors=errors, checks=results)


def self_check():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "task"
        seed(path)
        assert grade(path, "unchanged")["passed"] == 12
        assert grade(path, "changed")["passed"] < 12
        for case in ["changed", "unchanged", "mistaken"]:
            publish(path, case)
            scale = 1 if case == "changed" else 1000
            (path / "producer.py").write_text(f'''def encode(event):
    if type(event["at_ms"]) is not int: raise ValueError("at_ms")
    return {{"id": event["id"], "timestamp": event["at_ms"] / {scale} if {scale} != 1 else event["at_ms"], "payload": event["payload"]}}
def encode_many(events): return [encode(event) for event in events]
''')
            (path / "consumer.py").write_text(f'''import math
def decode(wire):
    value = wire["timestamp"]
    if type(value) not in (int, float) or not math.isfinite(value): raise ValueError("timestamp")
    return {{"id": wire["id"], "at_ms": round(value * {scale}), "payload": wire["payload"]}}
def decode_many(wires): return [decode(wire) for wire in wires]
''')
            assert grade(path, case)["passed"] == 18, grade(path, case)
            if case == "changed":
                assert grade(path, "unchanged")["passed"] < 18
        (path / "consumer.py").write_text("invalid syntax !")
        assert grade(path, "mistaken")["errors"]
    print("Fixture: baseline 12/18, references 18/18; wrong-unit and syntax failures detected")


if __name__ == "__main__":
    if len(sys.argv) == 1:
        self_check()
    else:
        print(json.dumps(grade(Path(sys.argv[1]), sys.argv[2])))
