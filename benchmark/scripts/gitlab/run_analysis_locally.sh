#!/usr/bin/env bash
# run_analysis_locally.sh — Fetch artifacts from a pipeline, run the
# benchmark session analysis locally, validate the output, and optionally
# upload it to GCS.
#
# Usage:
#   ./benchmark/scripts/gitlab/run_analysis_locally.sh <pipeline_id> [--timeouts] [--upload]
#
# Flags:
#   --timeouts  Run the timeout deep-dive analysis instead of the general analysis.
#   --upload    Upload the result to GCS after validation.
#
# Prerequisites:
#   - glab CLI authenticated
#   - kimchi binary on PATH (or set KIMCHI_CODE_BINARY)
#   - gcloud CLI authenticated (only needed with --upload)
#   - BENCHMARK_GCS_BUCKET env var (only needed with --upload)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <pipeline_id> [--timeouts] [--upload]" >&2
  exit 1
fi

PIPELINE_ID="$1"
shift || true
TIMEOUTS_ONLY=false
UPLOAD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeouts) TIMEOUTS_ONLY=true; shift ;;
    --upload)   UPLOAD=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

PROJECT_ID="82797533"  # castai/kimchi/kimchi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if $TIMEOUTS_ONLY; then
  ANALYZE_SCRIPT="$SCRIPT_DIR/analyze_timeouts.py"
  ANALYSIS_ENV_FILE=".benchmark/timeout-analysis.html"
  DRAFT_ENV_FILE=".benchmark/timeout-analysis-work/report.html"
  SESSION_ENV_NAME="BENCHMARK_TIMEOUT_ANALYSIS_SESSION_DIR"
  FINAL_REPORT="$(pwd)/timeout-analysis-${PIPELINE_ID}.html"
  FINAL_EVIDENCE="$(pwd)/timeout-evidence-${PIPELINE_ID}.json"
  GCS_FILENAME="timeout-analysis.html"
  ANALYSIS_LABEL="timeout deep-dive"
  ANALYSIS_TIMEOUT="5400"  # 90 min
else
  ANALYZE_SCRIPT="$SCRIPT_DIR/analyze_sessions.py"
  ANALYSIS_ENV_FILE=".benchmark/analysis.html"
  DRAFT_ENV_FILE=".benchmark/analysis-work/report.html"
  SESSION_ENV_NAME="BENCHMARK_ANALYSIS_SESSION_DIR"
  FINAL_REPORT="$(pwd)/analysis-${PIPELINE_ID}.html"
  FINAL_EVIDENCE=""
  GCS_FILENAME="analysis.html"
  ANALYSIS_LABEL="general session"
  ANALYSIS_TIMEOUT="3600"  # 60 min
fi

WORK_DIR="$(mktemp -d -t "analysis-${PIPELINE_ID}-XXXXXX")"

