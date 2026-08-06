import type { CustomEntry, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
	createSessionPermissionFlagController,
	getSessionLogPermissionMode,
	getSessionPermissionsEnvKey,
	hasExplicitCliPermissionMode,
	PERMISSION_MODE_SESSION_ENTRY_TYPE,
	type PersistedPermissionMode,
	resolvePermissionMode,
	setAndPersistPermissionMode,
} from "./mode-controller.js"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
	unregisterSessionPermissionFlagController,
} from "./mode-controller-registry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "test-session-mode-001"

type MinimalSM = {
	getEntries: () => SessionEntry[]
	getSessionId: () => string
	appendCustomEntry: (customType: string, data?: unknown) => string
}

function makeSessionManager(entries: SessionEntry[] = [], sessionId = SESSION_ID): MinimalSM {
	return {
		getEntries: () => entries,
		getSessionId: () => sessionId,
		appendCustomEntry: vi.fn(() => "entry-id"),
	}
}

function pmEntry(data: PersistedPermissionMode, ts = Date.now()): CustomEntry<PersistedPermissionMode> {
	return {
		type: "custom",
		id: `entry-${ts}-${Math.random()}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
		data,
	}
}

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

function resetSession(): void {
	Reflect.deleteProperty(process.env, getSessionPermissionsEnvKey(SESSION_ID))
	// Clear any runtime controller so resolver tests fall through to persisted/global.
	unregisterSessionPermissionFlagController(SESSION_ID)
}

beforeEach(() => {
	clearArgv()
	resetSession()
})

afterEach(() => {
	clearArgv()
	Reflect.deleteProperty(process.env, getSessionPermissionsEnvKey(SESSION_ID))
})

// ---------------------------------------------------------------------------
// getSessionLogPermissionMode
// ---------------------------------------------------------------------------

describe("getSessionLogPermissionMode", () => {
	it("returns undefined when no entries exist", () => {
		const sm = makeSessionManager([])
		expect(getSessionLogPermissionMode(sm)).toBeUndefined()
	})

	it("returns the last persisted {mode, source} when multiple entries exist", () => {
		const entries: SessionEntry[] = [
			pmEntry({ mode: "default", source: "user" }, 1000),
			pmEntry({ mode: "plan", source: "user" }, 2000),
			pmEntry({ mode: "yolo", source: "user" }, 3000),
		]
		const sm = makeSessionManager(entries)
		expect(getSessionLogPermissionMode(sm)).toEqual({ mode: "yolo", source: "user" })
	})

	it("ignores non-matching custom types", () => {
		const entries: SessionEntry[] = [
			{ ...pmEntry({ mode: "yolo", source: "user" }, 1000), customType: "other_type" },
			pmEntry({ mode: "plan", source: "user" }, 2000),
		]
		const sm = makeSessionManager(entries)
		expect(getSessionLogPermissionMode(sm)).toEqual({ mode: "plan", source: "user" })
	})

	it("returns undefined when sessionManager is null", () => {
		expect(getSessionLogPermissionMode(null)).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// hasExplicitCliPermissionMode
// ---------------------------------------------------------------------------

describe("hasExplicitCliPermissionMode", () => {
	it("returns true when --yolo is present", () => {
		setArgv(["node", "cli", "--yolo"])
		expect(hasExplicitCliPermissionMode()).toBe(true)
	})

	it("returns true when --dangerously-skip-permissions is present", () => {
		setArgv(["node", "cli", "--dangerously-skip-permissions"])
		expect(hasExplicitCliPermissionMode()).toBe(true)
	})

	it("returns false when neither flag is present", () => {
		setArgv(["node", "cli", "--some-other-flag"])
		expect(hasExplicitCliPermissionMode()).toBe(false)
	})

	it("returns false on empty argv", () => {
		setArgv([])
		expect(hasExplicitCliPermissionMode()).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// resolvePermissionMode — precedence + source tagging
// ---------------------------------------------------------------------------

describe("resolvePermissionMode", () => {
	it("returns {mode:'default', source:'global'} when nothing is set", () => {
		expect(resolvePermissionMode(null)).toEqual({ mode: "default", source: "global" })
	})

	it("returns {mode, source:'persisted'} when session has a persisted entry", () => {
		const sm = makeSessionManager([pmEntry({ mode: "plan", source: "user" })])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "plan", source: "persisted" })
	})

	it("returns {mode:'yolo', source:'cli'} when --yolo is passed (CLI outranks persisted)", () => {
		setArgv(["node", "cli", "--yolo"])
		const sm = makeSessionManager([pmEntry({ mode: "plan", source: "user" })])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "yolo", source: "cli" })
	})

	it("returns {mode:'yolo', source:'cli'} when --dangerously-skip-permissions is passed", () => {
		setArgv(["node", "cli", "--dangerously-skip-permissions"])
		const sm = makeSessionManager([])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "yolo", source: "cli" })
	})

	it("returns {mode, source:'runtime'} when per-session controller is registered (runtime outranks CLI)", () => {
		setArgv(["node", "cli", "--yolo"])
		registerSessionPermissionFlagController(
			SESSION_ID,
			createSessionPermissionFlagController({ mode: { mode: "plan", source: "user" } }),
		)
		const sm = makeSessionManager([])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "plan", source: "runtime" })
	})

	it("returns {mode, source:'persisted'} when CLI is absent and controller is absent", () => {
		const sm = makeSessionManager([pmEntry({ mode: "auto", source: "ferment" })])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "auto", source: "persisted" })
	})

	it("falls back to global default when sessionManager has no entries and no other signal", () => {
		const sm = makeSessionManager([])
		expect(resolvePermissionMode(sm)).toEqual({ mode: "default", source: "global" })
	})
})

// ---------------------------------------------------------------------------
// setAndPersistPermissionMode — reconciler + ferment-source persistence
// ---------------------------------------------------------------------------

function makeAppendCtx(): { ctx: { appendCustomEntry: ReturnType<typeof vi.fn> }; spy: ReturnType<typeof vi.fn> } {
	const spy = vi.fn(() => "entry-id")
	return { ctx: { appendCustomEntry: spy }, spy }
}

function makeApiAppendCtx(): { ctx: { appendEntry: ReturnType<typeof vi.fn> }; spy: ReturnType<typeof vi.fn> } {
	const spy = vi.fn()
	return { ctx: { appendEntry: spy }, spy }
}

describe("setAndPersistPermissionMode", () => {
	it("writes a custom entry when no prior persisted value exists (user source)", () => {
		const { ctx, spy } = makeAppendCtx()
		const sm = makeSessionManager([])

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: ctx,
			mode: "yolo",
			source: "user",
		})

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "yolo", source: "user" })
	})

	it("does NOT write when the persisted entry already matches the requested mode (no-op)", () => {
		const { ctx, spy } = makeAppendCtx()
		const sm = makeSessionManager([pmEntry({ mode: "plan", source: "user" })])

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: ctx,
			mode: "plan",
			source: "user",
		})

		expect(spy).not.toHaveBeenCalled()
	})

	it("writes when effective mode differs from persisted (divergent)", () => {
		const { ctx, spy } = makeAppendCtx()
		const sm = makeSessionManager([pmEntry({ mode: "plan", source: "user" })])

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: ctx,
			mode: "yolo",
			source: "user",
		})

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "yolo", source: "user" })
	})

	it("persists ferment-source writes too (full history kept in JSONL)", () => {
		const { ctx, spy } = makeAppendCtx()
		const sm = makeSessionManager([])

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: ctx,
			mode: "yolo",
			source: "ferment",
		})

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "yolo", source: "ferment" })
	})

	it("accepts the ExtensionAPI appendEntry append-handle (alternative union branch)", () => {
		const { ctx, spy } = makeApiAppendCtx()
		const sm = makeSessionManager([])

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: ctx,
			mode: "auto",
			source: "user",
		})

		expect(spy).toHaveBeenCalledTimes(1)
		expect(spy).toHaveBeenCalledWith(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode: "auto", source: "user" })
	})

	it("always syncs the runtime controller regardless of persistence decision", () => {
		const controller = createSessionPermissionFlagController({
			mode: { mode: "default", source: "user" },
		})
		registerSessionPermissionFlagController(SESSION_ID, controller)

		setAndPersistPermissionMode({
			sessionManager: makeSessionManager([pmEntry({ mode: "plan", source: "user" })]),
			appendCtx: makeAppendCtx().ctx,
			mode: "yolo",
			source: "user",
		})

		const live = getSessionPermissionFlagController(SESSION_ID)
		expect(live?.getMode()).toEqual({ mode: "yolo", source: "user" })
	})

	it("creates a fresh controller when none is registered yet", () => {
		const sm = makeSessionManager([])
		setAndPersistPermissionMode({
			sessionManager: { ...sm, getSessionId: () => `${SESSION_ID}-fresh` },
			appendCtx: makeAppendCtx().ctx,
			mode: "plan",
			source: "user",
		})

		const fresh = getSessionPermissionFlagController(`${SESSION_ID}-fresh`)
		expect(fresh?.getMode()).toEqual({ mode: "plan", source: "user" })
	})
})

// ---------------------------------------------------------------------------
// JSONL history — round-trip across multiple writes
// ---------------------------------------------------------------------------

describe("permission_mode JSONL round-trip", () => {
	it("appends each divergent write so the JSONL retains the full history", () => {
		const { ctx, spy } = makeAppendCtx()
		const entries: SessionEntry[] = []
		const sm = makeSessionManager(entries)
		// Re-append each persisted entry into our in-memory entries list as if reading from JSONL
		const write = (mode: PersistedPermissionMode["mode"], source: PersistedPermissionMode["source"]) => {
			setAndPersistPermissionMode({
				sessionManager: sm,
				appendCtx: ctx,
				mode,
				source,
			})
			spy.mock.calls.forEach(([customType, data]) => {
				if (customType === PERMISSION_MODE_SESSION_ENTRY_TYPE) {
					entries.push(pmEntry(data as PersistedPermissionMode))
				}
			})
		}

		write("plan", "user")
		write("yolo", "ferment")
		write("default", "user")
		write("auto", "user")

		expect(spy).toHaveBeenCalledTimes(4)
		expect(getSessionLogPermissionMode(sm)).toEqual({ mode: "auto", source: "user" })

		// Writing the same mode again should be a no-op
		write("auto", "user")
		expect(spy).toHaveBeenCalledTimes(4)
	})

	it("reads back the most recent {mode, source} from a populated JSONL on a fresh SessionManager", () => {
		const jsonlEntries: SessionEntry[] = [
			pmEntry({ mode: "default", source: "user" }, 1000),
			pmEntry({ mode: "plan", source: "user" }, 2000),
			pmEntry({ mode: "yolo", source: "ferment" }, 3000),
			pmEntry({ mode: "auto", source: "user" }, 4000),
		]
		// Simulate a resumed session by reading via a fresh SessionManager handle
		const freshSm = makeSessionManager(jsonlEntries)
		expect(getSessionLogPermissionMode(freshSm)).toEqual({ mode: "auto", source: "user" })
	})

	it("resumes a session in the last permission_mode from the JSONL", () => {
		const jsonlEntries: SessionEntry[] = [
			pmEntry({ mode: "default", source: "user" }, 1000),
			pmEntry({ mode: "plan", source: "user" }, 2000),
			pmEntry({ mode: "yolo", source: "ferment" }, 3000),
		]
		const freshSm = makeSessionManager(jsonlEntries)
		expect(resolvePermissionMode(freshSm)).toEqual({ mode: "yolo", source: "persisted" })
	})
})

// ---------------------------------------------------------------------------
// Type-only: SessionManager-shaped inputs satisfy the resolver type
// ---------------------------------------------------------------------------

describe("SessionManager interop", () => {
	it("accepts a full SessionManager-shaped object via the append-handle union", () => {
		const appendCustomEntry = vi.fn(() => "id")
		const sm = {
			getEntries: () => [] as SessionEntry[],
			getSessionId: () => SESSION_ID,
			appendCustomEntry,
		} as Pick<SessionManager, "getEntries" | "getSessionId"> & {
			appendCustomEntry: typeof appendCustomEntry
		}

		setAndPersistPermissionMode({
			sessionManager: sm,
			appendCtx: sm,
			mode: "yolo",
			source: "user",
		})

		expect(appendCustomEntry).toHaveBeenCalledWith(PERMISSION_MODE_SESSION_ENTRY_TYPE, {
			mode: "yolo",
			source: "user",
		})
	})
})
