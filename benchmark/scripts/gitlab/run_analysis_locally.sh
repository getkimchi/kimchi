#!/usr/bin/env bash
# run_analysis_locally.sh — Fetch artifacts from a failed pipeline, run the
# benchmark session analysis locally, validate the output, and optionally
# upload it to GCS.
#
# Usage:
#   ./benchmark/scripts/gitlab/run_analysis_locally.sh <pipeline_id> [--upload]
#
# Prerequisites:
#   - glab CLI authenticated
#   - kimchi binary on PATH (or set KIMCHI_CODE_BINARY)
#   - gcloud CLI authenticated (only needed with --upload)
#   - BENCHMARK_GCS_BUCKET env var (only needed with --upload)
#
# What it does:
#   1. Lists jobs in the pipeline, finds chunk + summary jobs
#   2. Downloads and extracts their artifacts into a temp work dir
#   3. Runs analyze_sessions.py with the local kimchi binary
#   4. Validates the produced HTML report
#   5. With --upload, uploads to GCS using the run metadata's gcs.prefix

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <pipeline_id> [--upload]" >&2
  exit 1
fi

PIPELINE_ID="$1"
UPLOAD=false
[[ "${2:-}" == "--upload" ]] && UPLOAD=true

PROJECT_ID="82797533"  # castai/kimchi/kimchi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ANALYZE_SCRIPT="$SCRIPT_DIR/analyze_sessions.py"
WORK_DIR="$(mktemp -d -t "analysis-${PIPELINE_ID}-XXXXXX")"
FINAL_REPORT="$(pwd)/analysis-${PIPELINE_ID}.html"

cleanup() {
  if [[ -f "$WORK_DIR/repo/.benchmark/analysis.html" ]]; then
    cp "$WORK_DIR/repo/.benchmark/analysis.html" "$FINAL_REPORT"
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Pipeline $PIPELINE_ID — local analysis ==="
echo "Work dir:      $WORK_DIR"
echo "Final report:  $FINAL_REPORT"
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
echo ">> Running Kimchi analysis..."
echo "   This may take up to 1 hour. The analysis runs with the same prompt"
echo "   and model used in CI (kimchi-dev/glm-5.2-fp8)."
echo ""

cd "$WORK_DIR/repo"

export BENCHMARK_RESULTS_DIR="$RESULTS_REL"
export BENCHMARK_SUMMARY_PATH=".benchmark/summary.json"
export BENCHMARK_ANALYSIS_OUTPUT=".benchmark/analysis.html"
export BENCHMARK_ANALYSIS_DRAFT=".benchmark/analysis-work/report.html"
export BENCHMARK_ANALYSIS_SESSION_DIR="$WORK_DIR/analysis-session"
export KIMCHI_ANALYSIS_TIMEOUT_SECONDS="3600"
export KIMCHI_ANALYSIS_MAX_RETRIES="2"
export KIMCHI_ANALYSIS_MODEL="kimchi-dev/glm-5.2-fp8"

ANALYSIS_OUTPUT="$WORK_DIR/repo/.benchmark/analysis.html"
DRAFT_PATH="$WORK_DIR/repo/.benchmark/analysis-work/report.html"

# Don't let set -e kill us here — we want to check the result ourselves
# analyze_sessions.py and its sibling prompt files live in the repo, not in
# the downloaded artifacts — use absolute paths so it can find them.
python3 "$ANALYZE_SCRIPT" || true
ANALYSIS_EXIT=$?

echo ""
echo ">> Analysis exit code: $ANALYSIS_EXIT"

# ---------------------------------------------------------------------------
# 4. Validate the output
# ---------------------------------------------------------------------------
echo ">> Validating output..."

if [[ ! -f "$ANALYSIS_OUTPUT" ]]; then
  echo "WARNING: analysis.html was not produced at the expected path" >&2
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

  DESTINATION="gs://$BUCKET/$GCS_PREFIX/analysis.html"
  echo "   Destination: $DESTINATION"
  gcloud storage cp "$ANALYSIS_OUTPUT" "$DESTINATION" --quiet
  echo "   analysis.html uploaded"

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