cleanup() {
  if [[ -f "$WORK_DIR/repo/$ANALYSIS_ENV_FILE" ]]; then
    cp "$WORK_DIR/repo/$ANALYSIS_ENV_FILE" "$FINAL_REPORT"
  fi
  if [[ -n "$FINAL_EVIDENCE" && -f "$WORK_DIR/repo/.benchmark/timeout-evidence.json" ]]; then
    cp "$WORK_DIR/repo/.benchmark/timeout-evidence.json" "$FINAL_EVIDENCE"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Pipeline $PIPELINE_ID — local ${ANALYSIS_LABEL} analysis ==="
echo "Work dir:      $WORK_DIR"
echo "Final report:  $FINAL_REPORT"
if [[ -n "$FINAL_EVIDENCE" ]]; then
  echo "Evidence JSON: $FINAL_EVIDENCE"
fi
echo ""

# ---------------------------------------------------------------------------
# 1. Discover jobs in the pipeline
# ---------------------------------------------------------------------------
echo ">> Discovering pipeline jobs..."

JOBS_JSON="$WORK_DIR/jobs.json"
glab api "projects/$PROJECT_ID/pipelines/$PIPELINE_ID/jobs" > "$JOBS_JSON" 2>/dev/null

# Save chunk and summary job IDs to files so we can iterate without shell escaping issues
python3 -c "
import json
with open('$JOBS_JSON') as f:
    jobs = json.load(f)
chunks = []
summary = None
for j in jobs:
    name = j.get('name', '')
    status = j.get('status', '')
    if 'chunks' in name and status in ('success', 'failed'):
        chunks.append((j['id'], name))
    elif 'summary' in name and status == 'success':
        summary = (j['id'], name)

if not summary:
    print('ERROR: No successful summary job found in pipeline $PIPELINE_ID', flush=True)
    raise SystemExit(1)

with open('$WORK_DIR/chunk_jobs.txt', 'w') as f:
    for jid, name in chunks:
        f.write(f'{jid} {name}\n')
with open('$WORK_DIR/summary_job.txt', 'w') as f:
    f.write(f'{summary[0]} {summary[1]}\n')

print(f'   Summary: {summary[1]} ({summary[0]})')
print('   Chunks:')
for jid, name in chunks:
    print(f'     - {name} ({jid})')
"

echo ""

# ---------------------------------------------------------------------------
# 2. Download and extract artifacts
# ---------------------------------------------------------------------------
echo ">> Downloading artifacts..."

mkdir -p "$WORK_DIR/repo"

# Summary artifacts
SUMMARY_JOB_ID=$(awk '{print $1}' "$WORK_DIR/summary_job.txt")
SUMMARY_ZIP="$WORK_DIR/summary-artifacts.zip"
glab api "projects/$PROJECT_ID/jobs/$SUMMARY_JOB_ID/artifacts" > "$SUMMARY_ZIP" 2>/dev/null
if [[ ! -s "$SUMMARY_ZIP" ]]; then
  echo "ERROR: Failed to download summary artifacts" >&2
  exit 1
fi
unzip -q -o "$SUMMARY_ZIP" -d "$WORK_DIR/repo"
echo "   Summary artifacts extracted"

# Chunk artifacts
while IFS= read -r line; do
  jid=$(echo "$line" | awk '{print $1}')
  jname=$(echo "$line" | awk '{$1=""; print $0}' | sed 's/^ //')
  CHUNK_ZIP="$WORK_DIR/chunk-${jid}.zip"
  echo "   Downloading chunk $jname ($jid)..."
  glab api "projects/$PROJECT_ID/jobs/$jid/artifacts" > "$CHUNK_ZIP" 2>/dev/null
  if [[ -s "$CHUNK_ZIP" ]]; then
    unzip -q -o "$CHUNK_ZIP" -d "$WORK_DIR/repo"
    echo "     extracted"
  else
    echo "     WARNING: no artifacts (job may have failed before producing any)"
  fi
done < "$WORK_DIR/chunk_jobs.txt"
echo ""

# Verify we have the expected files
SUMMARY_PATH="$WORK_DIR/repo/.benchmark/summary.json"
METADATA_PATH="$WORK_DIR/repo/.benchmark/run-metadata.json"

if [[ ! -f "$SUMMARY_PATH" ]]; then
  echo "ERROR: summary.json not found in summary artifacts" >&2
  exit 1
fi
if [[ ! -f "$METADATA_PATH" ]]; then
  echo "ERROR: run-metadata.json not found in summary artifacts" >&2
  exit 1
fi

# Find the results directory (terminal-bench-2, terminal-bench-2-1, etc.)
RESULTS_DIR=$(find "$WORK_DIR/repo/benchmark" -maxdepth 1 -type d -name 'terminal-bench-*' -print -quit)
if [[ -z "$RESULTS_DIR" ]]; then
  echo "ERROR: No benchmark results directory found in artifacts" >&2
  exit 1
fi

RESULTS_REL="${RESULTS_DIR#$WORK_DIR/repo/}"
SESSION_COUNT=$(find "$RESULTS_DIR" -name '*.jsonl' -path '*/agent/sessions/*' | wc -l | tr -d ' ')

# Parse summary stats
SUMMARY_STATS=$(python3 -c "
import json
s = json.load(open('$SUMMARY_PATH'))
t = s.get('totals', {}).get('trials', {})
print(f\"{t.get('scored_pass', '?')}/{t.get('recorded', '?')} passed, {t.get('scored_fail', '?')} failed, {t.get('agent_timeout', '?')} timeout\")
" 2>/dev/null || echo "(could not parse)")

echo ">> Results directory: $RESULTS_REL"
echo "   Session files: $SESSION_COUNT"
echo "   Summary: $SUMMARY_STATS"
echo ""

if [[ "$SESSION_COUNT" -eq 0 ]]; then
  echo "ERROR: No session files found; nothing to analyze" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Run the analysis
# ---------------------------------------------------------------------------
echo ">> Running Kimchi ${ANALYSIS_LABEL} analysis..."
echo "   This may take a while. The analysis runs with the same prompt"
echo "   and model used in CI (kimchi-dev/glm-5.2-fp8)."
echo ""

cd "$WORK_DIR/repo"

export BENCHMARK_RESULTS_DIR="$RESULTS_REL"
export BENCHMARK_SUMMARY_PATH=".benchmark/summary.json"
export KIMCHI_ANALYSIS_TIMEOUT_SECONDS="$ANALYSIS_TIMEOUT"
export KIMCHI_ANALYSIS_MAX_RETRIES="2"
export KIMCHI_ANALYSIS_MODEL="kimchi-dev/glm-5.2-fp8"

ANALYSIS_OUTPUT="$WORK_DIR/repo/$ANALYSIS_ENV_FILE"
DRAFT_PATH="$WORK_DIR/repo/$DRAFT_ENV_FILE"

if $TIMEOUTS_ONLY; then
  export BENCHMARK_TIMEOUT_ANALYSIS_OUTPUT="$ANALYSIS_ENV_FILE"
  export BENCHMARK_TIMEOUT_ANALYSIS_DRAFT="$DRAFT_ENV_FILE"
  export BENCHMARK_TIMEOUT_EVIDENCE=".benchmark/timeout-evidence.json"
  export "$SESSION_ENV_NAME"="$WORK_DIR/timeout-analysis-session"
else
  export BENCHMARK_ANALYSIS_OUTPUT="$ANALYSIS_ENV_FILE"
  export BENCHMARK_ANALYSIS_DRAFT="$DRAFT_ENV_FILE"
  export "$SESSION_ENV_NAME"="$WORK_DIR/analysis-session"
fi

# Don't let set -e kill us here — we want to check the result ourselves
# analyze scripts and their sibling prompt files live in the repo, not in
# the downloaded artifacts — use absolute paths so they can find them.
python3 "$ANALYZE_SCRIPT" || true
ANALYSIS_EXIT=$?

echo ""
echo ">> Analysis exit code: $ANALYSIS_EXIT"

# ---------------------------------------------------------------------------
# 4. Validate the output
# ---------------------------------------------------------------------------
echo ">> Validating output..."

if [[ ! -f "$ANALYSIS_OUTPUT" ]]; then
  echo "WARNING: output was not produced at the expected path" >&2
  # Check if draft exists as fallback (same bug as CI: Kimchi finished but
  # the script was killed before copying draft → final)
  if [[ -f "$DRAFT_PATH" ]]; then
    echo "   Draft report exists at $DRAFT_PATH"
    echo "   Draft size: $(wc -c < "$DRAFT_PATH") bytes"
    echo "   Copying draft to final output..."
    cp "$DRAFT_PATH" "$ANALYSIS_OUTPUT"
  else
    echo "ERROR: No draft report found either." >&2
    exit 1
  fi
fi

HTML_SIZE=$(wc -c < "$ANALYSIS_OUTPUT")
HTML_FIRST=$(head -c 20 "$ANALYSIS_OUTPUT")
echo "   Output: $ANALYSIS_OUTPUT"
echo "   Size: $HTML_SIZE bytes"
echo "   Starts with: $HTML_FIRST"

# Validate HTML structure (same checks as analyze_sessions.py)
python3 -c "
import re, sys
content = open('$ANALYSIS_OUTPUT').read().strip()
errors = []
lowered = content.lower()
if not lowered.startswith('<!doctype html'):
    errors.append('must start with <!doctype html>')
if '<html' not in lowered or '</html>' not in lowered:
    errors.append('missing complete <html> document')
if '<body' not in lowered or '</body>' not in lowered:
    errors.append('missing complete <body> element')
if '<script' in lowered:
    errors.append('must not contain scripts')
if re.search(r'<(?:iframe|object|embed|link)\b', lowered):
    errors.append('must not contain embedded resources')
if re.search(r'\son[a-z]+\s*=', lowered):
    errors.append('must not contain inline event handlers')
if errors:
    print('VALIDATION FAILED:')
    for e in errors:
        print(f'  - {e}')
    sys.exit(1)
print('VALID: HTML report passes all checks')
" || exit 1

echo ""

# ---------------------------------------------------------------------------
# 5. Report location (the EXIT trap copies it to FINAL_REPORT)
# ---------------------------------------------------------------------------
echo ">> Report will be saved to: $FINAL_REPORT"

# ---------------------------------------------------------------------------
# 6. Optional: Upload to GCS
# ---------------------------------------------------------------------------
if $UPLOAD; then
  echo ""
  echo ">> Uploading to GCS..."

  if ! command -v gcloud &>/dev/null; then
    echo "ERROR: gcloud CLI not found; cannot upload" >&2
    exit 1
  fi

  BUCKET="${BENCHMARK_GCS_BUCKET:-}"
  if [[ -z "$BUCKET" ]]; then
    echo "ERROR: BENCHMARK_GCS_BUCKET env var not set" >&2
    exit 1
  fi

  GCS_PREFIX=$(python3 -c "
import json
m = json.load(open('$METADATA_PATH'))
gcs = m.get('gcs', {})
print(gcs.get('prefix', ''))
")

  if [[ -z "$GCS_PREFIX" ]]; then
    echo "ERROR: No gcs.prefix found in run-metadata.json" >&2
    exit 1
  fi

  DESTINATION="gs://$BUCKET/$GCS_PREFIX/$GCS_FILENAME"
  echo "   Destination: $DESTINATION"
  gcloud storage cp "$ANALYSIS_OUTPUT" "$DESTINATION" --quiet
  echo "   $GCS_FILENAME uploaded"

fi

# Copy now so the trap has it even if something goes wrong after
cp "$ANALYSIS_OUTPUT" "$FINAL_REPORT"

echo ""
echo "=== Done ==="
echo "Pipeline:  $PIPELINE_ID"
echo "Report:    $FINAL_REPORT"
echo "Size:      $HTML_SIZE bytes"
if $UPLOAD; then
  echo "Uploaded:  yes"
else
  echo "Uploaded:  no (pass --upload to upload to GCS)"
fi
