#!/bin/zsh
set -e

IMPROVEMENT_DIR="${0:A:h}"

# Check for local override first, then fall back to default config
if [[ -f "$IMPROVEMENT_DIR/benchmark.local.json" ]]; then
  BENCHMARK_JSON="$IMPROVEMENT_DIR/benchmark.local.json"
elif [[ -f "$IMPROVEMENT_DIR/benchmark.json" ]]; then
  BENCHMARK_JSON="$IMPROVEMENT_DIR/benchmark.json"
else
  echo "benchmark.json not found at $IMPROVEMENT_DIR/benchmark.json"
  echo "Create it with: {\"binary\": \"path/to/binary\", \"models\": [\"model-id\", ...]}"
  exit 1
fi

BINARY=$(python3 -c "import json,os; cfg=json.load(open('$BENCHMARK_JSON')); print(os.path.expanduser(cfg.get('binary','~/_dev/kimchi-dev/dist/bin/kimchi')))")

if [[ ! -f "$BINARY" ]]; then
  echo "Binary not found: $BINARY"
  echo "Update 'binary' in benchmark.json or build the binary first."
  exit 1
fi

SESSIONS_DIR="$IMPROVEMENT_DIR/sessions"
mkdir -p "$SESSIONS_DIR"

# Determine next session number
LAST=$(ls -d "$SESSIONS_DIR"/session-* 2>/dev/null | grep -oE '[0-9]+$' | sort -n | tail -1)
N=$(( ${LAST:-0} + 1 ))
SESSION="session-$(printf '%02d' $N)"
SESSION_DIR="$SESSIONS_DIR/$SESSION"

echo "Creating $SESSION..."

# Generate all scripts via Python
python3 - "$SESSION_DIR" "$N" "$BENCHMARK_JSON" "$HOME" "$BINARY" <<'PYEOF'
import json, os, sys, stat

session_dir, n, benchmark_json, home, binary = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]

cfg = json.load(open(benchmark_json))
models = cfg.get("models", [])
if not models:
    sys.exit("No models configured. Set 'models' array in benchmark.json.")

simple_prompt = (
    "Implement a Go HTTP middleware that rate-limits requests per client IP using a token bucket algorithm. "
    "Requirements: Each IP gets 10 requests per second. Respond with HTTP 429 when limit is exceeded. "
    "Thread-safe implementation. Include tests with map-based test cases. "
    "Put the code in directory: $DIR/rate-limiter/. Include a README.md explaining usage."
)

complex_prompt = (
    "Implement a Go REST API for a task management system. "
    "This is a multi-layer project — start with a plan before writing any code. "
    "Requirements: Use standard library only (no frameworks, no external dependencies). "
    "Layered architecture: handler -> service -> repository. In-memory repository. "
    "Endpoints: POST /tasks (create, fields: title+description), GET /tasks (list all), "
    "GET /tasks/{id} (get by id), PATCH /tasks/{id} (update status: todo/in-progress/done), DELETE /tasks/{id} (delete). "
    "Proper HTTP status codes and JSON responses. "
    "Unit tests for the service layer using map-based test cases. "
    "Put all code in directory: $DIR/task-api/"
)

research_prompt = (
    "What are the most popular third-party HTTP router libraries for Go? "
    "List the top 3 with: GitHub stars (approximate), key differentiators, "
    "and a one-line example of defining a route with a path parameter."
)

mega_prompt = (
    "Implement a Go CLI application that acts as a concurrent build system, similar to a simplified Make. "
    "This is a multi-layer project — start with a plan before writing any code. "
    "Requirements: Use standard library only (no frameworks, no external dependencies). "
    "Parse a declarative build file (buildfile.txt) with this format:\n"
    "    target: dep1 dep2\n"
    "        command1\n"
    "        command2\n"
    "Indented lines under a target are shell commands. Dependencies are space-separated after the colon. "
    "Resolve the full dependency graph using topological sort. Detect and report cycles with a clear error message listing the cycle path. "
    "Execute independent targets concurrently using a worker pool. Targets whose dependencies are all satisfied should start immediately. "
    "Stream command output per target with prefixed labels, e.g. '[compile] go build ./...'. "
    "Graceful shutdown on SIGINT: finish in-progress targets, skip pending ones, print a summary of what completed and what was skipped. "
    "CLI flags: -f <file> (build file path, default: buildfile.txt), -j <N> (max parallel workers, default: number of CPUs), "
    "-target <name> (build a specific target and its transitive deps only, default: build all root targets). "
    "Fail fast: on the first target error, cancel pending targets and report which target and command failed. "
    "Layered architecture: separate packages for parsing, graph resolution, execution engine, and CLI. "
    "Unit tests for: build file parsing (valid and malformed input), dependency resolution (diamond deps, cycle detection, single target extraction), "
    "and execution ordering (verify concurrency-safe ordering). Use map-based test cases. "
    "Put all code in directory: $DIR/buildtool/"
)

