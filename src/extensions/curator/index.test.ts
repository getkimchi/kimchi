import type * as fs from "node:fs"
import { mkdtempSync, rmSync, unwatchFile, watch, watchFile } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { pollListener, resetFsPollingMock } from "../__mocks__/fs-polling.js"
import { UsageTracker } from "../skills-manager/usage.js"
import curatorExtension, { computeIdleSeconds, getStateFilePath } from "./index.js"
import type { CuratorState } from "./state.js"
import { DEFAULT_CURATOR_STATE } from "./state.js"

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof fs>()),
	watch: vi.fn(),
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
}))

vi.mock("./review.js", () => ({
	debugLog: vi.fn(),
	runCuratorReview: vi.fn(),
	spawnSessionReview: vi.fn(),
}))

async function dispatchTurn(api: ReturnType<typeof createExtensionApi>): Promise<void> {
	await api.emit("agent_end", { messages: [{ role: "assistant" }] }, createContext())
}

describe("getStateFilePath", () => {
	it("returns .curator_state.json inside skillsDir", () => {
		expect(getStateFilePath("/home/user/.config/kimchi/harness/skills")).toBe(
			"/home/user/.config/kimchi/harness/skills/.curator_state.json",
		)
	})
})

describe("computeIdleSeconds", () => {
	it("returns Infinity when last_session_ended_at is undefined", () => {
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE }
		expect(computeIdleSeconds(state, new Date("2026-05-07T12:00:00Z"))).toBe(Number.POSITIVE_INFINITY)
	})

	it("returns correct seconds since last session ended", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString()
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE, last_session_ended_at: twoHoursAgo }
		const result = computeIdleSeconds(state, now)
		expect(result).toBeCloseTo(7200, -1)
	})

	it("returns 0 when last_session_ended_at is now", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const state: CuratorState = { ...DEFAULT_CURATOR_STATE, last_session_ended_at: now.toISOString() }
		expect(computeIdleSeconds(state, now)).toBeCloseTo(0, 0)
	})
})

describe("skill usage notice window", () => {
	let tmpDir: string
	let api: ReturnType<typeof createExtensionApi>

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-curator-"))
		vi.useFakeTimers()
		vi.stubEnv("KIMCHI_REVIEW_THRESHOLD", "1")
		resetFsPollingMock()
		api = createExtensionApi()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("reuses one usage-file poller across qualifying turns and never watches the directory", async () => {
		curatorExtension(api.api, { skillsDir: tmpDir, provider: "p", model: "m" })
		await dispatchTurn(api)
		await dispatchTurn(api)
		await dispatchTurn(api)
		expect(watch).not.toHaveBeenCalled()
		expect(watchFile).toHaveBeenCalledTimes(1)
		expect(watchFile).toHaveBeenCalledWith(
			join(tmpDir, ".usage.json"),
			{ persistent: false, interval: 1000 },
			expect.any(Function),
		)
	})

	it("keeps one poller across turns and stops after the notice window", async () => {
		curatorExtension(api.api, { skillsDir: tmpDir, provider: "p", model: "m" })
		await dispatchTurn(api)
		await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
		await dispatchTurn(api)
		expect(watchFile).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
		expect(unwatchFile).toHaveBeenCalledWith(join(tmpDir, ".usage.json"), expect.any(Function))
	})

	it("notifies once for a new agent_created skill and not for an unchanged one", async () => {
		vi.spyOn(UsageTracker.prototype, "list").mockResolvedValue([{ name: "fresh", agent_created: true } as never])
		curatorExtension(api.api, { skillsDir: tmpDir, provider: "p", model: "m" })
		await dispatchTurn(api)
		pollListener()({} as never, {} as never)
		await vi.advanceTimersByTimeAsync(600)
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		const [message] = api.sendMessage.mock.calls[0]
		expect(message.customType).toBe("curator-notification")
		expect((message.details as { names: string[] }).names).toEqual(["fresh"])
		pollListener()({} as never, {} as never)
		await vi.advanceTimersByTimeAsync(600)
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("stops polling and clears timers on session_shutdown", async () => {
		vi.spyOn(UsageTracker.prototype, "list").mockResolvedValue([] as never)
		curatorExtension(api.api, { skillsDir: tmpDir, provider: "p", model: "m" })
		await dispatchTurn(api)
		pollListener()({} as never, {} as never)
		await api.emit("session_shutdown", {}, createContext())
		expect(unwatchFile).toHaveBeenCalledWith(join(tmpDir, ".usage.json"), expect.any(Function))
		expect(vi.getTimerCount()).toBe(0)
	})
})
