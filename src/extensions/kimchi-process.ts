/**
 * Single source of truth for the `process.__kimchi*` side-channel globals.
 *
 * The upstream pi-mono bundle cannot import from this repo's source directly,
 * so the patch code reads these flags straight off `process`.  All TypeScript
 * code in this repo should go through the functions below — never cast and
 * write to `process` directly — so the contract stays in one place.
 *
 * __kimchiMultiModelEnabled.get(sessionId) — true while the virtual "multi-model"
 *   entry is the active selection.  Written by setMultiModelEnabled(); read by the
 *   model-selector patch to highlight the virtual entry.
 *
 * __kimchiOrchestratorRef.get(sessionId)  — "provider/model-id" string of the
 *   current orchestrator role.  Written whenever roles change (or at module init).
 *   The patch uses this to inject the correct virtual entry and to resolve which
 *   real model backs "multi-model".
 */

type KimchiProcess = NodeJS.Process & {
	__kimchiMultiModelEnabled?: Map<string, boolean>
	__kimchiOrchestratorRef?: Map<string, string>
}

const proc = process as KimchiProcess

// ---------------------------------------------------------------------------
// __kimchiMultiModelEnabled.get(sessionId)
// ---------------------------------------------------------------------------

export function getProcessMultiModelEnabled(sessionId: string): boolean | undefined {
	return proc.__kimchiMultiModelEnabled?.get(sessionId)
}

export function setProcessMultiModelEnabled(sessionId: string, enabled: boolean): void {
	if (!(proc.__kimchiMultiModelEnabled instanceof Map)) {
		proc.__kimchiMultiModelEnabled = new Map()
	}
	proc.__kimchiMultiModelEnabled.set(sessionId, enabled)
}

// ---------------------------------------------------------------------------
// __kimchiOrchestratorRef.get(sessionId)
// ---------------------------------------------------------------------------

/**
 * Read the per-session orchestrator ref from the process side-channel.
 * Returns the stored value if found, or falls back to the global default.
 */
export function getProcessOrchestratorRef(sessionId: string): string | undefined {
	return proc.__kimchiOrchestratorRef?.get(sessionId)
}

/**
 * Store multi-model orchestrator ref to be read by Pi.
 */
export function setProcessOrchestratorRef(sessionId: string, ref: string): void {
	if (!(proc.__kimchiOrchestratorRef instanceof Map)) {
		proc.__kimchiOrchestratorRef = new Map()
	}
	proc.__kimchiOrchestratorRef.set(sessionId, ref)
}
