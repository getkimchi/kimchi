import { describe, expect, it } from "vitest"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE } from "./mode.js"
import { getPersistedPermissionMode, persistPermissionModeIfChanged } from "./mode-controller.js"
import type { PermissionMode, PermissionModeState } from "./types.js"

function makeEntries(modes: PermissionMode[]): Array<{
	type: "custom"
	customType: string
	data: PermissionModeState
}> {
	return modes.map((mode) => ({
		type: "custom",
		customType: PERMISSION_MODE_SESSION_ENTRY_TYPE,
		data: { mode, source: "runtime", initiatedBy: "user" },
	}))
}

function makeSessionManager(modes: PermissionMode[]) {
	return {
		getEntries: () =>
			makeEntries(modes) as unknown as ReturnType<Parameters<typeof getPersistedPermissionMode>[0]["getEntries"]>,
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
