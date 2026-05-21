#!/bin/zsh
set -e

IMPROVEMENT_DIR="${0:A:h}"
source "${IMPROVEMENT_DIR}/lib.sh"

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
EXPLORE_SEED="$IMPROVEMENT_DIR/seeds/explore-refactor"
mkdir -p "$SESSIONS_DIR"

SESSION_DIR=$(bench_next_session_dir "$SESSIONS_DIR")
N=$(basename "$SESSION_DIR" | grep -oE '[0-9]+$')

echo "Creating $(basename "$SESSION_DIR")..."

# Export prompts as environment variables for the Python block
export BENCH_PROMPT_SIMPLE
export BENCH_PROMPT_COMPLEX
export BENCH_PROMPT_RESEARCH
export BENCH_PROMPT_EXPLORE
export BENCH_PROMPT_MEGA
export EXPLORE_SEED
export SESSION_DIR
export N
export BINARY
export IMPROVEMENT_DIR

# Generate all scripts via Python (handles 2D grid generation)
python3 - "$BENCHMARK_JSON" "$HOME" <<'PYEOF'
import json, os, sys, stat

benchmark_json = sys.argv[1]
home = sys.argv[2]

cfg = json.load(open(benchmark_json))
models = cfg.get("models", [])
if not models:
    sys.exit("No models configured. Set 'models' array in benchmark.json.")

simple_prompt    = os.environ["BENCH_PROMPT_SIMPLE"]
complex_prompt   = os.environ["BENCH_PROMPT_COMPLEX"]
research_prompt  = os.environ["BENCH_PROMPT_RESEARCH"]
explore_prompt   = os.environ["BENCH_PROMPT_EXPLORE"]
mega_prompt      = os.environ["BENCH_PROMPT_MEGA"]
explore_seed     = os.environ["EXPLORE_SEED"]
session_dir      = os.environ["SESSION_DIR"]
n                = int(os.environ["N"])
binary           = os.environ["BINARY"]

# Fields: (name, prompt, extra_flags, in_run_all, setup_cmd or None)
tasks = [
    ("simple",         simple_prompt,  [],                      True,  None),
    ("complex",        complex_prompt, [],                      True,  None),
    ("complex-single", complex_prompt, [], True,  None),
    ("research",       research_prompt,[],                      True,  None),
    ("explore",        explore_prompt, [],                      True,  f'mkdir -p "$DIR/usermgmt" && cp -R "{explore_seed}/." "$DIR/usermgmt/" && ls -la "$DIR/usermgmt/"'),
    ("mega",           mega_prompt,    [],                      False, None),
]

all_scripts = []
run_all_scripts = []
for model in models:
    print(f"model: kimchi-dev/{model}")
    for task, task_prompt, extra_flags, in_run_all, setup_cmd in tasks:
        run_dir = f"{task}-{model}"
        os.makedirs(os.path.join(session_dir, "runs", run_dir), exist_ok=True)
        slug = f"s{n}-{task}-{model}"
        script_path = os.path.join(session_dir, f"run-{task}-{model}.sh")
        flags = "\n".join(f"  {flag} \\" for flag in extra_flags)
        flags_block = (flags + "\n") if flags else ""
        setup_block = (setup_cmd + "\n") if setup_cmd else ""
        content = f"""#!/bin/zsh
TS=$(date +%Y%m%d-%H%M%S)
SESSION_FILE="{session_dir}/runs/{run_dir}/session-${{TS}}.jsonl"
DIR=$(mktemp -d /private/tmp/kimchi-{slug}-XXXXXX)
echo "Working directory: $DIR"
echo "Session file: $SESSION_FILE"
cd "$DIR"
{setup_block}{binary} \\
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
run_all = os.path.join(session_dir, "run-all.sh")
run_all_tasks = [t for t in tasks if t[3]]
cols = len(run_all_tasks)
rows = len(models)

as_lines = []
as_lines.append("      set g0_0 to current session of newTab")
for c in range(1, cols):
    as_lines.append(f"      set g{c}_0 to (split vertically with default profile of g{c-1}_0)")
for r in range(1, rows):
    for c in range(cols):
        as_lines.append(f"      set g{c}_{r} to (split horizontally with default profile of g{c}_{r-1})")
for r in range(rows):
    for c in range(cols):
        i = r * cols + c
        if i < len(run_all_scripts):
            script_path_escaped = run_all_scripts[i].replace('"', '""')
            as_lines.append(f'      tell g{c}_{r} to write text "{script_path_escaped}"')
as_body = "\n".join(as_lines)

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
