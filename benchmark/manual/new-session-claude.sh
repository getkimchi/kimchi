#!/bin/zsh
set -e

IMPROVEMENT_DIR="${0:A:h}"
source "${IMPROVEMENT_DIR}/lib.sh"

SESSIONS_DIR="$IMPROVEMENT_DIR/sessions"
EXPLORE_SEED="$IMPROVEMENT_DIR/seeds/explore-refactor"
CLAUDE_BIN=$(which claude 2>/dev/null || true)

if [[ -z "$CLAUDE_BIN" ]]; then
  echo "claude CLI not found in PATH"
  exit 1
fi

mkdir -p "$SESSIONS_DIR"

SESSION_DIR=$(bench_next_session_dir "$SESSIONS_DIR")
N=$(basename "$SESSION_DIR" | grep -oE '[0-9]+$')

echo "Available tasks:"
echo ""
for i in {1..${#BENCH_TASKS[@]}}; do
  task="${BENCH_TASKS[$i]}"
  label="${BENCH_TASK_LABELS[$task]}"
  echo "  $i) $label"
done
echo ""
echo "Enter task numbers separated by spaces (e.g. '1 3 4'), or 'all':"
read -r SELECTION

SELECTED=()
if [[ "$SELECTION" == "all" ]]; then
  for i in {1..${#BENCH_TASKS[@]}}; do
    SELECTED+=($i)
  done
else
  for tok in ${=SELECTION}; do
    if (( tok >= 1 && tok <= ${#BENCH_TASKS[@]} )); then
      SELECTED+=($tok)
    else
      echo "Invalid task number: $tok"
      exit 1
    fi
  done
fi

if [[ ${#SELECTED[@]} -eq 0 ]]; then
  echo "No tasks selected."
  exit 0
fi

echo ""
echo "Creating $(basename "$SESSION_DIR") with ${#SELECTED[@]} task(s)..."

ALL_SCRIPTS=()

for idx in "${SELECTED[@]}"; do
  task="${BENCH_TASKS[$idx]}"
  run_dir="claude-$task"
  mkdir -p "$SESSION_DIR/runs/$run_dir"

  slug="s${N}-claude-${task}"
  script_path="$SESSION_DIR/run-claude-${task}.sh"

  bench_generate_runner_script \
    "$script_path" \
    "claude" \
    "$task" \
    "claude" \
    "$SESSION_DIR" \
    "$N" \
    "$CLAUDE_BIN" \
    "claude-${slug}"

  ALL_SCRIPTS+=("$script_path")
  echo "  created: run-claude-${task}.sh"
done

RUN_ALL="$SESSION_DIR/run-all-claude.sh"
bench_generate_run_all_script "$RUN_ALL" "${ALL_SCRIPTS[@]}"
echo "  created: run-all-claude.sh"

echo ""
echo "Done. ${#ALL_SCRIPTS[@]} script(s) created in $SESSION_DIR/"
echo "Next: run individual scripts or run-all-claude.sh"