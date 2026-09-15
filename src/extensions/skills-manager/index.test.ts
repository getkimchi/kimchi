import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Skill } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import skillsManagerExtension from "./index.js"

interface TextContentLike {
	type: string
	text?: string
}

/** Runtime-guarded text extraction from an AgentToolResult content block. */
function resultText(result: { content?: TextContentLike[] } | undefined): string {
	const block = result?.content?.[0]
	return block?.type === "text" ? (block.text ?? "") : ""
}

describe("skillsManagerExtension", () => {
	it("registers skill_manage and skill_view tools by default", () => {
		const { api, getRegisteredTool } = createExtensionApi()
		skillsManagerExtension(api, { skillsDir: "/tmp/test-skills" })
		expect(() => getRegisteredTool("skill_manage")).not.toThrow()
		expect(() => getRegisteredTool("skill_view")).not.toThrow()
	})

	it("registerSkillManageTool: false registers only skill_view (the CLI wiring since #235)", () => {
		const { api, getRegisteredTool } = createExtensionApi()
		skillsManagerExtension(api, { skillsDir: "/tmp/test-skills", registerSkillManageTool: false })
		expect(() => getRegisteredTool("skill_view")).not.toThrow()
		expect(() => getRegisteredTool("skill_manage")).toThrow(/was not registered/)
	})

	describe("discovered-skills wiring", () => {
		let harnessDir: string
		let projectDir: string

		beforeEach(() => {
			harnessDir = mkdtempSync(join(tmpdir(), "kimchi-skills-harness-"))
			projectDir = mkdtempSync(join(tmpdir(), "kimchi-skills-project-"))
			mkdirSync(join(projectDir, "project-skill"), { recursive: true })
			writeFileSync(
				join(projectDir, "project-skill", "SKILL.md"),
				"---\nname: project-skill\ndescription: lives in the project repo\n---\nProject body.",
			)
		})

		afterEach(async () => {
			// The UsageTracker's fire-and-forget lock-file creation (from the
			// successful skill_view calls) can race directory removal on macOS —
			// retry briefly so cleanup never flakes.
			for (let attempt = 0; attempt < 10; attempt++) {
				try {
					rmSync(harnessDir, { recursive: true, force: true })
					break
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 10))
				}
			}
			rmSync(projectDir, { recursive: true, force: true })
		})

		function discoveredSkill(): Skill {
			return {
				name: "project-skill",
				description: "lives in the project repo",
				filePath: join(projectDir, "project-skill", "SKILL.md"),
				baseDir: join(projectDir, "project-skill"),
				sourceInfo: {
					path: join(projectDir, "project-skill", "SKILL.md"),
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				disableModelInvocation: false,
			}
		}

		it("skill_view cannot resolve a project skill before before_agent_start fires", async () => {
			const { api, getRegisteredTool } = createExtensionApi()
			skillsManagerExtension(api, { skillsDir: harnessDir })
			const view = getRegisteredTool("skill_view")
			const result = await view.execute("id", { name: "project-skill" }, undefined, undefined, createContext())
			expect(resultText(result)).toContain("not found")
		})

		it("feeds the before_agent_start inventory into skill_view resolution", async () => {
			const { api, getHandlers, getRegisteredTool } = createExtensionApi()
			skillsManagerExtension(api, { skillsDir: harnessDir })

			const handlers = getHandlers("before_agent_start")
			expect(handlers.length).toBeGreaterThan(0)
			for (const handler of handlers) {
				await handler({ systemPromptOptions: { skills: [discoveredSkill()] } }, createContext())
			}

			const view = getRegisteredTool("skill_view")
			const result = await view.execute("id", { name: "project-skill" }, undefined, undefined, createContext())
			expect(resultText(result)).toContain("Project body.")
		})

		it("clears the inventory on session_shutdown", async () => {
			const { api, getHandlers, getRegisteredTool } = createExtensionApi()
			skillsManagerExtension(api, { skillsDir: harnessDir })

			for (const handler of getHandlers("before_agent_start")) {
				await handler({ systemPromptOptions: { skills: [discoveredSkill()] } }, createContext())
			}
			for (const handler of getHandlers("session_shutdown")) {
				await handler({} as never, createContext())
			}

			const view = getRegisteredTool("skill_view")
			const result = await view.execute("id", { name: "project-skill" }, undefined, undefined, createContext())
			expect(resultText(result)).toContain("not found")
		})
	})
})
