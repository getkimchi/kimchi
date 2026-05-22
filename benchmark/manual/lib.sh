#!/bin/zsh
# Shared library for benchmark/manual scripts
# Source from new-session.sh and new-session-claude.sh

# ---------------------------------------------------------------------------
# Task prompts
# ---------------------------------------------------------------------------

BENCH_PROMPT_SIMPLE='Implement a Go HTTP middleware that rate-limits requests per client IP using a token bucket algorithm. Requirements: Each IP gets 10 requests per second. Respond with HTTP 429 when limit is exceeded. Thread-safe implementation. Include tests with map-based test cases. Put the code in directory: $DIR/rate-limiter/. Include a README.md explaining usage.'

BENCH_PROMPT_COMPLEX='Implement a Go REST API for a task management system. This is a multi-layer project — start with a plan before writing any code. Requirements: Use standard library only (no frameworks, no external dependencies). Layered architecture: handler -> service -> repository. In-memory repository. Endpoints: POST /tasks (create, fields: title+description), GET /tasks (list all), GET /tasks/{id} (get by id), PATCH /tasks/{id} (update status: todo/in-progress/done), DELETE /tasks/{id} (delete). Proper HTTP status codes and JSON responses. Unit tests for the service layer using map-based test cases. Put all code in directory: $DIR/task-api/'

BENCH_PROMPT_RESEARCH='What are the most popular third-party HTTP router libraries for Go? List the top 3 with: GitHub stars (approximate), key differentiators, and a one-line example of defining a route with a path parameter.'

BENCH_PROMPT_EXPLORE='The directory $DIR/usermgmt/ contains an existing Go HTTP API for user and team management. Explore the codebase, find all HTTP handlers that are missing input validation, and fix them. Requirements: - First explore the entire codebase to build a map of all handlers and their validation status. - Write a plan listing every handler endpoint, what validation is missing, and what you will add. - Implement the validation fixes. Specific issues to find and fix:   - Handlers that accept arbitrary strings for fields with a fixed set of valid values (e.g. roles)   - Handlers that accept zero or negative integers for fields that must be positive   - Handlers that accept empty strings for required fields at the HTTP layer (even if the service layer also checks)   - Search/filter endpoints with no length limit on query parameters   - Pagination parameters with no bounds checking (negative offsets, excessively large limits) - Add unit tests for the validation logic using map-based test cases. - Do not change the project structure or add external dependencies.'

BENCH_PROMPT_MEGA='Implement a Go CLI application that acts as a concurrent build system, similar to a simplified Make. This is a multi-layer project — start with a plan before writing any code. Requirements: Use standard library only (no frameworks, no external dependencies). Parse a declarative build file (buildfile.txt) with this format:
    target: dep1 dep2
        command1
        command2
Indented lines under a target are shell commands. Dependencies are space-separated after the colon. Resolve the full dependency graph using topological sort. Detect and report cycles with a clear error message listing the cycle path. Execute independent targets concurrently using a worker pool. Targets whose dependencies are all satisfied should start immediately. Stream command output per target with prefixed labels, e.g. '"'"'[compile] go build ./...'"'"'. Graceful shutdown on SIGINT: finish in-progress targets, skip pending ones, print a summary of what completed and what was skipped. CLI flags: -f <file> (build file path, default: buildfile.txt), -j <N> (max parallel workers, default: number of CPUs), -target <name> (build a specific target and its transitive deps only, default: build all root targets). Fail fast: on the first target error, cancel pending targets and report which target and command failed. Layered architecture: separate packages for parsing, graph resolution, execution engine, and CLI. Unit tests for: build file parsing (valid and malformed input), dependency resolution (diamond deps, cycle detection, single target extraction), and execution ordering (verify concurrency-safe ordering). Use map-based test cases. Put all code in directory: $DIR/buildtool/'

# Associative array: task name -> prompt variable name
# Used for dynamic lookup without eval
declare -A BENCH_TASK_MAP
BENCH_TASK_MAP[simple]='BENCH_PROMPT_SIMPLE'
BENCH_TASK_MAP[complex]='BENCH_PROMPT_COMPLEX'
BENCH_TASK_MAP[complex-single]='BENCH_PROMPT_COMPLEX'
BENCH_TASK_MAP[research]='BENCH_PROMPT_RESEARCH'
BENCH_TASK_MAP[explore]='BENCH_PROMPT_EXPLORE'
BENCH_TASK_MAP[mega]='BENCH_PROMPT_MEGA'

