#!/usr/bin/env bash
set -euo pipefail

SESSIONS_BASE="${HOME}/.config/kimchi/harness/sessions"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="${SCRIPT_DIR}/audit-session-prompt.md"

usage() {
    cat <<EOF
Usage: $(basename "$0") [options] [session-file]

Audit a kimchi harness session for phase quality and cost efficiency.
Runs the audit agent in non-interactive mode using Opus.

Arguments:
  session-file     Path to a .jsonl session file (optional)

Options:
  -l, --list          List available sessions and exit
  -n, --last N        Show only the last N sessions (default: all)
  -d, --dir DIR       Use DIR to find sessions (default: current directory)
  -r, --runner CMD    Harness to use: kimchi or claude (default: kimchi)
  -m, --model MODEL   Model to use (default: kimchi-dev/claude-opus-4-6)
  -h, --help          Show this help

Examples:
  $(basename "$0")                              # pick session, run with kimchi
  $(basename "$0") -r claude                    # run with claude-code
  $(basename "$0") -m claude-opus-4-6           # custom model
  $(basename "$0") -r claude -m opus            # claude-code with opus
  $(basename "$0") -n 5                         # pick from last 5 sessions
  $(basename "$0") -l                           # list all sessions
  $(basename "$0") -l -n 3                      # list last 3 sessions
  $(basename "$0") path/to/session.jsonl        # audit a specific session file
EOF
    exit 0
}

encode_cwd() {
    local dir="$1"
    local encoded
    encoded="$(echo "$dir" | sed 's|/|-|g' | sed 's/^-//')"
    echo "--${encoded}--"
}

find_sessions_dir() {
    local dir="$1"
    local encoded
    encoded="$(encode_cwd "$dir")"
    local sessions_path="${SESSIONS_BASE}/${encoded}"
    if [[ ! -d "$sessions_path" ]]; then
        echo "No sessions directory found for: $dir" >&2
        echo "Expected: $sessions_path" >&2
        exit 1
    fi
    echo "$sessions_path"
}

first_user_prompt() {
    local file="$1"
    local max_chars="${2:-80}"
    local prompt=""
    if command -v jq &>/dev/null; then
        prompt="$(jq -r '
            select(.type == "message" and .message.role == "user")
            | .message.content
            | if type == "array" then
                map(select(.type == "text") | .text) | join(" ")
              elif type == "string" then .
              else ""
              end
        ' "$file" 2>/dev/null | head -1)"
    else
        prompt="$(grep -m1 '"role":"user"' "$file" 2>/dev/null \
            | grep -o '"text":"[^"]*"' | head -1 | cut -d'"' -f4)"
    fi
    prompt="$(echo "$prompt" | tr '\n' ' ' | sed 's/  */ /g' | head -c "$max_chars")"
    if [[ ${#prompt} -ge $max_chars ]]; then
        prompt="${prompt}..."
    fi
    echo "$prompt"
}

print_session_entry() {
    local index="$1"
    local file="$2"
    local header
    header="$(head -1 "$file" 2>/dev/null || echo '{}')"
    local ts
    ts="$(echo "$header" | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4)"
    local size
    size="$(wc -l < "$file" | tr -d ' ')"
    local prompt
    prompt="$(first_user_prompt "$file")"
    printf "  %2d. %s  (%s, %s lines)\n" "$index" "$(basename "$file")" "${ts:-unknown}" "$size"
    if [[ -n "$prompt" ]]; then
        printf "      %s\n" "$prompt"
    fi
}

collect_sessions() {
    local sessions_dir="$1"
    local limit="$2"
    local cmd="find \"$sessions_dir\" -name '*.jsonl' -type f -print0 | xargs -0 ls -t 2>/dev/null"
    if [[ "$limit" -gt 0 ]]; then
        eval "$cmd" | head -n "$limit"
    else
        eval "$cmd"
    fi
}

list_sessions() {
    local sessions_dir="$1"
    local limit="$2"
    echo "Sessions in: $sessions_dir"
    echo ""
    local count=0
    while IFS= read -r f; do
        count=$((count + 1))
        print_session_entry "$count" "$f"
    done < <(collect_sessions "$sessions_dir" "$limit")
    if [[ $count -eq 0 ]]; then
        echo "  (no session files found)"
    fi
}

SESSION_FILE=""
LIST=false
LIMIT=0
TARGET_DIR="$(pwd)"
RUNNER="kimchi"
MODEL=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage ;;
        -l|--list) LIST=true; shift ;;
        -n|--last) LIMIT="$2"; shift 2 ;;
        -d|--dir) TARGET_DIR="$2"; shift 2 ;;
        -r|--runner) RUNNER="$2"; shift 2 ;;
        -m|--model) MODEL="$2"; shift 2 ;;
        *)
            if [[ -f "$1" ]]; then
                SESSION_FILE="$1"
            else
                echo "Not a file: $1" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

if $LIST; then
    sessions_dir="$(find_sessions_dir "$TARGET_DIR")"
    list_sessions "$sessions_dir" "$LIMIT"
    exit 0
