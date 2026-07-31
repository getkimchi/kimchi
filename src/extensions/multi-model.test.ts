import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock readConfigSetting so getGlobalDefault() is deterministic and does NOT
// touch the real filesystem.  The mock value is controlled per-test via
// `setGlobalConfig()`.
// ---------------------------------------------------------------------------

let _globalConfig: Record<string, unknown> = {}

vi.mock("../config/settings.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config/settings.js")>()
	return {
		...original,
		readConfigSetting: (key: string, satisfies: (v: unknown) => boolean) => {
			const v = _globalConfig[key]
			return satisfies(v) ? (v as never) : undefined
		},
	}
})

import { getProcessMultiModelEnabled } from "./kimchi-process.js"
import {
	getGlobalDefault,
	getMultiModelEnabled,
	getPersistedMultiModelEnabled,
	hasExplicitModelFlag,
	isSyntheticMultiModelRefPersisted,
	resolveMultiModelEnabled,
	setAndPersistMultiModelEnabled,
	setMultiModelEnabled,
} from "./multi-model.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-001"

type MinimalSM = {
	getEntries: () => SessionEntry[]
	getSessionId: () => string
}

/** Build a minimal session manager with the given entries. */
function makeSessionManager(entries: SessionEntry[] = [], sessionId = SESSION_ID): MinimalSM {
	return {
		getEntries: () => entries,
		getSessionId: () => sessionId,
	}
}

