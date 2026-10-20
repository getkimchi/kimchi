import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
	MIN_TOKEN_BUDGET: 1024,
	MIN_FINALIZE_TOKEN_BUDGET: 256,
}))
vi.mock("./remote-agent-runner.js", () => ({
	runRemoteAgent: vi.fn(),
	continueRemoteAgent: vi.fn(),
	attachRemoteAgent: vi.fn(),
	isRemoteSessionConnected: vi.fn(),
}))

import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { createLiveContext } from "../../__mocks__/context.js"
import { createExtensionApi } from "../../__mocks__/extension-api.js"
import { createModel } from "../../__mocks__/model-registry.js"
import { AgentManager } from "./agent-manager.js"
import { runAgent } from "./agent-runner.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-agent-queued-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.clearAllMocks()
	rmSync(dir, { recursive: true, force: true })
})

it("starts a queued child with the parent's live context: Pi's getters and stale guard stay live", async () => {
	const parent = createLiveContext({ cwd: dir, model: createModel("model-at-spawn") })
	const read = (value: () => unknown) => {
		try {
			return value()
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}
	const started: Record<string, unknown>[] = []
	const finish: (() => void)[] = []
	vi.mocked(runAgent).mockImplementation(async (childCtx) => {
		started.push({
			model: read(() => childCtx.model?.id),
			session: read(() => childCtx.sessionManager.getSessionId()),
		})
		await new Promise<void>((resolve) => finish.push(resolve))
		return {
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		}
	})
	const manager = new AgentManager(undefined, 1)
	const pi = createExtensionApi().api
	try {
		for (const name of ["running", "after-model-change", "after-session-replacement"])
			manager.spawn(pi, parent.ctx, "Explore", name, { description: name, isBackground: true })
		parent.set("model", createModel("model-at-start"))
		finish[0]()
		await vi.waitFor(() => expect(started).toHaveLength(2))
		parent.invalidate()
		finish[1]()
		await vi.waitFor(() => expect(started).toHaveLength(3))
		finish[2]()
		expect(started[1]).toEqual({ model: "model-at-start", session: "test-session" })
		expect(started[2]).toEqual({
			model: expect.stringContaining("stale"),
			session: expect.stringContaining("stale"),
		})
	} finally {
		manager.dispose()
	}
})
