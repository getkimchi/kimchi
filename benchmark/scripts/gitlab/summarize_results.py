#!/usr/bin/env python3
"""Write an overall benchmark summary JSON from local GitLab artifacts."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

PASS_REWARD = 1.0
TOKENS_PER_MILLION = Decimal("1000000")
USD_QUANTUM = Decimal("0.00000001")
KIMCHI_PRICING_SOURCE = "kimchi_docs_2026-06-11"

COST_SOURCE_AGENT_RESULT = "agent_result"
COST_SOURCE_CLAUDE_CODE_STREAM = "claude_code_stream"
COST_SOURCE_KIMCHI_PRICE_TABLE = "kimchi_price_table"

def model_price_key(provider: str, model: str) -> tuple[str, str]:
    return provider.casefold(), model.casefold()


@dataclass(frozen=True)
class ModelPrice:
    provider: str
    model: str
    input_per_million_tokens: Decimal
    output_per_million_tokens: Decimal

    @property
    def lookup_key(self) -> tuple[str, str]:
        return model_price_key(self.provider, self.model)

    def cost_usd(self, input_tokens: int, output_tokens: int) -> Decimal:
        return (
            (Decimal(input_tokens) / TOKENS_PER_MILLION) * self.input_per_million_tokens
            + (Decimal(output_tokens) / TOKENS_PER_MILLION) * self.output_per_million_tokens
        )


# Downloaded from Kimchi docs on 2026-06-11:
# https://docs.kimchi.dev/docs/model-apis-pricing
# Values are USD per 1M tokens for the Kimchi serverless API.
KIMCHI_MODEL_PRICES: tuple[ModelPrice, ...] = (
    ModelPrice(
        provider="kimchi-dev",
        model="kimi-k2.6",
        input_per_million_tokens=Decimal("1.20"),
        output_per_million_tokens=Decimal("4.50"),
    ),
    ModelPrice(
        provider="kimchi-dev",
        model="kimi-k2.5",
        input_per_million_tokens=Decimal("0.60"),
        output_per_million_tokens=Decimal("3.00"),
    ),
    ModelPrice(
        provider="kimchi-dev",
        model="minimax-m2.7",
        input_per_million_tokens=Decimal("0.30"),
        output_per_million_tokens=Decimal("1.20"),
    ),
    ModelPrice(
        provider="kimchi-dev",
        model="nemotron-3-super-fp4",
        input_per_million_tokens=Decimal("0.30"),
        output_per_million_tokens=Decimal("0.75"),
    ),
)
KIMCHI_MODEL_PRICES_BY_KEY = {price.lookup_key: price for price in KIMCHI_MODEL_PRICES}
KIMCHI_PRICED_PROVIDERS = frozenset(price.provider.casefold() for price in KIMCHI_MODEL_PRICES)


@dataclass(frozen=True)
class CostResult:
    usd: float | None
    source: str | None
    pricing_source: str | None = None
    unpriced_models: tuple[str, ...] = ()


@dataclass(frozen=True)
class ErrorClassification:
    phase: str | None
    kind: str | None
    infrastructure: bool


class TrialErrorClassifier:
    PHASES = ("environment_setup", "agent_setup", "agent_execution", "verifier")
    INFRASTRUCTURE_PHASES = frozenset({"environment_setup", "agent_setup"})

    def __init__(self, result: dict[str, Any]) -> None:
        self.result = result

    def classify(self) -> ErrorClassification:
        if get_path(self.result, "exception_info", "exception_type") is None:
            return ErrorClassification(phase=None, kind=None, infrastructure=False)

        phase = self._exception_phase()
        if self._model_catalog_unavailable():
            return ErrorClassification(
                phase=phase,
                kind="agent_model_catalog_unavailable",
                infrastructure=True,
            )

        kind = f"{phase}_failed" if phase in self.PHASES else "unknown"
        return ErrorClassification(
            phase=phase,
            kind=kind,
            infrastructure=phase in self.INFRASTRUCTURE_PHASES,
        )

    def _phase_contains_time(self, phase: str, timestamp: datetime) -> bool:
        start = parse_time(string_or_none(get_path(self.result, phase, "started_at")))
        end = parse_time(string_or_none(get_path(self.result, phase, "finished_at")))
        return start is not None and end is not None and start <= timestamp <= end

    def _exception_phase(self) -> str:
        occurred_at = parse_time(string_or_none(get_path(self.result, "exception_info", "occurred_at")))
        if occurred_at is not None:
            for phase in self.PHASES:
                if self._phase_contains_time(phase, occurred_at):
                    return phase
        if get_path(self.result, "agent_execution", "started_at") is not None:
            return "agent_execution"
        if get_path(self.result, "agent_setup", "started_at") is not None:
            return "agent_setup"
        if self.result.get("environment_setup") is not None:
            return "environment_setup"
        if self.result.get("verifier") is not None:
            return "verifier"
        return "unknown"

    def _exception_text(self) -> str:
        pieces = [
            get_path(self.result, "exception_info", "exception_type"),
            get_path(self.result, "exception_info", "exception_message"),
            get_path(self.result, "exception_info", "exception_traceback"),
        ]
        return "\n".join(str(piece) for piece in pieces if piece is not None).casefold()

    def _contains_all(self, *needles: str) -> bool:
        text = self._exception_text()
        return all(needle in text for needle in needles)

    def _model_catalog_unavailable(self) -> bool:
        # Covers both gateway metadata fetch failures and CLI fallback failures
        # after the model catalog could not be loaded.
        return (
            self._contains_all("kimchi_agent/gateway.py", "_fetch_model_metadata")
            or self._contains_all("model list", "fetch", "model")
            or self._contains_all("models.json", "no models available")
        )


@dataclass
class ModelStats:
    provider: str
    model: str
    llm_rounds: int = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    tool_calls: Counter[str] = field(default_factory=Counter)

    def to_json(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "llm_rounds": self.llm_rounds,
            "tokens": {
                "input": self.input_tokens,
                "cache_read": self.cache_read_tokens,
                "cache_write": self.cache_write_tokens,
                "output": self.output_tokens,
                "total": self.input_tokens + self.cache_read_tokens + self.cache_write_tokens + self.output_tokens,
            },
            "tool_calls": [
                {"name": name, "count": count}
                for name, count in sorted(self.tool_calls.items(), key=lambda item: (-item[1], item[0]))
            ],
        }


@dataclass
class SessionScan:
    start: str | None = None
    end: str | None = None
    models: dict[tuple[str, str], ModelStats] = field(default_factory=dict)


def getenv(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_json(path: Path, warnings: list[str]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)
    except OSError as exc:
        warnings.append(f"Could not read JSON file {path}: {exc}")
        return {}
    except json.JSONDecodeError as exc:
        warnings.append(f"Could not parse JSON file {path}: {exc}")
        return {}
    if not isinstance(value, dict):
        warnings.append(f"JSON file {path} did not contain an object")
        return {}
    return value


def load_optional_json(path: Path, warnings: list[str]) -> dict[str, Any]:
    return load_json(path, warnings) if path.is_file() else {}


def iter_jsonl(path: Path, warnings: list[str], *, missing_ok: bool = False):
    try:
        file = path.open(encoding="utf-8", errors="replace")
    except OSError as exc:
        if not missing_ok:
            warnings.append(f"Could not read JSONL file {path}: {exc}")
        return
    with file:
        for line_no, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line, parse_float=Decimal)
            except json.JSONDecodeError:
                warnings.append(f"Skipped malformed JSONL entry at {path}:{line_no}")
                continue
            if isinstance(value, dict):
                yield value


def get_path(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def seconds_between(start: str | None, end: str | None) -> int | None:
    start_dt = parse_time(start)
    end_dt = parse_time(end)
    if start_dt is None or end_dt is None:
        return None
    seconds = int((end_dt - start_dt).total_seconds())
    return seconds if seconds >= 0 else None


def numeric_reward(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value))
    except ValueError:
        return None


def cost_decimal_to_json_number(value: Decimal) -> float:
    return float(value.quantize(USD_QUANTUM))


def numeric_cost_usd(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return cost_decimal_to_json_number(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def sum_costs_usd(costs: list[float]) -> float:
    total = sum((Decimal(str(cost)) for cost in costs), Decimal("0"))
    return cost_decimal_to_json_number(total)


def price_for_model(provider: str, model: str) -> ModelPrice | None:
    return KIMCHI_MODEL_PRICES_BY_KEY.get(model_price_key(provider, model))


def is_priced_kimchi_provider(provider: str) -> bool:
    return provider.casefold() in KIMCHI_PRICED_PROVIDERS


def has_kimchi_price(model_ref: tuple[str, str]) -> bool:
    return price_for_model(*model_ref) is not None


def configured_model_ref(result: dict[str, Any]) -> tuple[str, str]:
    return split_model_ref(string_or_none(get_path(result, "config", "agent", "model_name")))


def priced_stats_ref(stats: ModelStats, fallback_model: tuple[str, str] | None) -> tuple[str, str]:
    if fallback_model is None:
        return stats.provider, stats.model

    fallback_provider, fallback_model_id = fallback_model
    if stats.provider == "unknown" and stats.model.casefold() == fallback_model_id.casefold():
        return fallback_provider, fallback_model_id
    return stats.provider, stats.model


def backfilled_session_cost(session_scan: SessionScan, fallback_model: tuple[str, str] | None = None) -> CostResult:
    total_cost = Decimal("0")
    priced_any_model = False
    unpriced_models: set[str] = set()
    for stats in session_scan.models.values():
        input_tokens = stats.input_tokens + stats.cache_read_tokens + stats.cache_write_tokens
        output_tokens = stats.output_tokens
        if input_tokens == 0 and output_tokens == 0:
            continue

        provider, model = priced_stats_ref(stats, fallback_model)
        price = price_for_model(provider, model)
        if price is None:
            unpriced_models.add(f"{provider}/{model}")
            continue

        priced_any_model = True
        total_cost += price.cost_usd(input_tokens=input_tokens, output_tokens=output_tokens)

    if unpriced_models:
        return CostResult(
            usd=None,
            source=None,
            pricing_source=KIMCHI_PRICING_SOURCE,
            unpriced_models=tuple(sorted(unpriced_models)),
        )
    if not priced_any_model:
        return CostResult(usd=None, source=None)
    return CostResult(
        usd=cost_decimal_to_json_number(total_cost),
        source=COST_SOURCE_KIMCHI_PRICE_TABLE,
        pricing_source=KIMCHI_PRICING_SOURCE,
    )


def backfilled_agent_result_cost(result: dict[str, Any], model_ref: tuple[str, str]) -> CostResult:
    provider, model = model_ref
    input_tokens = int_value(get_path(result, "agent_result", "n_input_tokens"))
    output_tokens = int_value(get_path(result, "agent_result", "n_output_tokens"))
    if input_tokens == 0 and output_tokens == 0:
        return CostResult(usd=None, source=None)

    price = price_for_model(provider, model)
    if price is None:
        return CostResult(
            usd=None,
            source=None,
            pricing_source=KIMCHI_PRICING_SOURCE,
            unpriced_models=(f"{provider}/{model}",),
        )

    return CostResult(
        usd=cost_decimal_to_json_number(price.cost_usd(input_tokens=input_tokens, output_tokens=output_tokens)),
        source=COST_SOURCE_KIMCHI_PRICE_TABLE,
        pricing_source=KIMCHI_PRICING_SOURCE,
    )


def warn_unpriced_cost_models(trial_dir: Path, cost_result: CostResult, warnings: list[str]) -> None:
    if not cost_result.unpriced_models:
        return
    warnings.append(
        "No Kimchi price for "
        + ", ".join(cost_result.unpriced_models)
        + f" in trial {trial_dir.name}; cost_usd left null."
    )


def trial_cost_result(
    trial_dir: Path,
    result: dict[str, Any],
    session_scan: SessionScan,
    warnings: list[str],
) -> CostResult:
    model_ref = configured_model_ref(result)
    if has_kimchi_price(model_ref):
        cost_result = backfilled_session_cost(session_scan, fallback_model=model_ref)
        if cost_result.usd is not None or cost_result.unpriced_models:
            warn_unpriced_cost_models(trial_dir, cost_result, warnings)
            return cost_result

        cost_result = backfilled_agent_result_cost(result, model_ref)
        warn_unpriced_cost_models(trial_dir, cost_result, warnings)
        return cost_result

    cost = numeric_cost_usd(get_path(result, "agent_result", "cost_usd"))
    if cost is not None:
        return CostResult(usd=cost, source=COST_SOURCE_AGENT_RESULT)

    stream_path = trial_dir / "agent" / "claude-code.txt"
    last_cost: float | None = None
    for event in iter_jsonl(stream_path, warnings, missing_ok=True):
        if isinstance(event, dict) and event.get("type") == "result":
            parsed_cost = numeric_cost_usd(event.get("total_cost_usd"))
            if parsed_cost is not None:
                last_cost = parsed_cost
    if last_cost is not None:
        return CostResult(usd=last_cost, source=COST_SOURCE_CLAUDE_CODE_STREAM)

    cost_result = backfilled_session_cost(session_scan)
    warn_unpriced_cost_models(trial_dir, cost_result, warnings)
    return cost_result


def int_value(value: Any) -> int:
    if value is None or isinstance(value, bool):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def int_from_keys(value: dict[str, Any], *keys: str) -> int:
    for key in keys:
        if key in value:
            return int_value(value.get(key))
    return 0


def string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def metadata_string(metadata: dict[str, Any], key: str, default: str = "unknown") -> str:
    value = metadata.get(key)
    if value is None:
        return default
    text = str(value)
    return text if text else default


def metadata_dict(metadata: dict[str, Any], key: str) -> dict[str, Any]:
    value = metadata.get(key)
    return value if isinstance(value, dict) else {}


def split_model_ref(value: str | None) -> tuple[str, str]:
    if value and "/" in value:
        provider, model = value.split("/", 1)
        return provider or "unknown", model or "unknown"
    return "unknown", value or "unknown"


def resolve_message_model(message: dict[str, Any], current_model: tuple[str, str] | None) -> tuple[str, str]:
    provider = message.get("provider")
    model = message.get("model")
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return provider, model
    if isinstance(model, str) and model:
        return split_model_ref(model)
    if current_model is not None:
        return current_model
    return "unknown", "unknown"


def model_stats(models: dict[tuple[str, str], ModelStats], provider: str, model: str) -> ModelStats:
    key = (provider, model)
    if key not in models:
        models[key] = ModelStats(provider=provider, model=model)
    return models[key]


def tool_call_names(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    names: list[str] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "toolCall":
            continue
        name = item.get("name")
        names.append(str(name) if name else "unknown")
    return names


def scan_session_file(path: Path, warnings: list[str]) -> SessionScan:
    scan = SessionScan()
    current_model: tuple[str, str] | None = None
    for entry in iter_jsonl(path, warnings):
        timestamp = entry.get("timestamp")
        if isinstance(timestamp, str):
            scan.start = min(scan.start, timestamp) if scan.start else timestamp
            scan.end = max(scan.end, timestamp) if scan.end else timestamp

        if entry.get("type") == "model_change":
            provider = entry.get("provider")
            model_id = entry.get("modelId")
            if isinstance(provider, str) and isinstance(model_id, str):
                current_model = (provider or "unknown", model_id or "unknown")

        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue

        provider, model = resolve_message_model(message, current_model)
        stats = model_stats(scan.models, provider, model)

        usage = message.get("usage")
        if isinstance(usage, dict):
            stats.llm_rounds += 1
            stats.input_tokens += int_from_keys(usage, "input", "input_tokens")
            stats.cache_read_tokens += int_from_keys(usage, "cacheRead", "cache_read", "cache_read_input_tokens")
            stats.cache_write_tokens += int_from_keys(
                usage,
                "cacheWrite",
                "cache_write",
                "cache_creation_input_tokens",
            )
            stats.output_tokens += int_from_keys(usage, "output", "output_tokens")

        for name in tool_call_names(message.get("content")):
            stats.tool_calls[name] += 1
    return scan


def merge_session_scans(scans: list[SessionScan]) -> SessionScan:
    merged = SessionScan()
    for scan in scans:
        if scan.start:
            merged.start = min(merged.start, scan.start) if merged.start else scan.start
        if scan.end:
            merged.end = max(merged.end, scan.end) if merged.end else scan.end
        for key, stats in scan.models.items():
            target = model_stats(merged.models, key[0], key[1])
            target.llm_rounds += stats.llm_rounds
            target.input_tokens += stats.input_tokens
            target.cache_read_tokens += stats.cache_read_tokens
            target.cache_write_tokens += stats.cache_write_tokens
            target.output_tokens += stats.output_tokens
            target.tool_calls.update(stats.tool_calls)
    return merged


def normalize_session_scan_models(scan: SessionScan, fallback_model: tuple[str, str]) -> SessionScan:
    normalized = SessionScan(start=scan.start, end=scan.end)
    for stats in scan.models.values():
        provider, model = priced_stats_ref(stats, fallback_model)
        target = model_stats(normalized.models, provider, model)
        target.llm_rounds += stats.llm_rounds
        target.input_tokens += stats.input_tokens
        target.cache_read_tokens += stats.cache_read_tokens
        target.cache_write_tokens += stats.cache_write_tokens
        target.output_tokens += stats.output_tokens
        target.tool_calls.update(stats.tool_calls)
    return normalized


def model_sort_key(stats: ModelStats) -> tuple[int, str, str]:
    total_tokens = stats.input_tokens + stats.cache_read_tokens + stats.cache_write_tokens + stats.output_tokens
    return -total_tokens, stats.provider, stats.model


def is_trial_dir(path: Path) -> bool:
    if not path.is_dir() or "__" not in path.name:
        return False
    result_path = path / "result.json"
    if not result_path.is_file():
        return False
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"), parse_float=Decimal)
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(result, dict) and isinstance(result.get("trial_name"), str)


def find_trial_dirs(results_dir: Path) -> list[Path]:
    if is_trial_dir(results_dir):
        return [results_dir]
    immediate = sorted(path for path in results_dir.iterdir() if is_trial_dir(path)) if results_dir.is_dir() else []
    if immediate:
        return immediate
    if not results_dir.is_dir():
        return []
    trials: list[Path] = []
    for run_dir in sorted(path for path in results_dir.iterdir() if path.is_dir()):
        trials.extend(sorted(path for path in run_dir.iterdir() if is_trial_dir(path)))
    return trials


def trial_total_time(result: dict[str, Any], session_scan: SessionScan) -> int | None:
    total = seconds_between(
        string_or_none(get_path(result, "agent_execution", "started_at")),
        string_or_none(get_path(result, "verifier", "finished_at")),
    )
    if total is not None:
        return total
    total = seconds_between(
        string_or_none(get_path(result, "agent_execution", "started_at")),
        string_or_none(get_path(result, "agent_execution", "finished_at")),
    )
    if total is not None:
        return total
    return seconds_between(session_scan.start, session_scan.end)


def run_bounds(results_dir: Path, trials: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    run_results: list[dict[str, Any]] = []
    warnings: list[str] = []
    for run_dir in sorted({Path(trial["_trial_dir"]).parent for trial in trials}):
        result = load_optional_json(run_dir / "result.json", warnings)
        if result:
            run_results.append(result)

    starts = [result.get("started_at") for result in run_results if isinstance(result.get("started_at"), str)]
    ends = [result.get("finished_at") for result in run_results if isinstance(result.get("finished_at"), str)]
    if starts or ends:
        return (min(starts) if starts else None, max(ends) if ends else None)

    trial_starts = [trial.get("_start") for trial in trials if isinstance(trial.get("_start"), str)]
    trial_ends = [trial.get("_end") for trial in trials if isinstance(trial.get("_end"), str)]
    if not trial_starts and not trial_ends and results_dir.is_file():
        return None, None
    return (min(trial_starts) if trial_starts else None, max(trial_ends) if trial_ends else None)


def summarize_trial(trial_dir: Path, attempt: int, warnings: list[str]) -> dict[str, Any]:
    result = load_json(trial_dir / "result.json", warnings)
    session_files = sorted(path for path in (trial_dir / "agent" / "sessions").rglob("*.jsonl") if path.is_file())
    if not session_files and not (trial_dir / "agent" / "claude-code.txt").is_file():
        warnings.append(f"No agent transcript artifacts found for trial {trial_dir.name}")
    session_scan = merge_session_scans([scan_session_file(path, warnings) for path in session_files])
    model_ref = configured_model_ref(result)
    if is_priced_kimchi_provider(model_ref[0]):
        session_scan = normalize_session_scan_models(session_scan, model_ref)

    reward = numeric_reward(get_path(result, "verifier_result", "rewards", "reward"))
    cost_result = trial_cost_result(trial_dir, result, session_scan, warnings)
    exception = string_or_none(get_path(result, "exception_info", "exception_type"))
    error = TrialErrorClassifier(result).classify()
    total_time_seconds = trial_total_time(result, session_scan)
    task = trial_dir.name.split("__", 1)[0]
    return {
        "task": task,
        "trial": trial_dir.name,
        "attempt": attempt,
        "solved": reward == PASS_REWARD,
        "reward": reward,
        "cost_usd": cost_result.usd,
        "cost_source": cost_result.source,
        "cost_pricing_source": cost_result.pricing_source,
        "cost_unpriced_models": list(cost_result.unpriced_models),
        "exception": exception,
        "exception_phase": error.phase,
        "error_kind": error.kind,
        "infrastructure_error": error.infrastructure,
        "scoreable": not error.infrastructure,
        "total_time_seconds": total_time_seconds,
        "models": [stats.to_json() for stats in sorted(session_scan.models.values(), key=model_sort_key)],
        "_trial_dir": str(trial_dir),
        "_start": string_or_none(get_path(result, "agent_execution", "started_at")) or session_scan.start,
        "_end": string_or_none(get_path(result, "verifier", "finished_at"))
        or string_or_none(get_path(result, "agent_execution", "finished_at"))
        or session_scan.end,
    }


def strip_private_fields(trial: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in trial.items() if not key.startswith("_")}


def build_results(trials: list[dict[str, Any]]) -> dict[str, Any]:
    unique_tasks = {trial["task"] for trial in trials}
    solved_tasks = {trial["task"] for trial in trials if trial["solved"]}
    numeric_rewards = [trial["reward"] for trial in trials if isinstance(trial["reward"], (int, float))]
    costs = [trial["cost_usd"] for trial in trials if isinstance(trial["cost_usd"], (int, float))]
    cost_sources = Counter(
        trial["cost_source"]
        for trial in trials
        if isinstance(trial["cost_usd"], (int, float)) and isinstance(trial["cost_source"], str)
    )
    scoreable_trials = [trial for trial in trials if trial["scoreable"]]
    score_unique_tasks = {trial["task"] for trial in scoreable_trials}
    score_solved_tasks = {trial["task"] for trial in scoreable_trials if trial["solved"]}
    passed = sum(1 for trial in trials if trial["solved"])
    score_passed = sum(1 for trial in scoreable_trials if trial["solved"])
    score_rewards = [
        trial["reward"] if isinstance(trial["reward"], (int, float)) else 0.0 for trial in scoreable_trials
    ]
    return {
        "unique_tasks_total": len(unique_tasks),
        "unique_tasks_solved": len(solved_tasks),
        "trials_total": len(trials),
        "trials_passed": passed,
        "trials_failed": len(trials) - passed,
        "trials_with_errors": sum(1 for trial in trials if trial["exception"] is not None),
        "trials_infrastructure_errors": sum(1 for trial in trials if trial["infrastructure_error"]),
        "mean_reward": (sum(numeric_rewards) / len(numeric_rewards)) if numeric_rewards else None,
        "score_trials_total": len(scoreable_trials),
        "score_trials_passed": score_passed,
        "score_trials_failed": len(scoreable_trials) - score_passed,
        "score_pass_rate": score_passed / len(scoreable_trials) if scoreable_trials else None,
        "score_mean_reward": sum(score_rewards) / len(score_rewards) if score_rewards else None,
        "score_unique_tasks_total": len(score_unique_tasks),
        "score_unique_tasks_solved": len(score_solved_tasks),
        "score_unique_task_rate": len(score_solved_tasks) / len(score_unique_tasks) if score_unique_tasks else None,
        "trials_with_cost": len(costs),
        "total_cost_usd": sum_costs_usd(costs) if costs else None,
        "cost_sources": [
            {"source": source, "trials": count}
            for source, count in sorted(cost_sources.items(), key=lambda item: (-item[1], item[0]))
        ],
    }


def build_run(metadata: dict[str, Any], started_at: str | None, finished_at: str | None) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    return {
        "benchmark": metadata_string(metadata, "benchmark"),
        "coding_agent": metadata_string(metadata, "coding_agent"),
        "model": metadata_string(metadata, "model"),
        "configuration": metadata_string(metadata, "configuration", "na"),
        "gitlab_pipeline_id": str(gitlab.get("pipeline_id") or getenv("CI_PIPELINE_ID") or ""),
        "gitlab_job_id": str(gitlab.get("job_id") or ""),
        "gitlab_ref": str(gitlab.get("ref") or ""),
        "gitlab_commit_sha": str(gitlab.get("commit_sha") or ""),
        "target_ref": str(gitlab.get("target_ref") or gitlab.get("ref") or ""),
        "target_commit_sha": str(gitlab.get("target_commit_sha") or gitlab.get("commit_sha") or ""),
        "started_at": started_at,
        "finished_at": finished_at,
        "total_time_seconds": seconds_between(started_at, finished_at),
    }


def write_summary(metadata_path: Path, output_path: Path, results_dir_override: Path | None = None) -> int:
    warnings: list[str] = []
    if metadata_path.is_file():
        metadata = load_json(metadata_path, warnings)
    else:
        warnings.append(f"No benchmark run metadata found at {metadata_path}")
        metadata = {}
    results_dir = results_dir_override or Path(
        metadata_string(metadata, "results_dir", "benchmark/terminal-bench-2/jobs")
    )
    trial_dirs = find_trial_dirs(results_dir)
    if not trial_dirs:
        warnings.append(f"No trial result directories found under {results_dir}")

    attempts_by_task: defaultdict[str, int] = defaultdict(int)
    trials: list[dict[str, Any]] = []
    for trial_dir in sorted(trial_dirs, key=lambda path: (path.name.split("__", 1)[0], path.name)):
        task = trial_dir.name.split("__", 1)[0]
        attempts_by_task[task] += 1
        trials.append(summarize_trial(trial_dir, attempts_by_task[task], warnings))

    started_at, finished_at = run_bounds(results_dir, trials)
    summary = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "run": build_run(metadata, started_at, finished_at),
        "results": build_results(trials),
        "tasks": [strip_private_fields(trial) for trial in trials],
        "warnings": warnings,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote benchmark summary to {output_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Write summary.json from benchmark job artifacts.")
    parser.add_argument(
        "--metadata",
        type=Path,
        default=Path(getenv("BENCHMARK_RUN_METADATA", ".benchmark/run-metadata.json")),
        help="Path to benchmark run metadata JSON.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=None,
        help="Override benchmark results directory. Defaults to metadata.results_dir.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(getenv("BENCHMARK_SUMMARY_PATH", ".benchmark/summary.json")),
        help="Output summary JSON path.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return write_summary(args.metadata, args.output, args.results_dir)


if __name__ == "__main__":
    raise SystemExit(main())
