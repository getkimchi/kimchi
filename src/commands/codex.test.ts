import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — declared before imports that consume them
// ---------------------------------------------------------------------------

vi.mock("./_helpers.js", () => ({
	prepareTool: vi.fn(),
}))

vi.mock("../integrations/spawn.js", () => ({
	runForeground: vi.fn(),
}))

import { runForeground } from "../integrations/spawn.js"
import { prepareTool } from "./_helpers.js"
import { runCodex } from "./codex.js"

describe("runCodex", () => {
	function mockPrepped(overrides: Partial<{ apiKey: string }> = {}) {
		return {
			apiKey: overrides.apiKey ?? "test-key",
			tool: {
				id: "codex" as const,
				name: "Codex",
				description: "",
				configPath: "~/.codex/config.toml",
				binaryName: "codex",
				isInstalled: () => true,
				// biome-ignore lint/suspicious/noExplicitAny: test stub
				write: vi.fn() as any,
			},
			models: [],
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("is exported as a function", () => {
		expect(typeof runCodex).toBe("function")
	})

	it("returns 1 when prepareTool yields null (no API key)", async () => {
		vi.mocked(prepareTool).mockResolvedValue(null)
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const exit = await runCodex([])

		expect(exit).toBe(1)
		expect(runForeground).not.toHaveBeenCalled()
		errSpy.mockRestore()
	})

	it("forwards args and injects KIMCHI_API_KEY when prepareTool succeeds", async () => {
		vi.mocked(prepareTool).mockResolvedValue(mockPrepped())
		vi.mocked(runForeground).mockResolvedValue(0)

		const exit = await runCodex(["exec", "--", "hello"])

		expect(exit).toBe(0)
		expect(runForeground).toHaveBeenCalledTimes(1)
		expect(runForeground).toHaveBeenCalledWith(
			"codex",
			["exec", "--", "hello"],
			expect.objectContaining({ KIMCHI_API_KEY: "test-key" }),
		)
	})

	it("returns the child's exit code when runForeground resolves", async () => {
		vi.mocked(prepareTool).mockResolvedValue(mockPrepped())
		vi.mocked(runForeground).mockResolvedValue(42)

		const exit = await runCodex([])

		expect(exit).toBe(42)
	})

	it("returns 1 and logs the error when runForeground throws", async () => {
		vi.mocked(prepareTool).mockResolvedValue(mockPrepped())
		vi.mocked(runForeground).mockRejectedValue(new Error("codex is not installed or not on PATH"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const exit = await runCodex([])

		expect(exit).toBe(1)
		expect(errSpy).toHaveBeenCalledWith("kimchi codex:", "codex is not installed or not on PATH")
		errSpy.mockRestore()
	})
})