fi

if [[ -z "$SESSION_FILE" ]]; then
    sessions_dir="$(find_sessions_dir "$TARGET_DIR")"

    mapfile -t session_files < <(collect_sessions "$sessions_dir" "$LIMIT")

    if [[ ${#session_files[@]} -eq 0 ]]; then
        echo "No session files found in: $sessions_dir" >&2
        exit 1
    fi

    echo "Available sessions:"
    echo ""
    for i in "${!session_files[@]}"; do
        print_session_entry "$((i + 1))" "${session_files[$i]}"
    done

    echo ""
    printf "Select session [1-%d]: " "${#session_files[@]}"
    read -r selection

    if [[ -z "$selection" ]] || ! [[ "$selection" =~ ^[0-9]+$ ]] || [[ "$selection" -lt 1 ]] || [[ "$selection" -gt ${#session_files[@]} ]]; then
        echo "Invalid selection" >&2
        exit 1
    fi

    SESSION_FILE="${session_files[$((selection - 1))]}"
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "Prompt file not found: $PROMPT_FILE" >&2
    exit 1
fi

SESSION_ID="$(basename "$SESSION_FILE" .jsonl)"

case "$RUNNER" in
    kimchi)  EFFECTIVE_MODEL="${MODEL:-kimchi-dev/claude-opus-4-6}" ;;
    claude)  EFFECTIVE_MODEL="${MODEL:-claude-opus-4-6}" ;;
    *)       echo "Unknown runner: $RUNNER (use 'kimchi' or 'claude')" >&2; exit 1 ;;
esac

MODEL_SLUG="$(echo "$EFFECTIVE_MODEL" | sed 's|.*/||' | tr '[:upper:]' '[:lower:]')"
AUDIT_FILENAME="${SESSION_ID}-${RUNNER}-${MODEL_SLUG}-AUDIT.md"

echo "Auditing session: $SESSION_FILE"
echo "Session ID: $SESSION_ID"
echo "Runner: $RUNNER"
echo "Model: $EFFECTIVE_MODEL"
echo "Audit file: .kimchi/audits/$AUDIT_FILENAME"
echo ""

TMPFILE="$(mktemp /tmp/audit-prompt-XXXXXX)"
TMPFILE="${TMPFILE}.md"
trap 'rm -f "$TMPFILE"' EXIT

sed \
    -e "s|{sessionFile}|${SESSION_FILE}|g" \
    -e "s|{sessionId}|${SESSION_ID}|g" \
    -e "s|{auditFilename}|${AUDIT_FILENAME}|g" \
    -e "s|{auditRunner}|${RUNNER}|g" \
    -e "s|{auditModel}|${EFFECTIVE_MODEL}|g" \
    "$PROMPT_FILE" > "$TMPFILE"

run_audit_agent() {
    local runner="$1"
    local model="$2"
    local prompt_file="$3"

    case "$runner" in
        kimchi)
            kimchi --model "$model" --yolo "@${prompt_file}"
            ;;
        claude)
            claude --model "$model" --dangerously-skip-permissions "$(cat "$prompt_file")"
            ;;
        *)
            echo "Unknown runner: $runner" >&2
            return 1
            ;;
    esac
}

extract_json_sidecar() {
    local audit_file="$1"
    local sidecar_file="${audit_file%.md}.json"

    if [[ ! -f "$audit_file" ]]; then
        echo "Audit file not found: $audit_file" >&2
        return 1
    fi

    local json_content
    json_content="$(awk '
        /^```json$/     { buf=""; in_block=1; next }
        in_block && /^```$/ { in_block=0 }
        in_block        { buf = buf $0 "\n" }
        END             { printf "%s", buf }
    ' "$audit_file" | sed -e 's/[[:space:]]*$//')"

    if [[ -z "$json_content" ]]; then
        echo "No JSON appendix found in audit report" >&2
        return 1
    fi

    printf '%s\n' "$json_content" > "$sidecar_file"

    if command -v jq &>/dev/null; then
        if jq empty "$sidecar_file" 2>/dev/null; then
            echo "JSON sidecar written: $sidecar_file (validated)" >&2
        else
            echo "JSON sidecar written but may be malformed: $sidecar_file" >&2
        fi
    else
        echo "JSON sidecar written (jq not available for validation): $sidecar_file" >&2
    fi

    printf '%s\n' "$sidecar_file"
}

echo "Running audit agent ($RUNNER, $EFFECTIVE_MODEL)..."
echo ""

run_audit_agent "$RUNNER" "$EFFECTIVE_MODEL" "$TMPFILE"

echo ""
audit_file=".kimchi/audits/$AUDIT_FILENAME"
if [[ -s "$audit_file" ]]; then
    echo "Audit report written: $audit_file"
    if sidecar=$(extract_json_sidecar "$audit_file"); then
        echo "JSON sidecar written: $sidecar"
    else
        echo "Warning: JSON sidecar extraction failed" >&2
    fi
else
    echo "Warning: audit report is empty or was not written" >&2
fi
