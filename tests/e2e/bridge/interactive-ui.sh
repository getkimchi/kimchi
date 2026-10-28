#!/usr/bin/env bash
# Chunk UI — interactive client verification. Drives the claude and codex TUIs
# in a dedicated tmux server with the sandboxed, gateway-wired environment:
# render, model list (full scroll-through recorded), model selection across
# several models (incl. glm-5.3-flash via the gateway catalog), prompts.
set -uo pipefail
cd "$(dirname "$0")"
source ./sandbox.sh

SANDHOME="/tmp/kimchi-e2e-runs/oauth-sandbox"
SOCK="kimchi-bridge-ui"
TMUX_TMPDIR="${TMUX_TMPDIR:-$E2E_RUNS/ui-tmux}"
WORKDIR="$E2E_RUNS/ui-workdir"
mkdir -p "$TMUX_TMPDIR" "$WORKDIR"

kill_session() { tmux -L "$SOCK" kill-session -t ui 2>/dev/null || true; }
tx() { tmux -L "$SOCK" send-keys -t ui "$1"; }
txe() { tmux -L "$SOCK" send-keys -t ui "$1" Enter; }
pane() { tmux -L "$SOCK" capture-pane -t ui -p; }

wait_pane() {
  local name="$1" pat="$2" t="${3:-60}" filt="${4:-}"
  local i=0
  while [ "$i" -lt "$t" ]; do
    local out; out="$(pane)"
    if [ -n "$filt" ]; then out="$(printf '%s\n' "$out" | grep -vF "$filt" || true)"; fi
    if printf '%s\n' "$out" | grep -qE "$pat"; then printf 'PASS|UI|%s\n' "$name"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  printf 'FAIL|UI|%s (timeout %ss; last: %s)\n' "$name" "$t" "$(pane | tail -6 | tr '\n' ' ' | head -c 200)"
  return 1
}
wait_any() {
  local name="$1" ok="$2" bad="$3" t="${4:-120}"
  local i=0
  while [ "$i" -lt "$t" ]; do
    local out; out="$(pane)"
    if printf '%s\n' "$out" | grep -qE "$bad"; then
      printf 'FAIL|UI|%s (upstream error: %s)\n' "$name" "$(printf '%s\n' "$out" | grep -E "$bad" | head -1 | tr -d '\n' | head -c 110)"
      return 1
    fi
    if printf '%s\n' "$out" | grep -qE "$ok"; then printf 'PASS|UI|%s\n' "$name"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  printf 'FAIL|UI|%s (timeout %ss)\n' "$name" "$t"
  return 1
}

UI_ENV="env HOME=$SANDHOME/home XDG_DATA_HOME=$SANDHOME/data XDG_STATE_HOME=$SANDHOME/state XDG_CONFIG_HOME=$SANDHOME/config KIMCHI_GATEWAY_PORT=18766"
launch() { kill_session; tmux -L "$SOCK" new-session -d -s ui -x 200 -y 50 >/dev/null 2>&1; txe "cd $WORKDIR && $UI_ENV $1"; }

run_ui_claude() {
  launch claude
  wait_pane "claude TUI gates passed" "Yes, I trust this folder|Claude Code|Opus|Sonnet|Haiku|❯" 60 "cd $WORKDIR" \
    || { pane | tail -10; kill_session; exit 1; }
  txe ""    # accept trust / continue
  wait_pane "claude main input ready" "❯" 90 "cd $WORKDIR" \
    || { pane | tail -10; kill_session; exit 1; }
  txe "/model"
  wait_pane "claude model list visible" "Select model|Sonnet|Opus|Haiku" 40 "cd $WORKDIR" || true
  echo "--- claude /model list (record) ---"
  pane | grep -vE '^$' | grep -iE "model|sonnet|opus|haiku|Mtok" | head -10
  sleep 1; tx Down; tx Down; tx s           # select Sonnet (entry 3) for this session
  wait_pane "claude model selection applied" "Set model|Model set|Sonnet" 30 || true
  echo "--- claude selection (record) ---"
  pane | grep -iE "Set model|Model set" | head -2
  txe "Reply with exactly: UI-17K"
  wait_pane "claude prompt round-trip (UI-17K)" "UI-17K" 180 "UI-17K" \
    || { echo "--- claude pane ---"; pane | tail -8; kill_session; exit 1; }
  tx C-c; sleep 1; kill_session
}

