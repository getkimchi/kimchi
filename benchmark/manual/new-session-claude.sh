#!/bin/zsh
set -e

IMPROVEMENT_DIR="${0:A:h}"
SESSIONS_DIR="$IMPROVEMENT_DIR/sessions"
EXPLORE_SEED="$IMPROVEMENT_DIR/seeds/explore-refactor"
CLAUDE_BIN=$(which claude 2>/dev/null || true)

if [[ -z "$CLAUDE_BIN" ]]; then
  echo "claude CLI not found in PATH"
  exit 1
fi

mkdir -p "$SESSIONS_DIR"

LAST=$(ls -d "$SESSIONS_DIR"/session-* 2>/dev/null | grep -oE '[0-9]+$' | sort -n | tail -1)
N=$(( ${LAST:-0} + 1 ))
SESSION="session-$(printf '%02d' $N)"
SESSION_DIR="$SESSIONS_DIR/$SESSION"

TASKS=(
  "simple:Go HTTP Rate Limiter Middleware"
  "complex:Go REST API Task Management"
  "complex-single:Go REST API (single model)"
  "research:Most popular Go HTTP router libraries"
  "explore:Add input validation to existing Go API"
  "mega:Go Concurrent Build System"
)

echo "Available tasks:"
echo ""
for i in {1..${#TASKS[@]}}; do
  label="${TASKS[$i]#*:}"
  echo "  $i) $label"
done
echo ""
echo "Enter task numbers separated by spaces (e.g. '1 3 4'), or 'all':"
read -r SELECTION

SELECTED=()
if [[ "$SELECTION" == "all" ]]; then
  for i in {1..${#TASKS[@]}}; do
    SELECTED+=($i)
  done
else
  for tok in ${=SELECTION}; do
    if (( tok >= 1 && tok <= ${#TASKS[@]} )); then
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
echo "Creating $SESSION with ${#SELECTED[@]} task(s)..."

SIMPLE_PROMPT='Implement a Go HTTP middleware that rate-limits requests per client IP using a token bucket algorithm. Requirements: Each IP gets 10 requests per second. Respond with HTTP 429 when limit is exceeded. Thread-safe implementation. Include tests with map-based test cases. Put the code in directory: $DIR/rate-limiter/. Include a README.md explaining usage.'

COMPLEX_PROMPT='Implement a Go REST API for a task management system. This is a multi-layer project — start with a plan before writing any code. Requirements: Use standard library only (no frameworks, no external dependencies). Layered architecture: handler -> service -> repository. In-memory repository. Endpoints: POST /tasks (create, fields: title+description), GET /tasks (list all), GET /tasks/{id} (get by id), PATCH /tasks/{id} (update status: todo/in-progress/done), DELETE /tasks/{id} (delete). Proper HTTP status codes and JSON responses. Unit tests for the service layer using map-based test cases. Put all code in directory: $DIR/task-api/'

RESEARCH_PROMPT='What are the most popular third-party HTTP router libraries for Go? List the top 3 with: GitHub stars (approximate), key differentiators, and a one-line example of defining a route with a path parameter.'

EXPLORE_PROMPT='The directory $DIR/usermgmt/ contains an existing Go HTTP API for user and team management. Explore the codebase, find all HTTP handlers that are missing input validation, and fix them. Requirements: - First explore the entire codebase to build a map of all handlers and their validation status. - Write a plan listing every handler endpoint, what validation is missing, and what you will add. - Implement the validation fixes. Specific issues to find and fix:   - Handlers that accept arbitrary strings for fields with a fixed set of valid values (e.g. roles)   - Handlers that accept zero or negative integers for fields that must be positive   - Handlers that accept empty strings for required fields at the HTTP layer (even if the service layer also checks)   - Search/filter endpoints with no length limit on query parameters   - Pagination parameters with no bounds checking (negative offsets, excessively large limits) - Add unit tests for the validation logic using map-based test cases. - Do not change the project structure or add external dependencies.'

MEGA_PROMPT='Implement a Go CLI application that acts as a concurrent build system, similar to a simplified Make. This is a multi-layer project — start with a plan before writing any code. Requirements: Use standard library only (no frameworks, no external dependencies). Parse a declarative build file (buildfile.txt) with this format:
    target: dep1 dep2
        command1
        command2
Indented lines under a target are shell commands. Dependencies are space-separated after the colon. Resolve the full dependency graph using topological sort. Detect and report cycles with a clear error message listing the cycle path. Execute independent targets concurrently using a worker pool. Targets whose dependencies are all satisfied should start immediately. Stream command output per target with prefixed labels, e.g. '"'"'[compile] go build ./...'"'"'. Graceful shutdown on SIGINT: finish in-progress targets, skip pending ones, print a summary of what completed and what was skipped. CLI flags: -f <file> (build file path, default: buildfile.txt), -j <N> (max parallel workers, default: number of CPUs), -target <name> (build a specific target and its transitive deps only, default: build all root targets). Fail fast: on the first target error, cancel pending targets and report which target and command failed. Layered architecture: separate packages for parsing, graph resolution, execution engine, and CLI. Unit tests for: build file parsing (valid and malformed input), dependency resolution (diamond deps, cycle detection, single target extraction), and execution ordering (verify concurrency-safe ordering). Use map-based test cases. Put all code in directory: $DIR/buildtool/'

ALL_SCRIPTS=()

for idx in "${SELECTED[@]}"; do
  entry="${TASKS[$idx]}"
  task="${entry%%:*}"
  run_dir="claude-$task"
  mkdir -p "$SESSION_DIR/runs/$run_dir"

  slug="s${N}-claude-${task}"
  script_path="$SESSION_DIR/run-claude-${task}.sh"

  case "$task" in
    simple)         PROMPT="$SIMPLE_PROMPT" ;;
    complex)        PROMPT="$COMPLEX_PROMPT" ;;
    complex-single) PROMPT="$COMPLEX_PROMPT" ;;
    research)       PROMPT="$RESEARCH_PROMPT" ;;
    explore)        PROMPT="$EXPLORE_PROMPT" ;;
    mega)           PROMPT="$MEGA_PROMPT" ;;
  esac

  SETUP=""
  if [[ "$task" == "explore" ]]; then
    SETUP='mkdir -p "$DIR/usermgmt" && cp -R "'"$EXPLORE_SEED"'/"* "$DIR/usermgmt/"'
  fi

  cat > "$script_path" <<SCRIPT
#!/bin/zsh
DIR=\$(mktemp -d /private/tmp/claude-${slug}-XXXXXX)
echo "Working directory: \$DIR"
cd "\$DIR"
${SETUP:+$SETUP
}claude \\
  --dangerously-skip-permissions \\
  --model opus \\
  "$PROMPT"
SCRIPT

  chmod +x "$script_path"
  ALL_SCRIPTS+=("$script_path")
  echo "  created: run-claude-${task}.sh"
done

if [[ ${#ALL_SCRIPTS[@]} -gt 1 ]]; then
  RUN_ALL="$SESSION_DIR/run-all-claude.sh"

  AS_LINES=()
  AS_LINES+=("      set g0 to current session of newTab")
  for (( i=1; i<${#ALL_SCRIPTS[@]}; i++ )); do
    AS_LINES+=("      set g${i} to (split vertically with default profile of g$(( i-1 )))")
  done
  for (( i=0; i<${#ALL_SCRIPTS[@]}; i++ )); do
    local idx=$(( i + 1 ))
    AS_LINES+=("      tell g${i} to write text \"${ALL_SCRIPTS[$idx]}\"")
  done

  AS_BODY=$(printf '%s\n' "${AS_LINES[@]}")

  BG_LINES=()
  for script in "${ALL_SCRIPTS[@]}"; do
    name=$(basename "$script" .sh)
    BG_LINES+=("  \"$script\" >\"$SESSION_DIR/${name}.log\" 2>&1 &")
  done
  BG_BODY=$(printf '%s\n' "${BG_LINES[@]}")

  cat > "$RUN_ALL" <<RUNALL
#!/bin/zsh
if osascript -e 'id of application "iTerm2"' &>/dev/null 2>&1; then
  osascript <<APPLESCRIPT
tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell newTab
${AS_BODY}
    end tell
  end tell
end tell
APPLESCRIPT
else
  echo "iTerm2 not available — running ${#ALL_SCRIPTS[@]} scripts in background (logs in $SESSION_DIR/)..."
${BG_BODY}
  wait
  echo "All done."
fi
RUNALL
  chmod +x "$RUN_ALL"
  echo "  created: run-all-claude.sh"
fi

echo ""
echo "Done. ${#ALL_SCRIPTS[@]} script(s) created in $SESSION_DIR/"
echo "Next: run individual scripts or run-all-claude.sh"
