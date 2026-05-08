import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import skillsManagerExtension from "./index.js"

describe("skillsManagerExtension", () => {
	it("registers skill_manage and skill_view tools", () => {
		const registered: unknown[] = []
		const pi = {
			registerTool: (tool: unknown) => registered.push(tool),
		} as unknown as ExtensionAPI
		skillsManagerExtension(pi, { skillsDir: "/tmp/test-skills" })
		expect(registered).toHaveLength(2)
		const names = (registered as { name?: string }[]).map((t) => t.name)
		expect(names).toContain("skill_manage")
		expect(names).toContain("skill_view")
	})
})
