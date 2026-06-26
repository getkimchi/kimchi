# Benchmark Summary v2 Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the benchmark `summary.json` schema in sync with the current producer, fix semantic inaccuracies in the produced JSON, and remove the disabled APA notify job.

**Architecture:** Add a `benchmark-summary-v2.schema.json` that validates the output currently emitted by `summarize_results.py`; update the producer to report accurate `run.status`, make trial `error` nullable for passed tasks, rename the misleading `totals.expected` field, and remove the disabled `terminal-bench-2-apa-notify` GitLab CI job. Keep the per-trial `status` field because the `dwh.kimchi_benchmark_runs` ClickHouse view depends on it. Add regression tests that validate generated summaries against the new schema.

**Tech Stack:** Python 3, `jsonschema`, `unittest`, GitLab CI YAML, `jq`.

---

## File structure

| File | Responsibility |
|------|----------------|
| `benchmark/schemas/benchmark-summary-v2.schema.json` | New canonical JSON Schema for `summary.json` v2 |
| `benchmark/scripts/gitlab/summarize_results.py` | Producer fixes for accurate run status, nullable error, and corrected totals |
| `benchmark/scripts/gitlab/tests/test_summarize_results.py` | Regression tests for producer changes and schema validation |
| `.gitlab/ci/terminal-bench-2.yml` | Remove the disabled APA notify job |

---

## SQL view compatibility

The ClickHouse view `dwh.kimchi_benchmark_runs` in `/Users/jose/Documents/superset/kimchi_benchmark_runs_v3.sql` reads `summary.json` directly from GCS and expects the following fields. The v2 schema and producer changes below must preserve all of them:

**Run-level fields**
- `run.run_id`
- `run.agent.name`
- `run.agent.version`
- `run.started_at`
- `run.ended_at`
- `source.gitlab.ref`
- `source.gitlab.commit_sha`

**Trial-level fields**
- `trial_id`
- `task`
- `attempt`
- `status` ← must remain; extracted as `trial_status`
- `score`
- `error.type`
- `error.message`
- `error_category`
- `error_subcategory`
- `verdict`
- `duration_ms`

**Model-level fields (first model block only)**
- `model`
- `llm_rounds`
- `tokens.input`
- `tokens.cache_read`
- `tokens.cache_write`
- `tokens.output`

Because the view uses `JSONExtractString(trial, 'status')`, removing trial `status` would break the view. Making `error` nullable is safe: ClickHouse returns an empty string when the path is missing.

---

## Task 1: Add `benchmark-summary-v2.schema.json`

**Files:**
- Create: `benchmark/schemas/benchmark-summary-v2.schema.json`

**Context:** The producer emits `schema_version: "benchmark-summary/v2"` (`summarize_results.py:25` and `:857`), but the repo only contains `benchmark-summary-v1.schema.json`. This task creates the missing v2 schema.

- [ ] **Step 1.1: Write the v2 schema file**

