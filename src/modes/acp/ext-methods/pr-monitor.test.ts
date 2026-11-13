import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../../../extensions/__mocks__/context.js"
import { createExtensionApi } from "../../../extensions/__mocks__/extension-api.js"
import { PRWatchCollection } from "../../../extensions/pr-monitor/collection.js"
import { getPRMonitor } from "../../../extensions/pr-monitor/index.js"
import { readPRSnapshot } from "../../../extensions/pr-monitor/providers.js"
import { handlePRMonitor } from "./pr-monitor.js"

vi.mock("../../../extensions/pr-monitor/index.js", () => ({ getPRMonitor: vi.fn() }))
vi.mock("../../../extensions/pr-monitor/providers.js", () => ({ readPRSnapshot: vi.fn() }))

describe("ACP PR monitor controls", () => {
	let monitor: PRWatchCollection
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(readPRSnapshot).mockResolvedValue(null)
		monitor = new PRWatchCollection(createExtensionApi().api, createContext())
		vi.mocked(getPRMonitor).mockReturnValue(monitor)
	})
	afterEach(async () => {
		await monitor.dispose()
	})
	const manager = {}
	// This handler's session dependency is exactly the manager identity.
	const session = { sessionManager: manager } as AgentSession
	const getSession = (id: string) => (id === "acp-1" ? session : undefined)

	it("reads and forwards a structured snapshot without starting a prompt", async () => {
		const notify = vi.fn()
		const result = await handlePRMonitor(getSession, { sessionId: "acp-1" }, false, notify)
		expect(result).toMatchObject({ state: { enabled: false, autoFix: false, pullRequest: null } })
		expect(getPRMonitor).toHaveBeenCalledWith(manager)
		expect(notify).toHaveBeenCalledWith("acp-1", expect.objectContaining({ revision: 1 }))
	})
	it("requires a live session and typed flags", async () => {
		await expect(handlePRMonitor(getSession, {}, false, vi.fn())).rejects.toThrow("sessionId")
		await expect(handlePRMonitor(getSession, { sessionId: "other" }, false, vi.fn())).rejects.toThrow("unavailable")
		await expect(
			handlePRMonitor(getSession, { sessionId: "acp-1", enabled: "true", autoFix: false }, true, vi.fn()),
		).rejects.toThrow("booleans")
	})
	it("rejects writes without monitoring", async () => {
		await expect(
			handlePRMonitor(getSession, { sessionId: "acp-1", enabled: false, autoFix: true }, true, vi.fn()),
		).rejects.toThrow("Enable PR monitoring")
	})
	it("turns monitoring off idempotently", async () => {
		const params = { sessionId: "acp-1", enabled: false, autoFix: false }
		await handlePRMonitor(getSession, params, true, vi.fn())
		expect(await handlePRMonitor(getSession, params, true, vi.fn())).toMatchObject({
			state: { enabled: false, autoFix: false, phase: "idle" },
		})
	})
})
