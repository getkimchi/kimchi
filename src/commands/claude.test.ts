import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./_helpers.js", () => ({
	prepareTool: vi.fn(),
}))

vi.mock("../integrations/spawn.js", () => ({
	runForeground: vi.fn(),
}))

vi.mock("../telemetry-policy.js", () => ({
	isTelemetryEnabled: vi.fn(() => false),
}))

import { runForeground } from "../integrations/spawn.js"
import { prepareTool } from "./_helpers.js"
import { runClaude } from "./claude.js"

describe("runClaude", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(prepareTool).mockResolvedValue({
			apiKey: "test-key",
			// biome-ignore lint/suspicious/noExplicitAny: test stub
			tool: {} as any,
			models: [],
		})
		vi.mocked(runForeground).mockResolvedValue(0)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	function launchedEnv(): Record<string, string> {
		return vi.mocked(runForeground).mock.calls[0][2] as Record<string, string>
	}

	it("disables Claude Code experimental betas by default", async () => {
		vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", undefined)

		expect(await runClaude([])).toBe(0)

		expect(launchedEnv().CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1")
	})

	it("lets the user turn experimental betas (and MCP tool search) back on", async () => {
		vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "0")

		expect(await runClaude(["-p", "hi"])).toBe(0)

		expect(runForeground).toHaveBeenCalledWith("claude", ["-p", "hi"], expect.any(Object))
		expect(launchedEnv().CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("0")
	})
})