# codex_picker_select <catalog-index> <slug>: page through the picker (8 rows)
# and select the catalog entry; verify via the "Model changed to" line.
codex_picker_select() {
  local idx="$1" slug="$2" page pos d i
  page=$(( (idx - 1) / 8 )); pos=$(( (idx - 1) % 8 + 1 ))
  txe "/model"
  wait_pane "codex picker open ($slug)" "Select Model|current|reasoning" 40 "cd $WORKDIR" || return 1
  sleep 1
  for i in $(seq 1 "$page"); do tx NPage; sleep 1; done
  for i in $(seq 2 "$pos"); do tx Down; sleep 0.4; done
  txe ""; sleep 2; txe ""                      # select model, then reasoning (Low)
  if wait_pane "codex selected $slug" "Model changed to $slug" 30; then
    return 0
  fi
  echo "--- picker nav for $slug (record) ---"; pane | grep -iE "Model changed|model" | head -4
  return 1
}

run_ui_codex() {
  launch codex
  # Hooks review appears once only; accept either the review prompt or the ready UI.
  wait_pane "codex gates passed" "Hooks need review|Trust all|Ask Codex to do anything|›" 60 "cd $WORKDIR" \
    || { pane | tail -10; kill_session; exit 1; }
  if pane | grep -qiE "Hooks need review|Trust all"; then tx Down; txe ""; fi
  wait_pane "codex main input ready" "Ask Codex to do anything" 60 "cd $WORKDIR" \
    || { pane | tail -10; kill_session; exit 1; }
  # Record the full scrollable model list (4 pages).
  txe "/model"
  wait_pane "codex model picker open" "Select Model|current|reasoning" 40 "cd $WORKDIR" || true
  echo "--- codex model list (record, scrolled) ---"
  local pg
  for pg in 1 2 3 4; do
    pane | grep -vE '^$' | head -20
    [ "$pg" -lt 4 ] && { tx NPage; sleep 1; }
  done
  tx Escape; sleep 1
  # Selection 1: claude-sonnet-4-5 (catalog #2).
  if codex_picker_select 2 "claude-sonnet-4-5"; then
    txe "Reply with exactly: CX-19A"
    wait_any "codex prompt on claude-sonnet-4-5" "CX-19A" "503|stream disconnected|Service Unavailable" 180 || true
  fi
  # Selection 2: glm-5.3-flash (catalog #21).
  if codex_picker_select 21 "glm-5.3-flash"; then
    txe "Reply with exactly: CX-19B"
    wait_any "codex prompt on glm-5.3-flash" "CX-19B" "503|stream disconnected|Service Unavailable" 180 || true
  fi
  echo "--- codex final pane (record) ---"
  pane | grep -iE "Model changed|503|stream|error" | head -6
  tx C-c; sleep 1; kill_session
}

RESULTS=()
run_one() {
  local name="$1"
  local fn="$2"
  local log="$E2E_RUNS/$name.log"
  if ( set -e; "$fn" ) >"$log" 2>&1; then RESULTS+=("PASS $name"); else RESULTS+=("FAIL $name"); echo "--- $name log ---" >&2; tail -26 "$log" >&2; fi
}
run_one UI1 run_ui_claude
run_one UI2 run_ui_codex
printf '\n=== UI results ===\n'
printf '%s\n' "${RESULTS[@]}"
kill_session 2>/dev/null || true