/** Build a CustomEntry<boolean> for the multi_model_enabled custom type. */
function mmEntry(data: boolean, ts = Date.now()): CustomEntry<boolean> {
	return {
		type: "custom",
		id: `entry-${ts}-${Math.random()}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		customType: "multi_model_enabled",
		data,
	}
}

/** Control the global config returned by the mocked readConfigSetting. */
function setGlobalConfig(config: Record<string, unknown>): void {
	_globalConfig = config
}

/** Spy on process.argv; restore in afterEach. */
let argvSpy: ReturnType<typeof vi.spyOn> | null = null
function setArgv(args: string[]): void {
	argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(args)
}

function clearArgv(): void {
	if (argvSpy) {
		argvSpy.mockRestore()
		argvSpy = null
	}
}

/** Reset the process side-channel map for our test session id. */
function resetProcessMap(): void {
	const proc = process as NodeJS.Process & {
		__kimchiMultiModelEnabled?: Map<string, boolean>
	}
	proc.__kimchiMultiModelEnabled?.delete(SESSION_ID)
}

beforeEach(() => {
	_globalConfig = {}
	resetProcessMap()
	clearArgv()
})

afterEach(() => {
	resetProcessMap()
	clearArgv()
})

// ---------------------------------------------------------------------------
// getPersistedMultiModelEnabled
// ---------------------------------------------------------------------------

describe("getPersistedMultiModelEnabled", () => {
	it("returns undefined when no entries exist", () => {
		const sm = makeSessionManager([])
		expect(getPersistedMultiModelEnabled(sm)).toBeUndefined()
	})

	it("returns the last persisted value when multiple entries exist", () => {
		const entries: SessionEntry[] = [mmEntry(true, 1000), mmEntry(false, 2000), mmEntry(true, 3000)]
		const sm = makeSessionManager(entries)
		expect(getPersistedMultiModelEnabled(sm)).toBe(true)
	})

	it("ignores non-matching custom types", () => {
		const entries: SessionEntry[] = [{ ...mmEntry(true, 1000), customType: "other_type" }, mmEntry(false, 2000)]
		const sm = makeSessionManager(entries)
		expect(getPersistedMultiModelEnabled(sm)).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// resolveMultiModelEnabled — precedence + source tagging
// ---------------------------------------------------------------------------

describe("resolveMultiModelEnabled", () => {
	it("returns { value, source: 'runtime' } when process map is set (highest precedence)", () => {
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "runtime",
		})
	})

	it("F8: session entry is audit-only — does NOT override global default in resolution", () => {
		// Previously this returned { value: false, source: 'persisted' }, creating a
		// feedback loop (F8): a transient override snapshotted into the session
		// entry could disable multi-model on resume even when the global synthetic
		// ref says ON. The session entry is now audit-only: resolution falls
		// through to the global default (true on empty config).
		const sm = makeSessionManager([mmEntry(false)])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
	})

	it("returns { value: true, source: 'global' } when both are empty and no --model flag", () => {
		setGlobalConfig({})
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
	})

	it("returns the configured global default when multiModel is set in settings", () => {
		setGlobalConfig({ multiModel: false })
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "global",
		})
	})

	it("--model flag present, no persisted value -> returns { value: false, source: 'cli' }", () => {
		setArgv(["node", "cli", "--model", "some-model"])
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "cli",
		})
	})

	it("--model flag present, persisted true in session -> returns { value: false, source: 'cli' } (CLI ranks above persisted)", () => {
		setArgv(["node", "cli", "--model", "some-model"])
		const sm = makeSessionManager([mmEntry(true)])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "cli",
		})
	})

	it("--model flag present, but process map set to true (runtime) -> returns { value: true, source: 'runtime' } (runtime ranks above CLI)", () => {
		setArgv(["node", "cli", "--model", "some-model"])
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "runtime",
		})
	})

	it("handles --model=value form", () => {
		setArgv(["node", "cli", "--model=some-model"])
		const sm = makeSessionManager([])
		expect(hasExplicitModelFlag()).toBe(true)
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "cli",
		})
	})

	it("returns global default when sessionManager is null", () => {
		setGlobalConfig({})
		expect(resolveMultiModelEnabled(null)).toEqual({
			value: true,
			source: "global",
		})
	})
})

// ---------------------------------------------------------------------------
// getMultiModelEnabled — boolean wrapper
// ---------------------------------------------------------------------------

describe("getMultiModelEnabled", () => {
	it("returns a plain boolean matching resolveMultiModelEnabled(...).value for each precedence layer", () => {
		// runtime
		setMultiModelEnabled(SESSION_ID, true)
		const smRuntime = makeSessionManager([mmEntry(false)])
		expect(getMultiModelEnabled(smRuntime)).toBe(true)
		expect(typeof getMultiModelEnabled(smRuntime)).toBe("boolean")

		// cli
		resetProcessMap()
		setArgv(["node", "cli", "--model"])
		const smCli = makeSessionManager([])
		expect(getMultiModelEnabled(smCli)).toBe(false)
		expect(typeof getMultiModelEnabled(smCli)).toBe("boolean")

		// global
		clearArgv()
		setGlobalConfig({})
		const smGlobal = makeSessionManager([])
		expect(getMultiModelEnabled(smGlobal)).toBe(true)
		expect(typeof getMultiModelEnabled(smGlobal)).toBe("boolean")

		// F8: session entry is audit-only — a persisted false entry does NOT
		// override the global default in resolution (falls through to global true).
		const smAuditOnly = makeSessionManager([mmEntry(false)])
		expect(getMultiModelEnabled(smAuditOnly)).toBe(true)
		expect(typeof getMultiModelEnabled(smAuditOnly)).toBe("boolean")
	})
})

// ---------------------------------------------------------------------------
// hasExplicitModelFlag / getGlobalDefault
// ---------------------------------------------------------------------------

describe("hasExplicitModelFlag", () => {
	it("returns true when --model is present", () => {
		setArgv(["node", "cli", "--model"])
		expect(hasExplicitModelFlag()).toBe(true)
	})

	it("returns false when --model is absent", () => {
		setArgv(["node", "cli", "--other-flag"])
		expect(hasExplicitModelFlag()).toBe(false)
	})
})

	describe("isSyntheticMultiModelRefPersisted", () => {
	it("returns true when defaultProvider=orchestration and defaultModel=multi-model", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		expect(isSyntheticMultiModelRefPersisted()).toBe(true)
	})

	it("returns false when only defaultProvider matches", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "kimi-k2.6" })
		expect(isSyntheticMultiModelRefPersisted()).toBe(false)
	})

	it("returns false when only defaultModel matches", () => {
		setGlobalConfig({ defaultProvider: "kimchi-dev", defaultModel: "multi-model" })
		expect(isSyntheticMultiModelRefPersisted()).toBe(false)
	})

	it("returns false when neither matches", () => {
		setGlobalConfig({ defaultProvider: "kimchi-dev", defaultModel: "glm-5.2-fp8" })
		expect(isSyntheticMultiModelRefPersisted()).toBe(false)
	})

	it("returns false when keys are absent", () => {
		setGlobalConfig({})
		expect(isSyntheticMultiModelRefPersisted()).toBe(false)
	})

	it("returns false when values are non-string", () => {
		setGlobalConfig({ defaultProvider: 123, defaultModel: "multi-model" })
		expect(isSyntheticMultiModelRefPersisted()).toBe(false)
	})
})

describe("getGlobalDefault", () => {
	it("returns true when the synthetic multi-model ref is persisted", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		expect(getGlobalDefault()).toBe(true)
	})

	it("synthetic ref outranks the legacy multiModel=false boolean", () => {
		setGlobalConfig({
			defaultProvider: "orchestration",
			defaultModel: "multi-model",
			multiModel: false,
		})
		expect(getGlobalDefault()).toBe(true)
	})

	it("returns the configured multiModel setting when boolean and no synthetic ref", () => {
		setGlobalConfig({ multiModel: false })
		expect(getGlobalDefault()).toBe(false)
	})

	it("returns true (hardcoded default) when multiModel is absent", () => {
		setGlobalConfig({})
		expect(getGlobalDefault()).toBe(true)
	})

	it("returns true when multiModel is not a boolean", () => {
		setGlobalConfig({ multiModel: "yes" })
		expect(getGlobalDefault()).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// Phase 2 bug-fix tests: F1 (fresh-install default-on), F2 (--model + synthetic ref),
// F4 (error-path state + recovery)
// ---------------------------------------------------------------------------

describe("F1: fresh-install default-on via ?? true fallback", () => {
	it("returns true when config is completely empty (no keys at all)", () => {
		// Truly fresh install: no defaultProvider, no defaultModel, no multiModel.
		// The hardcoded `?? true` is the ONLY path that fires.
		setGlobalConfig({})
		expect(getGlobalDefault()).toBe(true)
	})

	it("resolveMultiModelEnabled returns { value: true, source: 'global' } on fresh install", () => {
		setGlobalConfig({})
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
	})
})

describe("F2: --model CLI flag silently disables persisted multi-model (recovers next run)", () => {
	it("synthetic ref persisted + --model -> resolveMultiModelEnabled returns false (cli wins)", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		setArgv(["node", "cli", "--model", "kimi-k2.6"])
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "cli",
		})
	})

	it("synthetic ref is NOT mutated by --model (persisted ref preserved for next run)", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		setArgv(["node", "cli", "--model", "kimi-k2.6"])
		// --model forces false for this invocation, but the persisted synthetic
		// ref is untouched: isSyntheticMultiModelRefPersisted still reads true.
		expect(isSyntheticMultiModelRefPersisted()).toBe(true)
	})

	it("after clearing --model, multi-model resumes from the persisted synthetic ref", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		// Simulate the next invocation: no --model flag
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
	})
})

describe("F4: /model shortcut error-path state (process map false + synthetic ref persisted)", () => {
	it("runtime false overrides persisted synthetic ref (error-path state resolves false)", () => {
		// Simulates the shortcut error path: process map reset to false while
		// the synthetic ref remains persisted in global config.
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		setMultiModelEnabled(SESSION_ID, false)
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "runtime",
		})
	})

	it("recovers after session restart: process map cleared -> global synthetic ref wins", () => {
		// New session: process map is empty for the new session id.
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		const sm = makeSessionManager([])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
	})

	it("setAndPersistMultiModelEnabled reconciles the error-path state back to true", () => {
		// Error path left process map=false, persisted session entry absent.
		// setAndPersistMultiModelEnabled resolves from global (synthetic ref=true),
		// syncs the process map to true, and persists the session entry.
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		const { persist, spy } = makePersist()
		const sm = makeSessionManager([])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "global" })
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(true)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
	})
})

// ---------------------------------------------------------------------------
// setAndPersistMultiModelEnabled
// ---------------------------------------------------------------------------

/** Create a persist mock with an appendCustomEntry spy. Returns the object and the spy. */
function makePersist(): {
	persist: { appendCustomEntry: ReturnType<typeof vi.fn> }
	spy: ReturnType<typeof vi.fn>
} {
	const spy = vi.fn()
	return { persist: { appendCustomEntry: spy }, spy }
}

/** Create a persist mock with an appendEntry spy (ExtensionAPI-like). Returns the object and the spy. */
function makePersistApi(): {
	persist: { appendEntry: ReturnType<typeof vi.fn> }
	spy: ReturnType<typeof vi.fn>
} {
	const spy = vi.fn()
	return { persist: { appendEntry: spy }, spy }
}

describe("F8 regression: legacy persisted session entry must not alter runtime behavior (no migration)", () => {
	// Scenario: a session created BEFORE the audit-only change has a stale
	// `multi_model_enabled: false` entry persisted (e.g. from a transient ACP
	// disable that got snapshotted). Under the OLD resolution, resuming that
	// session would read the stale false and disable multi-model — the feedback
	// loop. Under the NEW (audit-only) resolution, the entry is ignored and
	// the global synthetic ref wins. This test proves no migration is required:
	// existing persisted sessions do not need their session entries rewritten.

	it("legacy session entry false + global synthetic ref ON -> resolves true (global)", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		const sm = makeSessionManager([mmEntry(false)]) // legacy stale entry
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "global",
		})
		expect(getMultiModelEnabled(sm)).toBe(true)
	})

	it("legacy session entry false + global synthetic ref ON + --model -> resolves false (cli)", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		setArgv(["node", "cli", "--model", "kimi-k2.6"])
		const sm = makeSessionManager([mmEntry(false)]) // legacy stale entry
		// CLI still wins (cli > global), and the legacy entry is ignored either way.
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "cli",
		})
	})

	it("legacy session entry false + runtime override true -> resolves true (runtime)", () => {
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)]) // legacy stale entry
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: true,
			source: "runtime",
		})
	})

	it("reconciliation corrects the stale legacy entry via drift detection", () => {
		// setAndPersistMultiModelEnabled still reads the legacy entry for DRIFT
		// detection (audit). Effective (global true) != persisted (false) -> drift
		// -> the corrected value is persisted, self-healing the stale entry.
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		const { persist, spy } = makePersist()
		const sm = makeSessionManager([mmEntry(false)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "global" })
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
	})

	it("F8 empirical reproduction: transient ACP disable snapshotted to entry must NOT survive session resume", () => {
		// This is the EXACT feedback-loop scenario the F8 fix prevents.
		// Step 1: multi-model is ON via global synthetic ref.
		setGlobalConfig({ defaultProvider: "orchestration", defaultModel: "multi-model" })
		const sessionEntries: SessionEntry[] = []

		// Step 2: A transient ACP disable sets a runtime override to false.
		setMultiModelEnabled(SESSION_ID, false)
		const sm1 = makeSessionManager(sessionEntries)

		// Step 3: setAndPersistMultiModelEnabled snapshots the transient false
		// into the session entry (this is the write path — still happens under
		// the fix; the entry is audit-only for READS, not writes).
		const { persist, spy } = makePersist()
		const result1 = setAndPersistMultiModelEnabled(SESSION_ID, sm1, persist)
		expect(result1).toEqual({ value: false, source: "runtime" })
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", false)

		// Simulate the snapshot landing in the session entry list.
		sessionEntries.push(mmEntry(false))

		// Step 4: Session resumes in a NEW process — the runtime map is cleared
		// (process.__kimchiMultiModelEnabled is in-memory only, lost on restart).
		resetProcessMap()
		const sm2 = makeSessionManager(sessionEntries)

		// Step 5: resolveMultiModelEnabled must return true (global synthetic ref),
		// NOT the stale false from the session entry. Under the OLD code (pre-F8),
		// this would return { value: false, source: "persisted" } — the feedback loop.
		const result2 = resolveMultiModelEnabled(sm2)
		expect(result2).toEqual({ value: true, source: "global" })
		expect(getMultiModelEnabled(sm2)).toBe(true)
	})
})

describe("setAndPersistMultiModelEnabled", () => {
	it("persists when effective differs from persisted AND source is 'runtime'", () => {
		const { persist, spy } = makePersist()
		// process map has true (runtime), persisted has false -> drift, runtime source
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "runtime" })
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
	})

	it("persists when effective differs from persisted AND source is 'global'", () => {
		const { persist, spy } = makePersist()
		setGlobalConfig({ multiModel: false })
		// no process map, no --model, no persisted entry -> global default false, persisted undefined -> drift
		const sm = makeSessionManager([])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: false, source: "global" })
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", false)
	})

	it("does NOT persist when effective differs from persisted AND source is 'cli' (no persisted value)", () => {
		const { persist, spy } = makePersist()
		setArgv(["node", "cli", "--model", "some-model"])
		// no process map, --model present, no persisted -> effective false (cli), persisted undefined -> drift but cli source
		const sm = makeSessionManager([])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: false, source: "cli" })
		expect(spy).not.toHaveBeenCalled()
	})

	it("does NOT persist when effective differs from persisted AND source is 'cli' (persisted true -> effective false)", () => {
		const { persist, spy } = makePersist()
		setArgv(["node", "cli", "--model", "some-model"])
		// no process map, --model present, persisted true -> effective false (cli outranks persisted), drift but cli source
		const sm = makeSessionManager([mmEntry(true)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: false, source: "cli" })
		expect(spy).not.toHaveBeenCalled()
	})

	it("F8: persisted session entry drives drift detection (audit), not resolution", () => {
		const { persist, spy } = makePersist()
		// no process map, no --model. Session entry says false, but the session
		// entry is audit-only — resolution falls through to the global default
		// (true on empty config). Effective (true) differs from persisted (false),
		// so drift IS detected and the corrected value is persisted.
		const sm = makeSessionManager([mmEntry(false)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "global" })
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
	})

	it("always syncs process map regardless of persistence decision", () => {
		const { persist, spy } = makePersist()
		// cli source -> no persistence, but process map should still be synced to false
		setArgv(["node", "cli", "--model", "some-model"])
		const sm = makeSessionManager([])

		setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
		expect(spy).not.toHaveBeenCalled()
	})

	it("also syncs process map when persistence DOES occur", () => {
		const { persist } = makePersist()
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)])

		setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(true)
	})

	it("user toggles multi-model ON mid-session despite --model -> runtime source, effective true is persisted", () => {
		const { persist, spy } = makePersist()
		// --model is present, but user toggled ON via setMultiModelEnabled (runtime)
		setArgv(["node", "cli", "--model", "some-model"])
		setMultiModelEnabled(SESSION_ID, true)
		// persisted was false (or undefined); runtime outranks cli
		const sm = makeSessionManager([mmEntry(false)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "runtime" })
		// persisted (false) !== effective (true) AND source !== "cli" -> persist
		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
		// process map synced to effective value
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(true)
	})

	it("does not persist when global default equals persisted value (no drift)", () => {
		const { persist, spy } = makePersist()
		setGlobalConfig({})
		// global default true, persisted true -> no drift. Resolution source is
		// 'global' (session entry is audit-only), but no drift means no persist.
		const sm = makeSessionManager([mmEntry(true)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "global" })
		expect(spy).not.toHaveBeenCalled()
	})

	it("calls appendEntry when given an ExtensionAPI-like context", () => {
		const { persist, spy } = makePersistApi()
		// Set a runtime drift: process map has true, persisted has false
		setMultiModelEnabled(SESSION_ID, true)
		const sm = makeSessionManager([mmEntry(false)])

		setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith("multi_model_enabled", true)
	})
})

// ---------------------------------------------------------------------------
// setMultiModelEnabled (process map only)
// ---------------------------------------------------------------------------

describe("setMultiModelEnabled", () => {
	it("writes to the process map only and does not persist", () => {
		setMultiModelEnabled(SESSION_ID, true)
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(true)
	})
})
