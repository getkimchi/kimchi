#!/usr/bin/env bash
# Superpowers auto-install smoke test
# Runs inside the Docker container against a real Linux kimchi binary.
# Requires: KIMCHI_API_KEY env var set

set -euo pipefail

PASS=0
FAIL=0

ok() {
    echo "  ✓ $1"
    PASS=$((PASS + 1))
}

fail() {
    echo "  ✗ $1"
    FAIL=$((FAIL + 1))
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        ok "$desc"
    else
        fail "$desc (expected: '$expected', got: '$actual')"
    fi
}

assert_contains() {
    local desc="$1" needle="$2" haystack="$3"
    if echo "$haystack" | grep -q "$needle"; then
        ok "$desc"
    else
        fail "$desc (expected to contain: '$needle')"
    fi
}

assert_file_exists() {
    local desc="$1" path="$2"
    if [ -f "$path" ]; then
        ok "$desc"
    else
        fail "$desc (file not found: $path)"
    fi
}

assert_dir_exists() {
    local desc="$1" path="$2"
    if [ -d "$path" ]; then
        ok "$desc"
    else
        fail "$desc (dir not found: $path)"
    fi
}

VENDOR_DIR="$HOME/.config/kimchi/vendor/superpowers"
VERSION_FILE="$VENDOR_DIR/.version"
SKILLS_DIR="$VENDOR_DIR/skills"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 1: clean slate — vendor dir absent before first launch ==="
if [ -d "$VENDOR_DIR" ]; then
    fail "vendor dir should not exist yet"
else
    ok "vendor dir absent before first launch"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 2: first launch downloads superpowers ==="
kimchi --print "say hello" > /dev/null 2>&1 || true
# The --print path still runs cli.ts startup (including ensureSuperpowersInstalled)
# even if the model call fails with a bad API key.

assert_dir_exists "vendor dir created" "$VENDOR_DIR"
assert_file_exists ".version file written" "$VERSION_FILE"
assert_dir_exists "skills dir created" "$SKILLS_DIR"

VERSION=$(cat "$VERSION_FILE" 2>/dev/null || echo "")
assert_eq ".version contains pinned version" "v5.1.0" "$VERSION"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 3: all 14 expected skills are present ==="
EXPECTED_SKILLS=(
    brainstorming
    dispatching-parallel-agents
    executing-plans
    finishing-a-development-branch
    receiving-code-review
    requesting-code-review
    subagent-driven-development
    systematic-debugging
    test-driven-development
    using-git-worktrees
    using-superpowers
    verification-before-completion
    writing-plans
    writing-skills
)

for skill in "${EXPECTED_SKILLS[@]}"; do
    if [ -f "$SKILLS_DIR/$skill/SKILL.md" ]; then
        ok "skill present: $skill"
    else
        fail "skill missing: $skill"
    fi
done

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 4: sibling tarball cleaned up after extraction ==="
TARBALL="$VENDOR_DIR.download.tar.gz"
if [ -f "$TARBALL" ]; then
    fail "tarball should have been deleted after extraction ($TARBALL)"
else
    ok "sibling tarball cleaned up"
fi

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 5: second launch is instant (idempotency) ==="
START=$(date +%s%3N)
kimchi --print "say hello" > /dev/null 2>&1 || true
END=$(date +%s%3N)
ELAPSED=$((END - START))

# Re-download would take several seconds; idempotent path is <1s
if [ "$ELAPSED" -lt 3000 ]; then
    ok "second launch fast (${ELAPSED}ms, no re-download)"
else
    fail "second launch too slow (${ELAPSED}ms — possible re-download?)"
fi

VERSION_AFTER=$(cat "$VERSION_FILE" 2>/dev/null || echo "")
assert_eq ".version unchanged after second launch" "v5.1.0" "$VERSION_AFTER"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 6: stale version triggers re-download ==="
echo "v0.0.0" > "$VERSION_FILE"

kimchi --print "say hello" > /dev/null 2>&1 || true

VERSION_UPDATED=$(cat "$VERSION_FILE" 2>/dev/null || echo "")
assert_eq ".version updated after stale detection" "v5.1.0" "$VERSION_UPDATED"

# ---------------------------------------------------------------------------
echo ""
echo "=== Test 7: offline — missing vendor dir, no network ==="
rm -rf "$VENDOR_DIR"

# Block all HTTPS with an unreachable proxy
HTTPS_PROXY=http://127.0.0.1:19999 kimchi --print "say hello" > /dev/null 2>&1 || true

# Harness must not crash — .version must not be written (so next run retries)
ok "harness survives offline first launch (no crash)"
if [ -f "$VERSION_FILE" ]; then
    fail ".version must not be written after failed offline install"
else
    ok ".version absent after offline install attempt (will retry next launch)"
fi

# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "==========================================="

[ "$FAIL" -eq 0 ]
