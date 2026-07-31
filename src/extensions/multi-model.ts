import type { CustomEntry, ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"
import { readConfigSetting } from "../config/settings.js"
import { getProcessMultiModelEnabled, setProcessMultiModelEnabled } from "./kimchi-process.js"

// --- Source tags ---
// Note: "persisted" was removed when the session entry became audit-only (F8).
// It is retained here only for type-level backward compat with any external
// consumers that may still reference the union; resolution never emits it.
export type MultiModelSource = "runtime" | "cli" | "global"

export interface MultiModelResolution {
	value: boolean
	source: MultiModelSource
}

// --- Precedence layers (highest to lowest) ---
// 1. In-session runtime selection (process map, set by user actions mid-session) → source: "runtime"
// 2. Explicit --model CLI flag (computed once at startup)                        → source: "cli"
// 3. Global config default — synthetic model ref `orchestration/multi-model`
//    persisted in defaultModel/defaultProvider by the model picker, falling back
//    to the legacy `multiModel` boolean key (deprecated) and then hardcoded true  → source: "global"
//
// NOTE: the `multi_model_enabled` session entry is AUDIT-ONLY. It is written by
// setAndPersistMultiModelEnabled for export/audit (config.multi_model_enabled)
// and for drift detection, but it is NO LONGER READ for resolution. Reading a
// cached prior resolution back as a resolution input created a feedback loop
// (F8): a transient override snapshotted into the session entry could disable
// multi-model on session resume even when the global synthetic ref says ON.

const MULTI_MODEL_SESSION_ENTRY_TYPE = "multi_model_enabled"

/** Provider/model id pair persisted as the synthetic multi-model selection. */
const SYNTHETIC_MULTI_MODEL_PROVIDER = "orchestration"
const SYNTHETIC_MULTI_MODEL_ID = "multi-model"

/** Whether --model was passed on the CLI.
 *
 * When --model is present, multi-model mode is forced OFF for this invocation
 * (the CLI override wins; see resolveMultiModelEnabled, source "cli"). This
 * is intended — --model means "use exactly this model, do not delegate" — but
 * it means a persisted synthetic ref is silently bypassed for the run. The
 * persisted ref is NOT mutated, so multi-model resumes on the next invocation
 * without --model.
 */
export function hasExplicitModelFlag(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--model" || args[i]?.startsWith("--model=")) return true
	}
	return false
}

/**
 * Returns true when the persisted default model selection is the synthetic
 * `orchestration/multi-model` ref. This is how multi-model mode survives
 * across sessions: the model picker writes the synthetic ref into
 * defaultModel/defaultProvider exactly like a real model, and this function
 * reads it back as the global default.
 */
export function isSyntheticMultiModelRefPersisted(): boolean {
	const provider = readConfigSetting("defaultProvider", (value) => typeof value === "string")
	const modelId = readConfigSetting("defaultModel", (value) => typeof value === "string")
	return provider === SYNTHETIC_MULTI_MODEL_PROVIDER && modelId === SYNTHETIC_MULTI_MODEL_ID
}

/**
 * The global config default.
 *
 * Within the global layer the synthetic ref outranks the legacy boolean: if
 * the picker has persisted `orchestration/multi-model` as the default model,
 * multi-model mode is the global default. Otherwise the deprecated
 * `multiModel` boolean is consulted, then hardcoded `true`.
 *
 * The `?? true` fallback means multi-model mode is the DEFAULT for every fresh
 * install with no explicit config. This is a deliberate product decision:
 * multi-model (orchestrator-delegates) is the intended default UX, not a
 * opt-in feature. A user who wants single-model behavior persists a real model
 * ref via the picker, which clears the synthetic ref and flips the global
 * default to false via the `multiModel: false` path (or, post-migration, by
 * persisting a non-synthetic defaultModel).
 */
export function getGlobalDefault(): boolean {
	if (isSyntheticMultiModelRefPersisted()) return true
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
 * Precedence: process map ("runtime") > CLI --model ("cli") > global default ("global").
 *
 * The session-log `multi_model_enabled` entry is NOT consulted here — it is
 * audit-only (see setAndPersistMultiModelEnabled for the write path). Reading it
 * back as a resolution input created a feedback loop (F8): a transient override
 * (e.g. an ACP disable) snapshotted into the entry would incorrectly disable
 * multi-model on session resume, overriding the global synthetic ref.
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

	// CLI flag ranks above global, but below runtime.
	if (hasExplicitModelFlag()) return { value: false, source: "cli" }

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
