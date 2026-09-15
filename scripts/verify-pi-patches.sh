#!/usr/bin/env bash
# Phase 2 exit check — verifies patched behaviors are present in installed dists.
# Usage: bash scripts/verify-pi-patches.sh
NM=node_modules/@earendil-works
fail=0
check() { # name file pattern
  if [ -f "$2" ] && grep -qF -- "$3" "$2" 2>/dev/null; then
    printf "  ok   %s\n" "$1"
  else
    printf "  FAIL %s\n       expected \"%s\" in %s\n" "$1" "$3" "$2"; fail=1
  fi
}
echo "── installed versions ──"
for p in pi-coding-agent pi-tui pi-ai; do
  printf "  %-18s %s\n" "$p" "$(node -p "require('./$NM/$p/package.json').version" 2>/dev/null || echo MISSING)"
done
echo "── pi-ai ──"
check "cache_creation_tokens fallback"  "$NM/pi-ai/dist/api/openai-completions.js" "cache_creation_tokens"
check "JSON-string arg coercion"        "$NM/pi-ai/dist/utils/validation.js" "coerceWithJsonSchema"
check "UPSTREAM normalizeOptionalNulls" "$NM/pi-ai/dist/utils/validation.js" "normalizeOptionalNulls"
check "OAuth page (postinstall)"        "$NM/pi-ai/dist/auth/oauth/oauth-page.js" "KIMCHI_OAUTH_TEMPLATE_DIR"
echo "── pi-tui ──"
check "stroke rendering"                "$NM/pi-tui/dist/utils.js" "applyStrokeToLine"
check "scrollback opt-out"              "$NM/pi-tui/dist/tui-main-screen.js" "PI_TUI_NO_CLEAR_SCROLLBACK"
check "narrow-terminal truncate"        "$NM/pi-tui/dist/components/text.js" "truncateToWidth"
check "UPSTREAM paddingX clamp"         "$NM/pi-tui/dist/components/text.js" "Math.floor((width - 1) / 2)"
echo "── pi-coding-agent ──"
check "KIMCHI_API_KEY help"             "$NM/pi-coding-agent/dist/cli/args.js" "KIMCHI_API_KEY"
check "kimchi-dev default model"        "$NM/pi-coding-agent/dist/core/model-resolver.js" '"kimchi-dev"'
check "builtin-provider filter"         "$NM/pi-coding-agent/dist/core/model-runtime.js" "KIMCHI_DISABLE_BUILTIN_PROVIDERS"
check "system-prompt preservation"      "$NM/pi-coding-agent/dist/core/agent-session.js" "_systemPromptOverride"
check "forced compaction type"          "$NM/pi-coding-agent/dist/core/extensions/types.d.ts" "force?: boolean"
check "previewTheme ext API"            "$NM/pi-coding-agent/dist/core/extensions/types.d.ts" "previewTheme"
check "Bun Type2 Proxy"                 "$NM/pi-coding-agent/dist/core/extensions/loader.js" "_bundledPiAiCompatSafe"
check "flag-conflict warnings"          "$NM/pi-coding-agent/dist/core/resource-loader.js" 'severity === "warning"'
check "bash timeout pipe destroy"       "$NM/pi-coding-agent/dist/core/tools/bash.js" "stdout?.destroy()"
check "numeric selector shortcuts"      "$NM/pi-coding-agent/dist/modes/interactive/components/extension-selector.js" "matchesKey(keyData, String(n))"
check "edit fg colouring (0.85.1 path)" "$NM/pi-coding-agent/dist/core/tools/renderers/edit.js" 'theme.fg("accent"'
echo
[ "$fail" = 0 ] && echo "All patched behaviors present." || echo "MISSING BEHAVIORS ABOVE — a hunk was dropped or landed wrong."
exit $fail
