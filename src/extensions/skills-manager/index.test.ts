import { describe, expect, it } from "vitest"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import skillsManagerExtension from "./index.js"

describe("skillsManagerExtension", () => {
	it("registers skill_manage and skill_view tools by default", () => {
		const { api, getRegisteredTools } = createExtensionApi()
		skillsManagerExtension(api, { skillsDir: "/tmp/test-skills" })
		const names = getRegisteredTools().map((t) => t.name)
		expect(names).toContain("skill_manage")
		expect(names).toContain("skill_view")
	})

	it("registers only skill_view when registerSkillManageTool is false", () => {
		const { api, getRegisteredTools } = createExtensionApi()
		skillsManagerExtension(api, {
			skillsDir: "/tmp/test-skills",
			registerSkillManageTool: false,
		})
		const names = getRegisteredTools().map((t) => t.name)
		expect(names).toEqual(["skill_view"])
	})

	it("subscribes to before_agent_start and session_shutdown for the discovered inventory", () => {
		const { api, getHandler } = createExtensionApi()
		skillsManagerExtension(api, { skillsDir: "/tmp/test-skills" })
		expect(getHandler("before_agent_start")).toBeDefined()
		expect(getHandler("session_shutdown")).toBeDefined()
	})
})
