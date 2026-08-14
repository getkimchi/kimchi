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

	it("returns { value, source: 'persisted' } when process map is empty and session has persisted value", () => {
		const sm = makeSessionManager([mmEntry(false)])
		expect(resolveMultiModelEnabled(sm)).toEqual({
			value: false,
			source: "persisted",
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

		// persisted
		resetProcessMap()
		const smPersisted = makeSessionManager([mmEntry(false)])
		expect(getMultiModelEnabled(smPersisted)).toBe(false)
		expect(typeof getMultiModelEnabled(smPersisted)).toBe("boolean")

		// cli
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

describe("getGlobalDefault", () => {
	it("returns the configured multiModel setting when boolean", () => {
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

	it("does NOT persist when effective equals persisted (no drift)", () => {
		const { persist, spy } = makePersist()
		// no process map, no --model, persisted false -> effective false (persisted), no drift
		const sm = makeSessionManager([mmEntry(false)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: false, source: "persisted" })
		expect(spy).not.toHaveBeenCalled()
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
		// global default true, persisted true -> no drift
		const sm = makeSessionManager([mmEntry(true)])

		const result = setAndPersistMultiModelEnabled(SESSION_ID, sm, persist)

		expect(result).toEqual({ value: true, source: "persisted" })
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
