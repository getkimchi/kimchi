import type { CustomEntry, ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"
import { readConfigSetting } from "../config/settings.js"
import { getProcessMultiModelEnabled, setProcessMultiModelEnabled } from "./kimchi-process.js"

// --- Source tags ---
export type MultiModelSource = "runtime" | "cli" | "persisted" | "global"

export interface MultiModelResolution {
	value: boolean
	source: MultiModelSource
}

// --- Precedence layers (highest to lowest) ---
// 1. In-session runtime selection (process map, set by user actions mid-session) → source: "runtime"
// 2. Explicit --model CLI flag (computed once at startup)                        → source: "cli"
// 3. Persisted session-log value (last custom entry in session entries)          → source: "persisted"
// 4. Global config default (settings.json "multiModel" key, default true)        → source: "global"

const MULTI_MODEL_SESSION_ENTRY_TYPE = "multi_model_enabled"

/** Whether --model was passed on the CLI. */
export function hasExplicitModelFlag(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i]?.startsWith("--model=")) return true
	}
	return false
}

/** The global config default (settings.json or hardcoded true). */
export function getGlobalDefault(): boolean {
	return readConfigSetting("multiModel", (value) => typeof value === "boolean") ?? true
}

/** Read ONLY the persisted value from session entries. Does NOT check process map. */
export function getPersistedMultiModelEnabled(sessionManager: Pick<SessionManager, "getEntries">): boolean | undefined {
	const lastEntry = sessionManager
		.getEntries()
		.findLast(
			(item): item is CustomEntry<boolean> =>
				item.type === "custom" && item.customType === MULTI_MODEL_SESSION_ENTRY_TYPE,
		)
	return lastEntry?.data
}

/**
 * Resolve the effective multi-model enabled state AND its source.
 *
 * Precedence: process map ("runtime") > CLI --model ("cli") > persisted session ("persisted") > global default ("global").
 *
 * The source tag is essential for reconciliation: values originating from
 * the "cli" source must NOT be persisted to the session log because --model
 * is a per-invocation override.
 *
 * Internal consumers that need the source tag call this function.
 * External consumers that just need the boolean call getMultiModelEnabled().
 */
export function resolveMultiModelEnabled(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId"> | null,
): MultiModelResolution {
	if (sessionManager) {
		const sessionId = sessionManager.getSessionId()
		const runtime = getProcessMultiModelEnabled(sessionId)
		if (runtime !== undefined) return { value: runtime, source: "runtime" }
	}

	// CLI flag ranks above persisted & global, but below runtime.
	// Check BEFORE persisted so that --model overrides a stale session value.
	if (hasExplicitModelFlag()) return { value: false, source: "cli" }

	if (sessionManager) {
		const persisted = getPersistedMultiModelEnabled(sessionManager)
		if (persisted !== undefined) return { value: persisted, source: "persisted" }
	}

	return { value: getGlobalDefault(), source: "global" }
}

/** Returns the effective multi-model enabled boolean. */
export function getMultiModelEnabled(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId"> | null,
): boolean {
	return resolveMultiModelEnabled(sessionManager).value
}

/** Writes the multi-model flag to the current process, keyed by session ID. */
export function setMultiModelEnabled(sessionId: string, enabled: boolean): void {
	setProcessMultiModelEnabled(sessionId, enabled)
}

/**
 * Reconcile: if the effective value differs from the persisted value,
 * persist it to the session log — UNLESS the effective value comes solely
 * from the --model CLI flag (source === "cli").
 *
 * Always syncs the process map so patches can read the effective value.
 * Returns the resolution (value + source).
 */
export function setAndPersistMultiModelEnabled(
	sessionId: string,
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">,
	appendCtx: Pick<SessionManager, "appendCustomEntry"> | Pick<ExtensionAPI, "appendEntry">,
): MultiModelResolution {
	const resolution = resolveMultiModelEnabled(sessionManager)
	const persisted = getPersistedMultiModelEnabled(sessionManager)

	// Always sync the process map so patches can read it
	setProcessMultiModelEnabled(sessionId, resolution.value)

	// Persist only when:
	//   (a) the effective value diverges from what's on disk, AND
	//   (b) the effective value is NOT derived solely from --model CLI flag.
	// If source is "runtime", the user explicitly toggled mid-session, so
	// we persist even if --model was also present (runtime outranks cli).
	if (persisted !== resolution.value && resolution.source !== "cli") {
		const append = "appendCustomEntry" in appendCtx ? appendCtx.appendCustomEntry : appendCtx.appendEntry
		append(MULTI_MODEL_SESSION_ENTRY_TYPE, resolution.value)
	}

	return resolution
}
