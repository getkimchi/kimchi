import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { createAgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../extensions/__mocks__/context.js"
import { createSideSession } from "../extensions/side-chat/session.js"
import { requireModelRuntime } from "./model-runtime.js"

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()
	return { ...actual, createAgentSession: vi.fn(actual.createAgentSession) }
})

describe("createSideSession model runtime", () => {
	it("passes the parent's model runtime to the child session", async () => {
		const runtime = { id: "parent-runtime" }
		const registry = { runtime } as unknown as ModelRegistry
		const ctx = createContext({
			cwd: "/project",
			model: { id: "test-model", provider: "kimchi-dev", contextWindow: 100_000 } as never,
			modelRegistry: registry,
			getSystemPrompt: () => "Side chat",
		})

		await createSideSession(ctx, { branchLeafId: null, fresh: true, thinkingLevel: "low" })

		const options = vi.mocked(createAgentSession).mock.calls[0]?.[0]
		expect(options?.modelRuntime).toBe(runtime)
	})
})

describe("requireModelRuntime errors", () => {
	it("throws when the registry has no runtime", () => {
		expect(() => requireModelRuntime({} as unknown as ModelRegistry)).toThrow(
			"Pi model registry runtime is unavailable",
		)
	})
})
