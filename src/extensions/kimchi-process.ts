/**
 * Single source of truth for the `process.__kimchi*` side-channel globals.
 *
 * The upstream pi-mono bundle cannot import from this repo's source directly,
 * so the patch code reads these flags straight off `process`.  All TypeScript
 * code in this repo should go through the functions below — never cast and
 * write to `process` directly — so the contract stays in one place.
 *
 * __kimchiMultiModelEnabled — true while the virtual "multi-model" entry is
 *   the active selection.  Written by setMultiModelEnabled(); read by the
 *   model-selector patch to highlight the virtual entry.
 *
 * __kimchiOrchestratorRef  — "provider/model-id" string of the current
 *   orchestrator role.  Written whenever roles change (or at module init).
 *   The patch uses this to inject the correct virtual entry and to resolve
 *   which real model backs "multi-model".  It must NOT change when only the
 *   enabled flag changes — that was the staleness bug this module fixes.
 */

type KimchiProcess = NodeJS.Process & {
	__kimchiMultiModelEnabled?: boolean
	__kimchiOrchestratorRef?: string
}

const proc = process as KimchiProcess

// ---------------------------------------------------------------------------
// __kimchiMultiModelEnabled
// ---------------------------------------------------------------------------

export function getProcessMultiModelEnabled(): boolean | undefined {
	return proc.__kimchiMultiModelEnabled
}

export function setProcessMultiModelEnabled(enabled: boolean): void {
	proc.__kimchiMultiModelEnabled = enabled
}

// ---------------------------------------------------------------------------
// __kimchiOrchestratorRef
// ---------------------------------------------------------------------------

export function getProcessOrchestratorRef(): string | undefined {
	return proc.__kimchiOrchestratorRef
}

export function setProcessOrchestratorRef(ref: string): void {
	proc.__kimchiOrchestratorRef = ref
}
