# Pi coding-agent patch maintenance

Tracking: publication pending. The issue draft below is ready for `earendil-works/pi`; no upstream issue or PR has been filed for this selector change.

Upstream PR plan: propose a model-list rendering adapter, or a native capability table, with context-window and image-input metadata, optional descriptions, Unicode-aware width budgeting, all/scoped model lists, and narrow-terminal tests. Keep Kimchi's virtual multi-model row, description registry, and branding local.

Removal: remove the selector adapter when the pinned Pi release provides equivalent rendering extensibility or native capability columns. Remove other runtime/UI hunks when upstream provides equivalent APIs or Kimchi no longer needs the branded behavior. Remove trust hunks when Pi provides native trust-scan extensibility or Kimchi adopts Pi's config-directory layout. Keep trust resources synchronized with `TRUST_REQUIRING_PROJECT_RESOURCES` in `src/project-scope-trust.ts` until then.

## Upstream issue draft

Title: Expose model-list rendering customization for capability-aware selectors

Pi's model selector displays model IDs and providers, while integrations need to help users compare context-window size, image-input support, and optional catalog descriptions before switching. Maintaining a patched copy of the selector's layout makes integrations diverge from upstream refresh, filtering, and selection behavior.

Please consider a model-list rendering adapter receiving the filtered models, current/default/selected state, theme, and available terminal width. Alternatively, a native capability table could expose context and vision columns with optional descriptions.

The adapter should serve both all-model and scoped-model lists and preserve existing fuzzy search, scrolling, model selection, and model-name details. Its rendering contract should require each line to fit the supplied terminal width using terminal cell widths, including wide Unicode text. A narrow-width fallback must retain any integration-provided warning marker.

An upstream PR would cover wide and narrow terminals, long identifiers/providers, Unicode descriptions, both list scopes, and unchanged behavior when no renderer is supplied. Kimchi-specific rows, branding, and description storage would remain in the integration.

## Regenerating the local patch

Use `pnpm patch @earendil-works/pi-coding-agent@0.85.1`, edit the extracted package, then run `pnpm exec node scripts/commit-pi-patch.js <edit-directory>`. The script generates the patch with pnpm, preserves its maintenance header, and reinstalls it so runtime tests exercise the generated result. Update the tracking URL in this document after the issue is published.
