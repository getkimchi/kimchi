import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { createRequirementLedger, RECORD_REQUIREMENTS_TOOL, type VerifierRequirement } from "./requirements.js"

const requirement: VerifierRequirement = {
	id: "r1",
	requirement: "Export the report as JSON",
	source: "Objective: export the report as JSON",
	acceptance: "The public export command emits parseable JSON with all report fields",
	category: "behavior",
}

async function setup() {
	const ledger = createRequirementLedger("Implementation context: private claim")
	const child = createExtensionApi()
	await ledger.extension(child.api)
	const tool = child.getRegisteredTool(RECORD_REQUIREMENTS_TOOL)
	return {
		ledger,
		record: (requirements = [requirement], reason?: string) =>
			tool.execute("record", { requirements, ...(reason ? { reason } : {}) }, undefined, undefined, createContext()),
	}
}

describe("evaluator requirements", () => {
	it("requires a recorded list before accepting any verdict", async () => {
		const { ledger } = await setup()
		expect(ledger.coverageGap([{ requirementId: "r1" }])).toContain("Call record_requirements")
	})
	it("releases implementation context only after accepting a valid initial list", async () => {
		const { ledger, record } = await setup()
		const rejected = await record([{ ...requirement, source: " " }])
		expect(rejected).toMatchObject({ isError: true })
		expect(JSON.stringify(rejected)).not.toContain("private claim")
		expect(ledger.history).toEqual([])
		expect(JSON.stringify(await record())).toContain("private claim")
	})
	it("rejects duplicate IDs without changing the list", async () => {
		const { ledger, record } = await setup()
		expect(await record([requirement, requirement])).toMatchObject({ isError: true })
		expect(ledger.history).toEqual([])
	})
	it("detects an omitted requirement even when the returned checks all pass", async () => {
		const { ledger, record } = await setup()
		await record([requirement, { ...requirement, id: "r2", requirement: "Expose the command in the CLI" }])
		expect(ledger.coverageGap([{ requirementId: "r1" }])).toContain("r2")
		expect(ledger.coverageGap([{ requirementId: "r1" }, { requirementId: "r2" }])).toBeUndefined()
	})
	it("rejects missing and unknown requirement references", async () => {
		const { ledger, record } = await setup()
		await record()
		expect(ledger.coverageGap([{}])).toContain("requirementId")
		expect(ledger.coverageGap([{ requirementId: "r9" }])).toContain("requirementId")
	})

	it("reports all omitted requirements in the single correction opportunity", async () => {
		const { ledger, record } = await setup()
		await record([requirement, { ...requirement, id: "r2" }, { ...requirement, id: "r3" }])
		const gap = ledger.coverageGap([{ requirementId: "r1" }])
		expect(gap).toContain("Recorded requirement r2")
		expect(gap).toContain("Recorded requirement r3")
	})
	it("permits several checks to cover one requirement", async () => {
		const { ledger, record } = await setup()
		await record()
		expect(ledger.coverageGap([{ requirementId: "r1" }, { requirementId: "r1" }])).toBeUndefined()
	})
	it("requires a reason for changing, adding, or removing requirements", async () => {
		const { ledger, record } = await setup()
		await record()
		for (const list of [
			[{ ...requirement, acceptance: "A file exists" }],
			[requirement, { ...requirement, id: "r2" }],
			[{ ...requirement, id: "r2" }],
		])
			expect(await record(list)).toMatchObject({ isError: true })
		expect(ledger.history).toHaveLength(1)
	})
	it("preserves the initial interpretation and every explained revision", async () => {
		const { ledger, record } = await setup()
		await record()
		const revised = { ...requirement, acceptance: "The documented CLI flag emits the requested JSON" }
		await record([revised], "README documents the existing public flag; verify through that flag")
		expect(ledger.history).toEqual([
			{ requirements: [requirement] },
			{ requirements: [revised], reason: "README documents the existing public flag; verify through that flag" },
		])
	})
	it("keeps removed obligations in history and validates against the revised list", async () => {
		const { ledger, record } = await setup()
		await record([requirement, { ...requirement, id: "r2" }])
		await record([requirement], "r2 duplicated r1; the objective asks for one export")
		expect(ledger.history[0]?.requirements).toHaveLength(2)
		expect(ledger.coverageGap([{ requirementId: "r1" }])).toBeUndefined()
		expect(ledger.coverageGap([{ requirementId: "r1" }, { requirementId: "r2" }])).toContain("current recorded")
	})
	it("keeps recorded categories authoritative without treating legacy category labels as coverage gaps", async () => {
		const { ledger, record } = await setup()
		await record()
		expect(ledger.coverageGap([{ requirementId: "r1", category: "constraint" }])).toBeUndefined()
		expect(ledger.category("r1")).toBe("behavior")
		expect(ledger.coverageGap([{ requirementId: "r1", kind: "final_answer" }])).toBeUndefined()
	})
	it("accepts final-answer checks for recorded delivery conditions", async () => {
		const { ledger, record } = await setup()
		await record([{ ...requirement, category: "delivery" }])
		expect(ledger.coverageGap([{ requirementId: "r1", kind: "final_answer" }])).toBeUndefined()
	})
	it("does not duplicate snapshots or repeat implementation context on unchanged submissions", async () => {
		const { ledger, record } = await setup()
		await record()
		expect(JSON.stringify(await record())).not.toContain("private claim")
		expect(ledger.history).toHaveLength(1)
	})
})
