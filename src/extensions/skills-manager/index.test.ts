import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import skillsManagerExtension from "./index.js"

type PiMock = {
	registerTool: (tool: unknown) => void
	on: (event: string, handler: (event?: unknown) => void) => void
	registered: unknown[]
	handlers: Map<string, (event?: unknown) => void>
}

function createPiMock(): PiMock {
	const registered: unknown[] = []
	const handlers = new Map<string, (event?: unknown) => void>()
	const pi = {
		registerTool: (tool: unknown) => registered.push(tool),
		on: (event: string, handler: (event?: unknown) => void) => {
			handlers.set(event, handler)
		},
		// Exposed for assertions without leaking into the ExtensionAPI cast.
		registered,
		handlers,
	}
	return pi as unknown as PiMock
}

describe("skillsManagerExtension", () => {
	it("registers skill_manage and skill_view tools by default", () => {
		const pi = createPiMock()
		skillsManagerExtension(pi as unknown as ExtensionAPI, { skillsDir: "/tmp/test-skills" })
		const names = (pi.registered as { name?: string }[]).map((t) => t.name)
		expect(names).toContain("skill_manage")
		expect(names).toContain("skill_view")
	})

	it("registers only skill_view when registerSkillManageTool is false", () => {
		const pi = createPiMock()
		skillsManagerExtension(pi as unknown as ExtensionAPI, {
			skillsDir: "/tmp/test-skills",
			registerSkillManageTool: false,
		})
		const names = (pi.registered as { name?: string }[]).map((t) => t.name)
		expect(names).toEqual(["skill_view"])
	})

	it("subscribes to before_agent_start and session_shutdown for the discovered inventory", () => {
		const pi = createPiMock()
		skillsManagerExtension(pi as unknown as ExtensionAPI, { skillsDir: "/tmp/test-skills" })
		expect(pi.handlers.has("before_agent_start")).toBe(true)
		expect(pi.handlers.has("session_shutdown")).toBe(true)
	})
})
