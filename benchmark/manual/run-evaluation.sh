#!/bin/zsh
set -euo pipefail

# run-evaluation.sh
#
# Generate a new benchmark/manual session, run selected tasks in separate
# iTerm2 tabs, wait for completion, then run a session audit on each using
# the kimchi harness with kimi-k2.6.
#
# Usage:
#   ./run-evaluation.sh                          # run default tasks (complex, mega)
#   ./run-evaluation.sh complex
#   ./run-evaluation.sh complex mega

SCRIPT_DIR="${0:A:h}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AUDIT_SCRIPT="${SCRIPT_DIR}/../audit-session/audit-session.sh"
SESSIONS_DIR="${SCRIPT_DIR}/sessions"

# --- Verify dependencies ---
if [[ ! -f "$AUDIT_SCRIPT" ]]; then
  echo "ERROR: audit-session.sh not found at: $AUDIT_SCRIPT" >&2
  exit 1
fi

which osascript &>/dev/null || { echo "ERROR: osascript not found. This script requires macOS." >&2; exit 1; }

# --- Parse CLI arguments ---
REQUESTED_TASKS=("$@")

# --- Step 1: Create a new session ---
echo "=== Creating new benchmark session ==="
cd "$SCRIPT_DIR"
"${SCRIPT_DIR}/new-session.sh"

# Find the newest session directory
if [[ ! -d "$SESSIONS_DIR" ]]; then
  echo "ERROR: No sessions directory found at $SESSIONS_DIR" >&2
  exit 1
fi
SESSION_DIR=$(ls -dt "${SESSIONS_DIR}"/session-* 2>/dev/null | head -1)
if [[ -z "$SESSION_DIR" ]]; then
  echo "ERROR: No session directory found" >&2
  exit 1
fi
SESSION_NAME=$(basename "$SESSION_DIR")
echo "Using session: $SESSION_NAME  ($SESSION_DIR)"

# --- Determine which tasks to run ---
RUNS_DIR="${SESSION_DIR}/runs"
if [[ ! -d "$RUNS_DIR" ]]; then
  echo "ERROR: No runs directory found at $RUNS_DIR" >&2
  exit 1
fi

AVAILABLE_TASKS=("$RUNS_DIR"/*(/:t))
if (( ${#AVAILABLE_TASKS[@]} == 0 )); then
  echo "ERROR: No tasks found in $RUNS_DIR" >&2
  exit 1
fi

if (( ${#REQUESTED_TASKS[@]} == 0 )); then
  TASKS=(complex mega)
else
  TASKS=("${REQUESTED_TASKS[@]}")
fi

# Validate requested tasks
for task in "${TASKS[@]}"; do
  if [[ ! -d "$RUNS_DIR/$task" ]]; then
    echo "ERROR: Task '$task' not found in $RUNS_DIR" >&2
    exit 1
  fi
done

echo ""
echo "Tasks selected: ${(j:, :)TASKS}"
echo ""

# --- Step 2: Run selected tasks in separate iTerm2 tabs ---
for task in "${TASKS[@]}"; do
  TASK_SCRIPT="${SESSION_DIR}/run-${task}.sh"
  if [[ ! -f "$TASK_SCRIPT" ]]; then
    echo "ERROR: Missing run script: $TASK_SCRIPT" >&2
    exit 1
  fi
done

echo "=== Spawning iTerm2 tabs ==="

if ! osascript -e 'id of application "iTerm2"' &>/dev/null; then
  echo "ERROR: iTerm2 is not running. Please start iTerm2 first." >&2
  exit 1
fi

for task in "${TASKS[@]}"; do
  task_script="${SESSION_DIR}/run-${task}.sh"
  task_script_escaped=${task_script//\"/\\\"}
  osascript <<EOF
tell application "iTerm2"
  tell current window
    set taskTab to (create tab with default profile)
    tell taskTab
      tell current session
        write text "${task_script_escaped}"
      end tell
    end tell
  end tell
end tell
EOF
done

echo "iTerm2 tabs spawned. Commands are running in the background."

# --- Step 3: Poll until runs complete ---
echo "=== Waiting for runs to complete (poll every 60s, max 90 min) ==="
echo ""

for ((i = 1; i <= 90; i++)); do
  echo "--- Poll $i/90 ---"
  if python3 "${SCRIPT_DIR}/check-session.py" "$SESSION_NAME" "${TASKS[@]}" 2>&1; then
    echo "=== All runs finished ==="
    break
  fi
  sleep 60
done

# --- Step 4: Find the JSONL files for each run ---
declare -A JSONL_FILES
for task in "${TASKS[@]}"; do
  local jsonls=("${SESSION_DIR}/runs/${task}"/session-*.jsonl(NOm))
  if (( ${#jsonls} == 0 )); then
    echo "ERROR: No session JSONL found for $task" >&2
    exit 1
  fi
  JSONL_FILES["$task"]=$jsonls[1]
done

echo ""
for task in "${TASKS[@]}"; do
  echo "${task} session: ${JSONL_FILES["$task"]}"
done

# --- Step 5: Run audits with Claude Opus 4.6 in separate iTerm2 tabs ---
echo "=== Spawning iTerm2 tabs for audits ==="

# Create audits directory and declare known audit session file paths.
mkdir -p "${SESSION_DIR}/audits"
declare -A AUDIT_SESSION_FILES
for task in "${TASKS[@]}"; do
  jsonl_basename=$(basename "${JSONL_FILES["$task"]}")
  session_id="${jsonl_basename%.jsonl}"
  AUDIT_SESSION_FILES["$task"]="${SESSION_DIR}/audits/audit-${session_id}.jsonl"
done

for task in "${TASKS[@]}"; do
  audit_cmd="cd \"$REPO_ROOT\" && \"$AUDIT_SCRIPT\" -m kimchi-dev/claude-opus-4-6 -s \"${AUDIT_SESSION_FILES["$task"]}\" \"${JSONL_FILES["$task"]}\""
  audit_cmd_escaped=${audit_cmd//\"/\\\"}
  osascript <<EOF
tell application "iTerm2"
  tell current window
    set auditTab to (create tab with default profile)
    tell auditTab
      tell current session
        write text "${audit_cmd_escaped}"
      end tell
    end tell
  end tell
end tell
EOF
done

echo "Audit tabs spawned in iTerm2."

# --- Step 6: Poll until audits complete ---
echo "=== Waiting for audits to complete (poll every 30s, max 60 min) ==="
echo ""

for ((i = 1; i <= 120; i++)); do
  echo "--- Audit poll $i/120 ---"
  audit_jsonl_paths=()
  for task in "${TASKS[@]}"; do
    audit_jsonl_paths+=("${AUDIT_SESSION_FILES["$task"]}")
  done
  if python3 "${SCRIPT_DIR}/check-session.py" --jsonl "${audit_jsonl_paths[@]}" 2>&1; then
    echo "=== All audits finished ==="
    break
  fi
  sleep 30
done

if ! python3 "${SCRIPT_DIR}/check-session.py" --jsonl "${audit_jsonl_paths[@]}" 2>&1; then
  echo "WARNING: Timed out waiting for audits. Check iTerm2 tabs for status." >&2
fi

echo ""
echo "========================================"
echo "All tasks complete!"
echo "Session:     $SESSION_DIR"
echo "Audit reports should be in: ${REPO_ROOT}/.kimchi/audits/"
echo "========================================"