# Fourth element: include_in_run_all (default True)
tasks = [
    ("simple",         simple_prompt,  [],                      True),
    ("complex",        complex_prompt, [],                      True),
    ("complex-single", complex_prompt, ["--multi-model=false"], True),
    ("research",       research_prompt,[],                      True),
    ("mega",           mega_prompt,    [],                      False),
]

all_scripts = []
run_all_scripts = []
for model in models:
    print(f"model: kimchi-dev/{model}")
    for task, task_prompt, extra_flags, in_run_all in tasks:
        run_dir = f"{task}-{model}"
        os.makedirs(os.path.join(session_dir, "runs", run_dir), exist_ok=True)
        slug = f"s{n}-{task}-{model}"
        script_path = os.path.join(session_dir, f"run-{task}-{model}.sh")
        flags = "\n".join(f"  {flag} \\" for flag in extra_flags)
        flags_block = (flags + "\n") if flags else ""
        content = f"""#!/bin/zsh
TS=$(date +%Y%m%d-%H%M%S)
SESSION_FILE="{session_dir}/runs/{run_dir}/session-${{TS}}.jsonl"
DIR=$(mktemp -d /private/tmp/kimchi-{slug}-XXXXXX)
echo "Working directory: $DIR"
echo "Session file: $SESSION_FILE"
cd "$DIR"
{binary} \\
  --yolo \\
  --model kimchi-dev/{model} \\
{flags_block}  --session "$SESSION_FILE" \\
  "{task_prompt}"
"""
        with open(script_path, "w") as f:
            f.write(content)
        os.chmod(script_path, os.stat(script_path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        all_scripts.append(script_path)
        if in_run_all:
            run_all_scripts.append(script_path)

# run-all.sh — iTerm2 grid (cols=tasks, rows=models) with background fallback
# Only includes tasks marked with in_run_all=True
run_all = os.path.join(session_dir, "run-all.sh")
run_all_tasks = [t for t in tasks if t[3]]
cols = len(run_all_tasks)
rows = len(models)

# Build AppleScript: create a NEW TAB, then split into a grid (cols=tasks, rows=models)
as_lines = []
# First pane in the new tab
as_lines.append("      set g0_0 to current session of newTab")
# Create remaining columns via vertical splits
for c in range(1, cols):
    as_lines.append(f"      set g{c}_0 to (split vertically with default profile of g{c-1}_0)")
# Create rows via horizontal splits
for r in range(1, rows):
    for c in range(cols):
        as_lines.append(f"      set g{c}_{r} to (split horizontally with default profile of g{c}_{r-1})")
# Write commands
for r in range(rows):
    for c in range(cols):
        i = r * cols + c
        if i < len(run_all_scripts):
                # NOTE: iTerm2's `write text` sends keystrokes and returns immediately —
            # it does NOT wait for the command to finish.
            as_lines.append(f'      tell g{c}_{r} to write text "{run_all_scripts[i]}"')
as_body = "\n".join(as_lines)

# Background fallback: run each script with output to a per-script log file
bg_lines = []
for script in run_all_scripts:
    name = os.path.basename(script).replace(".sh", "")
    log = os.path.join(session_dir, f"{name}.log")
    bg_lines.append(f'  "{script}" >"{log}" 2>&1 &')
bg_body = "\n".join(bg_lines)

with open(run_all, "w") as f:
    f.write(f"""#!/bin/zsh
if osascript -e 'id of application "iTerm2"' &>/dev/null 2>&1; then
  osascript <<APPLESCRIPT
tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell newTab
{as_body}
    end tell
  end tell
end tell
APPLESCRIPT
else
  echo "iTerm2 not available — running {len(run_all_scripts)} scripts in background (logs in {session_dir}/)..."
{bg_body}
  wait
  echo "All done."
fi
""")
os.chmod(run_all, os.stat(run_all).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

excluded = [s for s in all_scripts if s not in run_all_scripts]
print(f"\nDone. {len(all_scripts)} scripts created in {session_dir}/")
print(f"  run-all.sh includes {len(run_all_scripts)} tasks")
if excluded:
    print(f"  run separately: {', '.join(os.path.basename(s) for s in excluded)}")
print(f"Next: {session_dir}/run-all.sh")
PYEOF