# Ordered list of task names
BENCH_TASKS=(simple complex complex-single research explore mega)

# Associative array: task name -> human label
declare -A BENCH_TASK_LABELS
BENCH_TASK_LABELS[simple]='Go HTTP Rate Limiter Middleware'
BENCH_TASK_LABELS[complex]='Go REST API Task Management'
BENCH_TASK_LABELS[complex-single]='Go REST API (single model)'
BENCH_TASK_LABELS[research]='Most popular Go HTTP router libraries'
BENCH_TASK_LABELS[explore]='Add input validation to existing Go API'
BENCH_TASK_LABELS[mega]='Go Concurrent Build System'

# ---------------------------------------------------------------------------
# Helper: resolve a prompt variable name to its value
# ---------------------------------------------------------------------------

# Returns the prompt string for a given task name
bench_prompt_for() {
  local task="$1"
  local var="${BENCH_TASK_MAP[$task]}"
  if [[ -z "$var" ]]; then
    echo "Unknown task: $task" >&2
    return 1
  fi
  echo "${(P)var}"
}

# ---------------------------------------------------------------------------
# Session directory numbering
# ---------------------------------------------------------------------------

# Prints the path of the next session directory (does NOT create it).
# Usage: SESSION_DIR=$(bench_next_session_dir "$SESSIONS_DIR")
bench_next_session_dir() {
  local sessions_dir="$1"
  LAST=$(ls -d "$sessions_dir"/session-* 2>/dev/null | grep -oE '[0-9]+$' | sort -n | tail -1)
  N=$(( ${LAST:-0} + 1 ))
  SESSION="session-$(printf '%02d' $N)"
  echo "$sessions_dir/$SESSION"
}

# ---------------------------------------------------------------------------
# Per-task setup command (e.g. copy explore seed)
# ---------------------------------------------------------------------------

# Prints the setup shell commands for a task. Empty string if no setup needed.
bench_task_setup() {
  local task="$1"
  local dir_var="${2:-DIR}"   # the shell variable name for the working dir (default: DIR)
  case "$task" in
    explore)
      # The explore seed is expected to be at $IMPROVEMENT_DIR/seeds/explore-refactor
      # The calling script should set EXPLORE_SEED before calling this.
      if [[ -n "${EXPLORE_SEED:-}" && -d "$EXPLORE_SEED" ]]; then
        echo "mkdir -p \"\$$dir_var/usermgmt\" && cp -R \"$EXPLORE_SEED/.\" \"\$$dir_var/usermgmt/\" && ls -la \"\$$dir_var/usermgmt/\""
      fi
      ;;
    *)
      echo ""
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Generate individual runner script
# ---------------------------------------------------------------------------

# Generates a single run-*.sh script.
# Usage:
#   bench_generate_runner_script <output_path> <runner_type> <task_name> <model/cli_name> <session_dir> <session_num> <binary_or_cli> <temp_prefix>
#
# runner_type = "kimchi" | "claude"
# model_name: for kimchi type, pass "" to run in multi-model mode (no --model flag).
bench_generate_runner_script() {
  local output_path="$1"
  local runner_type="$2"
  local task_name="$3"
  local model_name="$4"
  local session_dir="$5"
  local session_num="$6"
  local binary="$7"
  local temp_prefix="$8"

  local prompt
  prompt=$(bench_prompt_for "$task_name")

  local setup_cmd
  setup_cmd=$(bench_task_setup "$task_name" "DIR")

  local content

  if [[ "$runner_type" == "kimchi" ]]; then
    local extra_flags=""

    local setup_block=""
    if [[ -n "$setup_cmd" ]]; then
      setup_block="${setup_cmd}
"
    fi

    local run_dir_name="${task_name}"
    local model_flag_line=""
    if [[ -n "$model_name" ]]; then
      run_dir_name="${task_name}-${model_name}"
      model_flag_line="  --model kimchi-dev/${model_name} \\
"
    fi

    content="#!/bin/zsh
TS=\$(date +%Y%m%d-%H%M%S)
SESSION_FILE=\"${session_dir}/runs/${run_dir_name}/session-\${TS}.jsonl\"
DIR=\$(mktemp -d /private/tmp/${temp_prefix}-XXXXXX)
echo \"Working directory: \$DIR\"
echo \"Session file: \$SESSION_FILE\"
cd \"\$DIR\"
${setup_block}${binary} \\
  --yolo \\
${model_flag_line}${extra_flags}  --session \"\$SESSION_FILE\" \\
  \"${prompt}\"
"
  elif [[ "$runner_type" == "claude" ]]; then
    local setup_block=""
    if [[ -n "$setup_cmd" ]]; then
      setup_block="${setup_cmd}
"
    fi

    content="#!/bin/zsh
DIR=\$(mktemp -d /private/tmp/${temp_prefix}-XXXXXX)
echo \"Working directory: \$DIR\"
cd \"\$DIR\"
${setup_block}${binary} \\
  --dangerously-skip-permissions \\
  --model opus \\
  \"${prompt}\"
"
  else
    echo "Unknown runner type: $runner_type" >&2
    return 1
  fi

  printf '%s' "$content" > "$output_path"
  chmod +x "$output_path"
}

