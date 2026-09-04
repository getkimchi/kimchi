/**
 * Unit tests for the bash hooks adapter extension.
 *
 * Verifies that `applyEnabledBashHooks` is invoked for both `tool_call`
 * (bash) and `user_bash` events, that blocks short-circuit execution,
 * and that rewrites are propagated either via `event.input.command`
 * mutation or by returning custom `BashOperations`.
 *
 * `applyEnabledBashHooks` is mocked so tests don't need real hook files.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { applyEnabledBashHooks, mockExec } = vi.hoisted(() => {
	const mockExec = vi.fn(async () => ({
		output: "rewritten-ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	}))
	return {
		applyEnabledBashHooks: vi.fn(),
		mockExec,
	}
})

vi.mock("../resources/bash-hooks.js", () => ({
	applyEnabledBashHooks,
}))

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	)
	return {
		...actual,
		createLocalBashOperations: () => ({ exec: mockExec }),
	}
})

import bashHooksAdapterExtension from "./bash-hooks-adapter.js"

type PI = import("@earendil-works/pi-coding-agent").ExtensionAPI

interface MockExtensionAPI {
	handlers: Record<string, Array<(...args: unknown[]) => unknown>>
	on: (event: string, handler: (...args: unknown[]) => unknown) => void
}

function createMockPI(): MockExtensionAPI {
	const handlers: MockExtensionAPI["handlers"] = {}
	return {
		handlers,
		on(event, handler) {
			const list = handlers[event] ?? []
			if (!handlers[event]) handlers[event] = list
			list.push(handler)
		},
	}
}

function emit(pi: MockExtensionAPI, event: string, payload: Record<string, unknown> = {}): unknown {
	const handlers = pi.handlers[event] ?? []
	let lastResult: unknown
	for (const h of handlers) {
		lastResult = h(payload)
	}
	return lastResult
}

describe("bashHooksAdapterExtension — tool_call", () => {
	beforeEach(() => {
		applyEnabledBashHooks.mockClear()
		mockExec.mockClear()
	})
	it("mutates event.input.command when a bash hook rewrites the command", () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "git status --short" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const input = { command: "git status" }
		const result = emit(pi, "tool_call", { toolName: "bash", input })

		expect(applyEnabledBashHooks).toHaveBeenCalledWith("git status", process.cwd())
		expect(input.command).toBe("git status --short")
		expect(result).toBeUndefined()
	})

	it("uses input.cwd when provided", () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "git status" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		emit(pi, "tool_call", {
			toolName: "bash",
			input: { command: "git status", cwd: "/repo" },
		})

		expect(applyEnabledBashHooks).toHaveBeenCalledWith("git status", "/repo")
	})

	it("returns { block: true, reason } when the hook blocks", () => {
		applyEnabledBashHooks.mockReturnValueOnce({
			command: "rm -rf /",
			block: true,
			reason: "nope",
		})
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const input = { command: "rm -rf /" }
		const result = emit(pi, "tool_call", { toolName: "bash", input })

		expect(result).toEqual({ block: true, reason: "nope" })
		expect(input.command).toBe("rm -rf /") // not mutated
	})

	it("is a no-op for non-bash tools", () => {
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const input = { filePath: "foo.ts" }
		const result = emit(pi, "tool_call", { toolName: "read", input })

		expect(result).toBeUndefined()
		expect(applyEnabledBashHooks).not.toHaveBeenCalled()
	})

	it("is a no-op for non-string command input", () => {
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const result = emit(pi, "tool_call", { toolName: "bash", input: { command: 42 } })
		expect(result).toBeUndefined()
		expect(applyEnabledBashHooks).not.toHaveBeenCalled()
	})

	it("is a no-op when the hook returns the unchanged command", () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "git status" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const input = { command: "git status" }
		const result = emit(pi, "tool_call", { toolName: "bash", input })

		expect(result).toBeUndefined()
		expect(input.command).toBe("git status") // no mutation
	})
})

describe("bashHooksAdapterExtension — user_bash", () => {
	beforeEach(() => {
		applyEnabledBashHooks.mockClear()
		mockExec.mockClear()
	})
	it("returns a block result when the hook blocks", () => {
		applyEnabledBashHooks.mockReturnValueOnce({
			command: "rm -rf /",
			block: true,
			reason: "disallowed",
		})
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const result = emit(pi, "user_bash", { command: "rm -rf /", cwd: "/repo" })

		expect(applyEnabledBashHooks).toHaveBeenCalledWith("rm -rf /", "/repo")
		expect(result).toEqual({
			result: {
				output: "disallowed",
				exitCode: 2,
				cancelled: false,
				truncated: false,
			},
		})
	})

	it("falls back to a generic message when a block has no reason", () => {
		applyEnabledBashHooks.mockReturnValueOnce({
			command: "rm -rf /",
			block: true,
		})
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const result = emit(pi, "user_bash", { command: "rm -rf /", cwd: "/repo" })
		expect(result).toMatchObject({
			result: { output: "Bash hook blocked command", exitCode: 2 },
		})
	})

	it("returns custom operations when the hook rewrites the command", async () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "git status --short" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const result = emit(pi, "user_bash", { command: "git status", cwd: "/repo" })

		expect(result).toBeDefined()
		expect(result).toHaveProperty("operations")
		const operations = (result as { operations: BashOperations }).operations
		expect(operations).toBeDefined()
		expect(typeof operations.exec).toBe("function")

		// Verify exec forwards to the local ops with the rewritten command
		await operations.exec("git status", "/repo", { onData: () => {} })
		expect(mockExec).toHaveBeenCalledWith(
			"git status --short",
			"/repo",
			expect.objectContaining({ onData: expect.any(Function) }),
		)
	})

	it("returns undefined when the hook returns the unchanged command", () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "git status" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		const result = emit(pi, "user_bash", { command: "git status", cwd: "/repo" })

		expect(result).toBeUndefined()
	})

	it("uses event.cwd for hook resolution", () => {
		applyEnabledBashHooks.mockReturnValueOnce({ command: "ls" })
		const pi = createMockPI()
		bashHooksAdapterExtension(pi as unknown as PI)

		emit(pi, "user_bash", { command: "ls", cwd: "/some/dir" })

		expect(applyEnabledBashHooks).toHaveBeenCalledWith("ls", "/some/dir")
	})
})
