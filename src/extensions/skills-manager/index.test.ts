import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { describe, expect, it } from "vitest"
import skillsManagerExtension from "./index.js"

describe("skillsManagerExtension", () => {
	it("registers the skill_manage tool", () => {
		const registered: unknown[] = []
		const pi = {
			registerTool: (tool: unknown) => registered.push(tool),
		} as unknown as ExtensionAPI
		skillsManagerExtension(pi, { skillsDir: "/tmp/test-skills" })
		expect(registered).toHaveLength(1)
		expect((registered[0] as { name?: string }).name).toBe("skill_manage")
	})
})