# ---------------------------------------------------------------------------
# Generate run-all.sh script
# ---------------------------------------------------------------------------

# Generates a run-all.sh (or run-all-claude.sh) script.
# Usage:
#   bench_generate_run_all_script <output_path> <--rows N> <--cols N> <script_path...>
#
# Layout logic:
#   - 1D (rows=1, cols=M): single row, M vertical splits — for claude scripts
#   - 2D (rows=R, cols=C): R horizontal splits × C vertical splits — for kimchi grid
bench_generate_run_all_script() {
  local output_path="$1"
  shift

  local rows=1
  local cols=0

  # Parse --rows and --cols flags
  while [[ "$1" == --* ]]; do
    case "$1" in
      --rows) rows="$2"; shift 2 ;;
      --cols) cols="$2"; shift 2 ;;
      *) echo "Unknown flag: $1" >&2; return 1 ;;
    esac
  done

  local -a scripts=("$@")
  local num_scripts=${#scripts[@]}

  if [[ $num_scripts -eq 0 ]]; then
    echo "bench_generate_run_all_script: no scripts given" >&2
    return 1
  fi

  # If cols not specified, derive from rows for a roughly-square grid
  if [[ $cols -eq 0 ]]; then
    cols=$(( (num_scripts + rows - 1) / rows ))
  fi

  # Build AppleScript
  local -a as_lines=()

  # First pane in the new tab
  as_lines+=("      set g0_0 to current session of newTab")

  # Vertical splits for remaining columns in row 0
  local c r
  for (( c=1; c<cols; c++ )); do
    as_lines+=("      set g${c}_0 to (split vertically with default profile of g$(( c-1 ))_0)")
  done

  # Horizontal splits for remaining rows
  for (( r=1; r<rows; r++ )); do
    for (( c=0; c<cols; c++ )); do
      as_lines+=("      set g${c}_${r} to (split horizontally with default profile of g${c}_$(( r-1 )))")
    done
  done

  # Write commands to each pane
  local i=1
  for (( r=0; r<rows; r++ )); do
    for (( c=0; c<cols; c++ )); do
      if (( i <= num_scripts )); then
        local script_escaped="${scripts[$i]}"
        # In AppleScript string literals, a literal double-quote is escaped by
        # doubling it (""), not with a backslash.
        script_escaped="${script_escaped//\"/\"\"}"
        as_lines+=("      tell g${c}_${r} to write text \"${script_escaped}\"")
        (( i++ ))
      fi
    done
  done

  local as_body=$'\n'"${(F)as_lines}"$'\n'

  # Build background fallback
  local -a bg_lines=()
  for script in "${scripts[@]}"; do
    local name="${script:t:r}"   # basename without extension
    local log="${script:h}/${name}.log"
    bg_lines+=("  \"${script}\" >\"${log}\" 2>&1 &")
  done
  local bg_body=$'\n'"${(F)bg_lines}"$'\n'

  local num_scripts_str="$num_scripts"
  cat > "$output_path" <<EOF
#!/bin/zsh
if osascript -e 'id of application "iTerm2"' &>/dev/null 2>&1; then
  osascript <<APPLESCRIPT
tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell newTab
${as_body}    end tell
  end tell
end tell
APPLESCRIPT
else
  echo "iTerm2 not available — running ${num_scripts_str} scripts in background..."
${bg_body}
  wait
  echo "All done."
fi
EOF
  chmod +x "$output_path"
}