Create `benchmark/schemas/benchmark-summary-v2.schema.json` with the following content:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://kimchi.dev/schemas/benchmark-summary-v2.schema.json",
  "title": "Benchmark summary v2",
  "description": "JSON artifact schema for terminal-bench-2 benchmark run summaries produced by summarize_results.py.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "classification",
    "totals",
    "is_complete",
    "chunks_exhausted_retries",
    "run",
    "trials",
    "source"
  ],
  "properties": {
    "schema_version": {
      "description": "Schema version identifier.",
      "const": "benchmark-summary/v2"
    },
    "classification": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "classified_by",
        "pipeline_run_id",
        "pipeline_url",
        "generated_at"
      ],
      "properties": {
        "classified_by": {
          "type": "string",
          "minLength": 1
        },
        "pipeline_run_id": {
          "type": "string",
          "minLength": 1
        },
        "pipeline_url": {
          "type": "string"
        },
        "generated_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "totals": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "trials_recorded",
        "tasks_expected",
        "passed",
        "failed_quality",
        "timeout",
        "infra_error",
        "no_verdict",
        "infra_retries"
      ],
      "properties": {
        "trials_recorded": {
          "type": "integer",
          "minimum": 0,
          "description": "Number of trial records included in this summary."
        },
        "tasks_expected": {
          "type": "integer",
          "minimum": 0,
          "description": "Number of distinct benchmark tasks expected to be run."
        },
        "passed": {
          "type": "integer",
          "minimum": 0
        },
        "failed_quality": {
          "type": "integer",
          "minimum": 0
        },
        "timeout": {
          "type": "integer",
          "minimum": 0
        },
        "infra_error": {
          "type": "integer",
          "minimum": 0
        },
        "no_verdict": {
          "type": "integer",
          "minimum": 0
        },
        "infra_retries": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "is_complete": {
      "description": "True when no tasks are missing a verdict and no retryable timeout or infra failures remain. Quality failures (scored_fail) do not make the run incomplete.",
      "type": "boolean"
    },
    "chunks_exhausted_retries": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^chunk-[0-9]+$"
      }
    },
    "run": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "benchmark",
        "run_id",
        "status",
        "started_at",
        "ended_at",
        "agent",
        "configuration",
        "model",
        "retry_agent_timeout"
      ],
      "properties": {
        "benchmark": {
          "type": "string",
          "minLength": 1
        },
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "description": "Derived from is_complete. 'completed' when is_complete is true, 'partial' otherwise.",
          "type": "string",
          "enum": ["completed", "partial"]
        },
        "started_at": {
          "type": "string",
          "format": "date-time"
        },
        "ended_at": {
          "type": "string",
          "format": "date-time"
        },
        "agent": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "version"
          ],
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1
            },
            "version": {
              "description": "Commit SHA of the benchmarked code.",
              "type": "string",
              "minLength": 1
            }
          }
        },
        "configuration": {
          "type": "string",
          "minLength": 1
        },
        "model": {
          "type": "string",
          "minLength": 1
        },
        "retry_agent_timeout": {
          "description": "Whether agent_timeout verdicts were retried by chunk_runner.",
          "type": "boolean"
        }
      }
    },
    "trials": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "trial_id",
          "task",
          "attempt",
          "status",
          "score",
          "error",
          "models",
          "error_category",
          "error_subcategory",
          "verdict"
        ],
        "properties": {
          "trial_id": {
            "type": "string",
            "minLength": 1
          },
          "task": {
            "type": "string",
            "minLength": 1
          },
          "attempt": {
            "type": "integer",
            "minimum": 0
          },
          "status": {
            "description": "Backward-compatible two-value outcome. 'passed' only when the verifier reward is 1.0; otherwise 'failed'. Required by dwh.kimchi_benchmark_runs.",
            "type": "string",
            "enum": ["passed", "failed"]
          },
          "score": {
            "description": "Verifier reward. Null when no verifier result is available.",
            "type": ["number", "null"],
            "minimum": 0,
            "maximum": 1
          },
          "duration_ms": {
            "type": "integer",
            "minimum": 0
          },
          "error": {
            "description": "Null for passed trials; otherwise an error summary.",
            "type": ["object", "null"],
            "additionalProperties": false,
            "required": ["type", "message"],
            "properties": {
              "type": {
                "type": "string",
                "minLength": 1
              },
              "message": {
                "type": "string",
                "minLength": 1
              }
            }
          },
          "error_category": {
            "description": "High-level error bucket. Null for passed or agent_timeout verdicts.",
            "type": ["string", "null"],
            "enum": ["infra", "agent", null]
          },
          "error_subcategory": {
            "description": "Fine-grained error kind from classify.py. Null for passed trials.",
            "type": ["string", "null"]
          },
          "verdict": {
            "description": "Internal outcome enum.",
            "type": "string",
            "enum": ["scored_pass", "scored_fail", "agent_timeout", "error"]
          },
          "models": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "model",
                "llm_rounds",
                "tokens",
                "tools"
              ],
              "properties": {
                "model": {
                  "type": "string",
                  "minLength": 1
                },
                "llm_rounds": {
                  "type": "integer",
                  "minimum": 0
                },
                "tokens": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "input",
                    "cache_read",
                    "cache_write",
                    "output"
                  ],
                  "properties": {
                    "input": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "cache_read": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "cache_write": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "output": {
                      "type": "integer",
                      "minimum": 0
                    }
                  }
                },
                "tools": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "name",
                      "calls"
                    ],
                    "properties": {
                      "name": {
                        "type": "string",
                        "minLength": 1
                      },
                      "calls": {
                        "type": "integer",
                        "minimum": 0
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "gitlab"
      ],
      "properties": {
        "gitlab": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "ref",
            "commit_sha"
          ],
          "properties": {
            "ref": {
              "type": ["string", "null"],
              "minLength": 1
            },
            "commit_sha": {
              "type": ["string", "null"],
              "minLength": 1
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 1.2: Verify the schema file is valid JSON**

Run:

```bash
python3 -m json.tool benchmark/schemas/benchmark-summary-v2.schema.json > /dev/null
```

Expected: command exits 0 with no output.

- [ ] **Step 1.3: Commit the new schema**

```bash
git add benchmark/schemas/benchmark-summary-v2.schema.json
git commit -m "feat(benchmark): add benchmark-summary-v2 schema"
```

---

## Task 2: Update producer to emit accurate and schema-compliant JSON

**Files:**
- Modify: `benchmark/scripts/gitlab/summarize_results.py`

### 2.1 Derive `run.status` from `is_complete`

- [ ] **Step 2.1.1: Add a helper to compute run status**

In `benchmark/scripts/gitlab/summarize_results.py`, after the `build_run` function, add:

```python
def run_status(is_complete: bool) -> str:
    """Return the run-level status reported in summary.json."""
    return "completed" if is_complete else "partial"
```

- [ ] **Step 2.1.2: Pass `is_complete` into `build_run` and use it**

Change `build_run` signature from:

```python
def build_run(
    metadata: dict[str, Any],
    started_at: str | None,
    finished_at: str | None,
    generated_at: str,
) -> dict[str, Any]:
```

to:

```python
def build_run(
    metadata: dict[str, Any],
    started_at: str | None,
    finished_at: str | None,
    generated_at: str,
    is_complete: bool,
) -> dict[str, Any]:
```

Replace the line:

```python
        "status": "completed",
```

with:

```python
        "status": run_status(is_complete),
```

- [ ] **Step 2.1.3: Update the call site in `build_summary`**

Find:

```python
        "run": build_run(metadata, started_at, finished_at, generated_at),
```

Replace with:

```python
        "run": build_run(metadata, started_at, finished_at, generated_at, is_complete),
```

### 2.2 Make trial `error` nullable for passed trials

- [ ] **Step 2.2.1: Update `TrialSummary.error()` to return `None` for passed trials**

Replace:

```python
    def error(self) -> dict[str, str]:
        return {
            "type": self.error_subcategory or self.exception or "",
            "message": self.exception_message or self.exception or "",
        }
```

with:

```python
    def error(self) -> dict[str, str] | None:
        if self.outcome == Outcome.SCORED_PASS:
            return None
        return {
            "type": self.error_subcategory or self.exception or "unknown",
            "message": self.exception_message or self.exception or "unknown",
        }
```

- [ ] **Step 2.2.2: Update type hints on `TrialSummary` fields if needed**

No other changes are required; `error()` is called only inside `to_summary_json()`.

### 2.3 Rename `totals.expected` and add `tasks_expected`

- [ ] **Step 2.3.1: Compute `tasks_expected` in `build_summary`**

Inside `build_summary`, before the return statement, add:

```python
    selected_tasks = metadata_dict(metadata, "parameters").get("selected_tasks") or metadata.get("selected_tasks")
    if isinstance(selected_tasks, list):
        tasks_expected = len(selected_tasks)
    else:
        # Fall back to distinct tasks actually recorded when no selection metadata is present.
        tasks_expected = len({t.task for t in trials})
```

- [ ] **Step 2.3.2: Replace `expected` with `trials_recorded` and add `tasks_expected`**

Replace:

```python
        "totals": {
            "expected": len(trials),
            "passed": passed,
            ...
        },
```

with:

```python
        "totals": {
            "trials_recorded": len(trials),
            "tasks_expected": tasks_expected,
            "passed": passed,
            ...
        },
```

### 2.4 Make `source.gitlab` fields nullable when unknown

- [ ] **Step 2.4.1: Update `build_source` to return `null` instead of empty strings**

Replace:

```python
def build_source(metadata: dict[str, Any]) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    return {
        "gitlab": {
            "ref": str(gitlab.get("target_ref") or gitlab.get("ref") or ""),
            "commit_sha": str(gitlab.get("target_commit_sha") or gitlab.get("commit_sha") or ""),
        },
    }
```

with:

```python
def _nonempty_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def build_source(metadata: dict[str, Any]) -> dict[str, Any]:
    gitlab = metadata_dict(metadata, "gitlab")
    return {
        "gitlab": {
            "ref": _nonempty_or_none(gitlab.get("target_ref") or gitlab.get("ref")),
            "commit_sha": _nonempty_or_none(gitlab.get("target_commit_sha") or gitlab.get("commit_sha")),
        },
    }
```

- [ ] **Step 2.5: Run producer unit tests**

Run:

```bash
cd /Users/jose/reps/kimchi-gitlab/benchmark/scripts/gitlab
python3 -m pytest tests/test_summarize_results.py -v
```

Expected: tests pass (some will fail until Task 3 updates them).

- [ ] **Step 2.6: Commit producer changes**

```bash
git add benchmark/scripts/gitlab/summarize_results.py
git commit -m "fix(benchmark): accurate run status, nullable trial error, corrected totals"
```

---

## Task 3: Update and extend tests

**Files:**
- Modify: `benchmark/scripts/gitlab/tests/test_summarize_results.py`

### 3.1 Update existing assertions for nullable error

- [ ] **Step 3.1.1: Keep trial `status` tests and update nullable-error assertions**

The `dwh.kimchi_benchmark_runs` ClickHouse view extracts `trial.status` as `trial_status`, so do **not** remove any tests that assert on `data["status"]`.

Keep `test_status_is_only_passed_or_failed` as-is.

For tests that read `data["status"]` incidentally, leave those assertions unchanged.

Update only the `error` assertions for passed trials (see next step).

- [ ] **Step 3.1.2: Update tests that assert `error.type` / `error.message` on passed trials**

For passed trials, replace assertions like:

```python
self.assertEqual(data["error"]["type"], "")
```

with:

```python
self.assertIsNone(data["error"])
```

If a test expects a failed trial, keep the existing `error` assertions.

- [ ] **Step 3.1.3: Update `test_write_summary_prints_table` to assert new totals keys**

After calling `write_summary`, load the summary and assert:

```python
summary = json.loads(output_path.read_text(encoding="utf-8"))
self.assertEqual(summary["totals"]["trials_recorded"], 1)
self.assertEqual(summary["totals"]["tasks_expected"], 1)
self.assertNotIn("expected", summary["totals"])
```

### 3.2 Add tests for `run.status`

- [ ] **Step 3.2.1: Add `test_run_status_completed_when_is_complete_true`**

```python
def test_run_status_completed_when_is_complete_true(self):
    run = summarize_results.build_run(
        {"gitlab": {"pipeline_id": "1"}, "gcs": {"run_id": "r1"}},
        "2026-06-25T00:00:00Z",
        "2026-06-25T00:01:00Z",
        "2026-06-25T00:01:01Z",
        is_complete=True,
    )
    self.assertEqual(run["status"], "completed")
```

- [ ] **Step 3.2.2: Add `test_run_status_partial_when_is_complete_false`**

```python
def test_run_status_partial_when_is_complete_false(self):
    run = summarize_results.build_run(
        {"gitlab": {"pipeline_id": "1"}, "gcs": {"run_id": "r1"}},
        "2026-06-25T00:00:00Z",
        "2026-06-25T00:01:00Z",
        "2026-06-25T00:01:01Z",
        is_complete=False,
    )
    self.assertEqual(run["status"], "partial")
```

### 3.3 Add schema-validation test

- [ ] **Step 3.3.1: Add `jsonschema` to the benchmark script environment if not already importable**

Check `benchmark/scripts/gitlab/pyproject.toml` or `requirements.txt`. If `jsonschema` is not listed, add it:

```toml
[project]
dependencies = [
    "jsonschema>=4.0",
]
```

If no `pyproject.toml` exists and dependencies are managed elsewhere, skip adding and instead install it manually for the test run:

```bash
pip install jsonschema
```

- [ ] **Step 3.3.2: Add schema validation test**

Append to `test_summarize_results.py`:

```python
import json
from pathlib import Path

from jsonschema import validate, ValidationError


SCHEMA_PATH = Path(__file__).resolve().parents[3] / "schemas" / "benchmark-summary-v2.schema.json"


class SummarySchemaValidationTest(unittest.TestCase):
    def test_summary_validates_against_v2_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            results_dir = tmp_path / "jobs" / "run-1"
            results_dir.mkdir(parents=True)

            trial_dir = results_dir / "sample-task__abc123"
            trial_dir.mkdir()
            write_json(trial_dir / "result.json", {
                **BASE_RESULT,
                "outcome": "scored_pass",
                "error_category": None,
                "error_subcategory": None,
            })
            sessions_dir = trial_dir / "agent" / "sessions"
            sessions_dir.mkdir(parents=True)
            (sessions_dir / "main.jsonl").write_text("\n", encoding="utf-8")

            metadata_path = tmp_path / "run-metadata.json"
            write_json(metadata_path, {
                "benchmark": "terminal-bench-2",
                "coding_agent": "kimchi",
                "model": "kimchi-dev/kimi-k2.6",
                "configuration": "single-model",
                "results_dir": str(results_dir),
                "gitlab": {
                    "target_ref": "main",
                    "target_commit_sha": "deadbeef",
                },
                "gcs": {"run_id": "gitlab-p42"},
                "parameters": {"selected_tasks": ["sample-task"]},
            })

            output_path = tmp_path / "summary.json"
            with contextlib.redirect_stdout(io.StringIO()):
                summarize_results.write_summary(metadata_path, output_path, results_dir_override=results_dir)

            summary = json.loads(output_path.read_text(encoding="utf-8"))
            schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
            try:
                validate(instance=summary, schema=schema)
            except ValidationError as exc:
                self.fail(f"summary.json does not validate against v2 schema: {exc.message} at {list(exc.path)}")
```

- [ ] **Step 3.3.3: Run the updated test suite**

```bash
cd /Users/jose/reps/kimchi-gitlab/benchmark/scripts/gitlab
python3 -m pytest tests/test_summarize_results.py -v
```

Expected: all tests pass.

- [ ] **Step 3.4: Commit test changes**

```bash
git add benchmark/scripts/gitlab/tests/test_summarize_results.py
git commit -m "test(benchmark): update summary assertions and validate against v2 schema"
```

---

## Task 4: Remove the disabled APA notify job

**Files:**
- Modify: `.gitlab/ci/terminal-bench-2.yml`

- [ ] **Step 4.1: Delete the `terminal-bench-2-apa-notify` job block**

Remove everything from the comment:

```yaml
# TEMP: disabled until APA backend supports benchmark-summary/v2 schema
terminal-bench-2-apa-notify:
```

through the end of that job definition (the block ends before the next top-level key).

- [ ] **Step 4.2: Validate the YAML**

Run:

```bash
cd /Users/jose/reps/kimchi-gitlab
python3 -c "import yaml; yaml.safe_load(open('.gitlab/ci/terminal-bench-2.yml'))"
```

Expected: command exits 0 with no output.

- [ ] **Step 4.3: Commit the removal**

```bash
git add .gitlab/ci/terminal-bench-2.yml
git commit -m "chore(ci): remove disabled APA notify job"
```

---

## Task 5: Final verification

- [ ] **Step 5.1: Run the full benchmark script test suite**

```bash
cd /Users/jose/reps/kimchi-gitlab/benchmark/scripts/gitlab
python3 -m pytest tests/ -v
```

Expected: all tests pass.

- [ ] **Step 5.2: Lint and typecheck if applicable**

If a linter is configured for the benchmark scripts (check `Makefile`, `pyproject.toml`, or CI):

```bash
python3 -m ruff check benchmark/scripts/gitlab
python3 -m mypy benchmark/scripts/gitlab/summarize_results.py
```

If those tools are not configured, skip.

- [ ] **Step 5.3: Final commit if any fixes were needed**

If lint/type fixes were applied:

```bash
git add -u
git commit -m "chore(benchmark): lint fixes"
```

---

## Self-review

### Spec coverage

| Requirement from user | Task |
|---|---|
| Create accurate `benchmark/schemas/benchmark-summary-v2.schema.json` | Task 1 |
| Fix inaccuracies (run status, totals, nullable error, source fields) | Task 2 |
| Keep trial `status` field for SQL view compatibility | Task 2 / Task 3.1 |
| Remove APA notify job | Task 4 |
| Tests and validation | Task 3, Task 5 |

### Placeholder scan

- No `TBD`, `TODO`, or "implement later" strings.
- Every code change includes the exact code block.
- Every command includes expected behavior.
- Type and field names (`trials_recorded`, `tasks_expected`, `run_status`, `_nonempty_or_none`) are consistent across tasks.

### Type consistency

- `run.status` enum in schema (`["completed", "partial"]`) matches `run_status()` return values.
- `verdict` enum in schema matches `Outcome` values.
- Trial `status` remains emitted and required for backward compatibility with the `dwh.kimchi_benchmark_runs` ClickHouse view.
- `error` is `object | null` in schema and returns `dict | None` in code.
- `source.gitlab.ref` and `commit_sha` are `string | null` in schema and returned as `str | None` in code.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-benchmark-summary-v2-schema.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
