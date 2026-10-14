import type { CustomEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { seedOrgPolicy } from "../__mocks__/org-policy.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import type { LoadedConfig } from "./config.js"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE } from "./mode.js"
import {
	clearPermissionModeEnv,
	createSessionPermissionFlagController,
	getPermissionMode,
	getPersistedPermissionMode,
	persistPermissionModeIfChanged,
	resolveInitialPermissionMode,
	setPermissionMode,
} from "./mode-controller.js"
import type { PermissionMode, PermissionModeState } from "./types.js"

vi.mock("../../api/org-settings.js", () => ({
	fetchOrgPolicy: vi.fn(),
}))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)

const TEST_CONFIG: LoadedConfig = {
	config: { defaultMode: "default", allow: [], deny: [], classifierTimeoutMs: 8000, classifierMaxTotalMs: 25_000 },
	allowBySource: { user: [], project: [], local: [], cli: [] },
	denyBySource: { user: [], project: [], local: [], cli: [] },
	paths: {},
}

/** Install a policy in the holder through the public API (mocked fetch, throwaway cache file — never the real ~/.config one). */
async function allowModes(modes: AllowedPermissionModes) {
	await seedOrgPolicy(modes)
}

afterEach(() => {
	resetOrgPolicyForTests()
	mockedFetchOrgPolicy.mockReset()
})

