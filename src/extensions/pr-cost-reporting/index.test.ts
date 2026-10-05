import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as supervisor from "../work-attribution/reconcile-supervisor.js"
import { WORK_CHANGED_EVENT, WORK_STATE_REQUEST_EVENT, type WorkStateRequest } from "../work-attribution.js"
import reportingExtension from "./index.js"
import { readReportingState } from "./queue.js"

vi.mock("../work-attribution/reconcile-supervisor.js", () => ({ subscribeReportingReconciliation: vi.fn() }))
let directory: string
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-reporting-extension-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(async () => {})
})
afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("optional PR reporting", () => {
	it("cancels the old account context before switching to another project session", async () => {
		const api = createExtensionApi()
		let ctx = createContext({ cwd: "/first" })
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		const stop = vi.fn(async () => {})
		vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(stop)
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		ctx = createContext({ cwd: "/other" })
		api.api.events.emit(WORK_CHANGED_EVENT, {})
		expect(stop).toHaveBeenCalledOnce()
		expect(supervisor.subscribeReportingReconciliation).toHaveBeenCalledTimes(2)
		await api.getHandler("session_shutdown")({}, ctx)
	})
	it("stays inactive when work tracking is absent or this is a child", async () => {
		const api = createExtensionApi()
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, createContext())
		expect(supervisor.subscribeReportingReconciliation).not.toHaveBeenCalled()
		expect(existsSync(join(directory, "pr-cost-reporting"))).toBe(false)
	})
	it("starts only for main tracking and exposes separate opt-in, opt-out and status commands", async () => {
		const api = createExtensionApi()
		const ctx = createContext()
		api.api.events.on(WORK_STATE_REQUEST_EVENT, (value) => {
			Object.assign(value as WorkStateRequest, { tracking: true, current: { workId: "test-work", ctx } })
		})
		const stop = vi.fn(async () => {})
		vi.mocked(supervisor.subscribeReportingReconciliation).mockReturnValue(stop)
		reportingExtension(api.api)
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, ctx)
		expect(supervisor.subscribeReportingReconciliation).toHaveBeenCalledOnce()
		expect((await readReportingState(directory)).enabled).toBe(false)
		const command = api.getRegisteredCommand("pr-reporting")
		const commandCtx = createCommandContext()
		await command.handler("on", commandCtx)
		expect((await readReportingState(directory)).enabled).toBe(true)
		expect(commandCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("request and billing IDs"), "info")
		await command.handler("off", commandCtx)
		expect((await readReportingState(directory)).enabled).toBe(false)
		await api.getHandler("session_shutdown")({}, ctx)
		expect(stop).toHaveBeenCalledOnce()
	})
})
