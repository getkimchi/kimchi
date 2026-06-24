import { describe, expect, it } from "vitest"
import {
	ADHOC_MODE_TOOLS,
	FERMENT_MODE_TOOLS,
	SHARED_CORE_TOOLS,
	type ToolEntry,
	type ToolProfile,
	WRITE_TOOLS,
	getToolsForProfile,
} from "./tool-catalog.js"

const namesOf = (entries: ToolEntry[]): string[] => entries.map((t) => t.name)

const TOOL_NAMES = {
	sharedCore: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
	adhocOnly: ["questionnaire", "create_todos", "update_todos", "add_todo", "mark_todo", "clear_todos"],
	fermentPlanningTools: [
		"set_phase",
		"propose_ferment_scoping",
		"scope_ferment",
		"update_ferment_scope_field",
		"confirm_ferment_completion_criteria",
		"ask_user",
		"activate_ferment_phase",
		"list_ferments",
	],
	fermentImplementationTools: [
		"refine_ferment_phase",
		"complete_ferment_phase",
		"skip_ferment_phase",
		"fail_ferment_phase",
		"start_ferment_step",
		"complete_ferment_step",
		"verify_ferment_step",
		"skip_ferment_step",
		"fail_ferment_step",
		"add_ferment_decision",
		"add_ferment_memory",
		"complete_ferment",
	],
}

describe("SHARED_CORE_TOOLS", () => {
	it("contains the 6 read-only discovery tools", () => {
		expect(SHARED_CORE_TOOLS).toHaveLength(6)
		for (const name of TOOL_NAMES.sharedCore) {
			expect(SHARED_CORE_TOOLS).toContainEqual(expect.objectContaining({ name }))
		}
	})
})

describe("ADHOC_MODE_TOOLS", () => {
	it("contains --plan-only tools", () => {
		expect(ADHOC_MODE_TOOLS).toHaveLength(6)
		for (const name of TOOL_NAMES.adhocOnly) {
			expect(ADHOC_MODE_TOOLS).toContainEqual(expect.objectContaining({ name }))
		}
	})

	it("does not contain ferment-mode tools", () => {
		const fermentTools = ["ask_user", "confirm_ferment_completion_criteria", "set_phase", "activate_ferment_phase"]
		for (const name of fermentTools) {
			expect(namesOf(ADHOC_MODE_TOOLS)).not.toContain(name)
		}
	})
})

describe("FERMENT_MODE_TOOLS", () => {
	const allNames = namesOf(FERMENT_MODE_TOOLS)

	const expectedPlanningTools = [
		"set_phase",
		"propose_ferment_scoping",
		"scope_ferment",
		"update_ferment_scope_field",
		"confirm_ferment_completion_criteria",
		"list_ferments",
		"ask_user",
		"activate_ferment_phase",
	]

	const expectedImplementationTools = [
		"refine_ferment_phase",
		"complete_ferment_phase",
		"skip_ferment_phase",
		"fail_ferment_phase",
		"start_ferment_step",
		"complete_ferment_step",
		"verify_ferment_step",
		"skip_ferment_step",
		"fail_ferment_step",
		"add_ferment_decision",
		"add_ferment_memory",
		"complete_ferment",
	]

	it("contains the ferment lifecycle tools", () => {
		for (const name of [...expectedPlanningTools, ...expectedImplementationTools]) {
			expect(allNames).toContain(name)
		}
	})

	it("does not contain adhoc-mode tools", () => {
		for (const name of TOOL_NAMES.adhocOnly) {
			expect(allNames).not.toContain(name)
		}
	})

	it("annotates planning-only vs implementation-only tools", () => {
		const byName = (name: string): ToolEntry => {
			const found = FERMENT_MODE_TOOLS.find((t) => t.name === name)
			if (!found) throw new Error(`Tool ${name} not found in FERMENT_MODE_TOOLS`)
			return found
		}

		// planning-only
		expect(byName("set_phase").phases).toEqual(["planning"])
		expect(byName("propose_ferment_scoping").phases).toEqual(["planning"])
		expect(byName("confirm_ferment_completion_criteria").phases).toEqual(["planning"])
		expect(byName("activate_ferment_phase").phases).toEqual(["planning"])

		// implementation-only
		expect(byName("refine_ferment_phase").phases).toEqual(["implementation"])
		expect(byName("start_ferment_step").phases).toEqual(["implementation"])
		expect(byName("complete_ferment").phases).toEqual(["implementation"])

		// both phases (ask_user)
		expect(byName("ask_user").phases).toEqual(["planning", "implementation"])

		// no phases field — available in both
		expect(byName("list_ferments").phases).toBeUndefined()
	})
})

describe("WRITE_TOOLS", () => {
	it("includes bash shared between adhoc and ferment", () => {
		const bash = WRITE_TOOLS.find((t) => t.name === "bash")
		expect(bash).toBeDefined()
		expect(bash?.modes).toContain("adhoc")
		expect(bash?.modes).toContain("ferment")
	})

	it("excludes edit/write/Agent/get_subagent_result from adhoc", () => {
		const fermentOnly = ["edit", "write", "Agent", "get_subagent_result"]
		for (const name of fermentOnly) {
			const tool = WRITE_TOOLS.find((t) => t.name === name)
			expect(tool).toBeDefined()
			expect(tool?.modes).not.toContain("adhoc")
		}
	})
})