function makeEntries(modes: PermissionMode[]): CustomEntry[] {
	return modes.map((mode, i) => ({
		type: "custom",
		id: `mode-entry-${i}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
		data: { mode, source: "runtime", initiatedBy: "user" },
	}))
}

function makeSessionManager(modes: PermissionMode[]) {
	return {
		getEntries: () => makeEntries(modes),
	}
}

describe("getPersistedPermissionMode", () => {
	it("returns undefined when no permission_mode entries exist", () => {
		const sessionManager = makeSessionManager([])
		expect(getPersistedPermissionMode(sessionManager)).toBeUndefined()
	})

	it("returns the last persisted mode", () => {
		const sessionManager = makeSessionManager(["default", "plan", "auto"])
		expect(getPersistedPermissionMode(sessionManager)).toEqual({
			mode: "auto",
			source: "runtime",
			initiatedBy: "user",
		})
	})

	it("ignores unrelated custom entries", () => {
		const sessionManager = {
			getEntries: () =>
				[
					{ type: "custom", customType: "other", data: { mode: "yolo" } },
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "plan", source: "runtime", initiatedBy: "user" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
		expect(getPersistedPermissionMode(sessionManager)).toEqual({
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})
	})

	it("returns the last entry by default without applying a filter", () => {
		const sessionManager = {
			getEntries: () =>
				[
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "auto", source: "runtime", initiatedBy: "user" },
					},
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "yolo", source: "runtime", initiatedBy: "ferment" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
		expect(getPersistedPermissionMode(sessionManager)).toEqual({
			mode: "yolo",
			source: "runtime",
			initiatedBy: "ferment",
		})
	})

	it("filters out entries that do not match the predicate", () => {
		const sessionManager = {
			getEntries: () =>
				[
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "auto", source: "runtime", initiatedBy: "user" },
					},
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "yolo", source: "runtime", initiatedBy: "ferment" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
		expect(getPersistedPermissionMode(sessionManager, (state) => state.initiatedBy === "user")).toEqual({
			mode: "auto",
			source: "runtime",
			initiatedBy: "user",
		})
	})

	it("returns undefined when all entries are filtered out", () => {
		const sessionManager = {
			getEntries: () =>
				[
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "yolo", source: "runtime", initiatedBy: "ferment" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
		expect(getPersistedPermissionMode(sessionManager, (state) => state.initiatedBy === "user")).toBeUndefined()
	})

	it("supports arbitrary predicates", () => {
		const sessionManager = {
			getEntries: () =>
				[
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "yolo", source: "runtime", initiatedBy: "user" },
					},
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "plan", source: "runtime", initiatedBy: "user" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
		expect(getPersistedPermissionMode(sessionManager, (state) => state.mode === "yolo")).toEqual({
			mode: "yolo",
			source: "runtime",
			initiatedBy: "user",
		})
	})
})

describe("persistPermissionModeIfChanged", () => {
	it("appends entry when mode differs from last persisted", () => {
		const sessionManager = makeSessionManager(["default"])
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})

		expect(written).toBe(true)
		expect(appended).toEqual([{ mode: "plan", source: "runtime", initiatedBy: "user" }])
	})

	it("records the change reason on the persisted entry when provided", () => {
		const sessionManager = makeSessionManager(["default"])
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(
			sessionManager,
			(_type, data) => appended.push(data),
			{ mode: "plan", source: "runtime", initiatedBy: "user" },
			"user_shift_tab",
		)

		expect(written).toBe(true)
		expect(appended).toEqual([{ mode: "plan", source: "runtime", initiatedBy: "user", reason: "user_shift_tab" }])
	})

	it("does not append when mode matches last persisted", () => {
		const sessionManager = makeSessionManager(["plan"])
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})

		expect(written).toBe(false)
		expect(appended).toHaveLength(0)
	})

	it("appends when no prior entry exists", () => {
		const sessionManager = makeSessionManager([])
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "yolo",
			source: "runtime",
			initiatedBy: "user",
		})

		expect(written).toBe(true)
		expect(appended).toEqual([{ mode: "yolo", source: "runtime", initiatedBy: "user" }])
	})

	// A ferment that elevated the session to yolo and then cleared: the log ends
	// in a ferment-owned yolo entry on top of the previous user plan entry.
	function makeFermentEndedSessionManager() {
		return {
			getEntries: () =>
				[
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "plan", source: "runtime", initiatedBy: "user" },
					},
					{
						type: "custom",
						customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
						data: { mode: "yolo", source: "runtime", initiatedBy: "ferment" },
					},
				] as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
		}
	}

	it("does not re-append while the ferment elevation is still in effect", () => {
		// Regression: dedup must compare against the truly-last logged entry
		// (including ferment-owned ones). Comparing against the last USER entry
		// would re-append the elevation on every turn.
		const sessionManager = makeFermentEndedSessionManager()
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "yolo",
			source: "runtime",
			initiatedBy: "ferment",
		})

		expect(written).toBe(false)
		expect(appended).toHaveLength(0)
	})

	it("appends the restored user mode once a ferment elevation clears", () => {
		const sessionManager = makeFermentEndedSessionManager()
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "plan",
			source: "runtime",
			initiatedBy: "user",
		})

		expect(written).toBe(true)
		expect(appended).toEqual([{ mode: "plan", source: "runtime", initiatedBy: "user" }])
	})

	it("appends when the same mode was last set by a different owner", () => {
		// Regression: if the user explicitly switches to yolo while a ferment
		// elevation is active, the last logged entry is yolo/ferment but the
		// runtime state is yolo/user. Comparing only the mode would swallow the
		// override, and resume would skip the ferment entry and revert to the
		// pre-ferment user mode.
		const sessionManager = makeFermentEndedSessionManager()
		const appended: PermissionModeState[] = []
		const written = persistPermissionModeIfChanged(sessionManager, (_type, data) => appended.push(data), {
			mode: "yolo",
			source: "runtime",
			initiatedBy: "user",
		})

		expect(written).toBe(true)
		expect(appended).toEqual([{ mode: "yolo", source: "runtime", initiatedBy: "user" }])
	})
})

describe("org-policy mode clamping", () => {
	// Hermetic: the harness may leak its own KIMCHI_PARENT_SESSION_ID +
	// KIMCHI_PERMISSIONS_<parent> into the process env, which the resolution
	// chain would otherwise treat as an inherited runtime mode.
	const savedParentSessionId = process.env[PARENT_SESSION_ID_ENV_KEY]
	beforeEach(() => {
		delete process.env[PARENT_SESSION_ID_ENV_KEY]
		clearPermissionModeEnv("sess-clamp")
	})
	afterEach(() => {
		if (savedParentSessionId !== undefined) process.env[PARENT_SESSION_ID_ENV_KEY] = savedParentSessionId
	})

	function sessionManagerWith(modes: PermissionMode[]) {
		return {
			getSessionId: () => "sess-clamp",
			getEntries: () => makeEntries(modes),
		}
	}

	it("clamps a disallowed CLI flag to the nearest allowed mode, keeping its source", async () => {
		await allowModes({ plan: true, default: true, auto: false, yolo: false })
		const resolved = resolveInitialPermissionMode(sessionManagerWith([]), undefined, "yolo", TEST_CONFIG)
		expect(resolved.mode).toBe("default")
		expect(resolved.source).toBe("flag")
	})

	it("keeps an allowed CLI flag untouched", async () => {
		await allowModes({ plan: true, default: false, auto: true, yolo: false })
		const resolved = resolveInitialPermissionMode(sessionManagerWith([]), undefined, "auto", TEST_CONFIG)
		expect(resolved.mode).toBe("auto")
	})

	it("clamps a disallowed persisted mode on resume", async () => {
		await allowModes({ plan: true, default: false, auto: false, yolo: false })
		const resolved = resolveInitialPermissionMode(sessionManagerWith(["yolo"]), undefined, undefined, TEST_CONFIG)
		expect(resolved.mode).toBe("plan")
	})

	it("falls back to the most restrictive allowed mode for low-mode-less policies", async () => {
		await allowModes({ plan: false, default: false, auto: true, yolo: false })
		const resolved = resolveInitialPermissionMode(sessionManagerWith([]), undefined, "default", TEST_CONFIG)
		expect(resolved.mode).toBe("auto")
	})

	it("never applies a disallowed mode through the session controller", async () => {
		await allowModes({ plan: true, default: true, auto: false, yolo: false })
		const controller = createSessionPermissionFlagController({
			mode: { mode: "default", source: "runtime", initiatedBy: "user" },
		})
		controller.setMode({ mode: "yolo", source: "runtime", initiatedBy: "user" })
		expect(controller.getMode().mode).toBe("default")
		controller.setMode({ mode: "plan", source: "runtime", initiatedBy: "user" })
		expect(controller.getMode().mode).toBe("plan")
	})

	it("clamps the env record written by setPermissionMode", async () => {
		await allowModes({ plan: true, default: true, auto: false, yolo: false })
		const sessionId = "sess-env-clamp"
		setPermissionMode(sessionId, { mode: "yolo", source: "runtime", initiatedBy: "user" })
		expect(getPermissionMode(sessionId)?.mode).toBe("default")
		clearPermissionModeEnv(sessionId)
	})

	it("leaves everything allowed when no policy is set (fail open)", async () => {
		await seedOrgPolicy(undefined)
		const resolved = resolveInitialPermissionMode(sessionManagerWith([]), undefined, "yolo", TEST_CONFIG)
		expect(resolved.mode).toBe("yolo")
	})
})