describe("getToolsForProfile", () => {
	describe("idle", () => {
		it("returns only shared core tools", () => {
			const result = getToolsForProfile("idle")
			expect(result).toHaveLength(6)
			expect(namesOf(result)).toEqual(TOOL_NAMES.sharedCore)
		})

		it("does NOT include questionnaire, ask_user, bash, edit, write, Agent", () => {
			const result = getToolsForProfile("idle")
			const excluded = ["questionnaire", "ask_user", "bash", "edit", "write", "Agent"]
			for (const name of excluded) {
				expect(namesOf(result)).not.toContain(name)
			}
		})
	})

	describe("worker", () => {
		it("returns empty", () => {
			expect(getToolsForProfile("worker")).toHaveLength(0)
		})
	})

	describe("planning-adhoc", () => {
		const result = getToolsForProfile("planning-adhoc")
		const names = namesOf(result)

		it("includes all SHARED_CORE_TOOLS", () => {
			for (const name of TOOL_NAMES.sharedCore) {
				expect(names).toContain(name)
			}
		})

		it("includes all ADHOC_MODE_TOOLS", () => {
			for (const name of TOOL_NAMES.adhocOnly) {
				expect(names).toContain(name)
			}
		})

		it("includes bash", () => {
			expect(names).toContain("bash")
		})

		it("does NOT include ferment-only tools", () => {
			const fermentOnly = [
				"ask_user",
				"confirm_ferment_completion_criteria",
				"set_phase",
				"propose_ferment_scoping",
				"scope_ferment",
				"activate_ferment_phase",
			]
			for (const name of fermentOnly) {
				expect(names).not.toContain(name)
			}
		})

		it("does NOT include write tools other than bash", () => {
			const writeTools = ["edit", "write", "Agent", "get_subagent_result"]
			for (const name of writeTools) {
				expect(names).not.toContain(name)
			}
		})
	})

	describe("planning-ferment", () => {
		const result = getToolsForProfile("planning-ferment")
		const names = namesOf(result)

		it("includes all SHARED_CORE_TOOLS", () => {
			for (const name of TOOL_NAMES.sharedCore) {
				expect(names).toContain(name)
			}
		})

		it("includes ferment tools visible in planning", () => {
			for (const name of TOOL_NAMES.fermentPlanningTools) {
				expect(names).toContain(name)
			}
		})

		it("does NOT include adhoc-only tools", () => {
			for (const name of TOOL_NAMES.adhocOnly) {
				expect(names).not.toContain(name)
			}
		})

		it("does NOT include write tools", () => {
			const writeTools = ["edit", "write", "Agent", "get_subagent_result", "bash"]
			for (const name of writeTools) {
				expect(names).not.toContain(name)
			}
		})

		it("does NOT include implementation-only ferment tools", () => {
			for (const name of TOOL_NAMES.fermentImplementationTools) {
				expect(names).not.toContain(name)
			}
		})
	})

	describe("implementation-ferment", () => {
		const result = getToolsForProfile("implementation-ferment")
		const names = namesOf(result)

		it("includes all SHARED_CORE_TOOLS", () => {
			for (const name of TOOL_NAMES.sharedCore) {
				expect(names).toContain(name)
			}
		})

		it("includes all FERMENT_MODE_TOOLS", () => {
			for (const name of [...TOOL_NAMES.fermentPlanningTools, ...TOOL_NAMES.fermentImplementationTools]) {
				expect(names).toContain(name)
			}
		})

		it("includes write tools", () => {
			const writeTools = ["bash", "edit", "write", "Agent", "get_subagent_result"]
			for (const name of writeTools) {
				expect(names).toContain(name)
			}
		})

		it("does NOT include adhoc-only tools", () => {
			for (const name of TOOL_NAMES.adhocOnly) {
				expect(names).not.toContain(name)
			}
		})
	})
})

describe("routing metadata", () => {
	it("questionnaire is interactive", () => {
		const result = getToolsForProfile("planning-adhoc")
		const tool = result.find((t) => t.name === "questionnaire")
		expect(tool).toBeDefined()
		expect(tool?.routing).toBe("interactive")
	})

	it("ask_user is interactive", () => {
		const result = getToolsForProfile("planning-ferment")
		const tool = result.find((t) => t.name === "ask_user")
		expect(tool).toBeDefined()
		expect(tool?.routing).toBe("interactive")
	})

	it("confirm_ferment_completion_criteria is interactive", () => {
		const result = getToolsForProfile("planning-ferment")
		const tool = result.find((t) => t.name === "confirm_ferment_completion_criteria")
		expect(tool).toBeDefined()
		expect(tool?.routing).toBe("interactive")
	})

	it("non-interactive tools do not have routing set", () => {
		const profiles: ToolProfile[] = ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"]
		const nonInteractiveNames = ["read", "grep", "update_todos", "edit", "write"]
		for (const profile of profiles) {
			const result = getToolsForProfile(profile)
			for (const name of nonInteractiveNames) {
				const tool = result.find((t) => t.name === name)
				if (tool) {
					expect(tool.routing).toBeUndefined()
				}
			}
		}
	})
})
