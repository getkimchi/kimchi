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

describe("seeded evaluator requirements (persisted contract)", () => {
	async function setupSeeded() {
		const ledger = createRequirementLedger("Implementation context: seeded claim", {
			seeded: [requirement],
			seededReason: "persisted contract v2 (pre implementation)",
			seededVersion: 2,
			idWatermark: 1,
		})
		const child = createExtensionApi()
		await ledger.extension(child.api)
		const tool = child.getRegisteredTool(RECORD_REQUIREMENTS_TOOL)
		return {
			ledger,
			record: (requirements = [requirement], options?: { reason?: string; expectedVersion?: number }) =>
				tool.execute(
					"record",
					{
						requirements,
						...(options?.reason ? { reason: options.reason } : {}),
						...(options?.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {}),
					},
					undefined,
					undefined,
					createContext(),
				),
		}
	}

	it("starts with the persisted list in history and coverage", async () => {
		const { ledger } = await setupSeeded()
		expect(ledger.history).toEqual([
			{ requirements: [requirement], reason: "persisted contract v2 (pre implementation)" },
		])
		expect(ledger.baseVersion).toBe(2)
		expect(ledger.version()).toBe(2)
		expect(ledger.additions).toEqual([])
		expect(ledger.coverageGap([])).toContain("r1")
		expect(ledger.coverageGap([{ requirementId: "r1", category: "behavior" }])).toBeUndefined()
		expect(ledger.category("r1")).toBe("behavior")
	})

	it("acknowledges the identical list, releasing the implementation context", async () => {
		const { record } = await setupSeeded()
		const acknowledged = JSON.stringify(await record())
		expect(acknowledged).toContain("acknowledged")
		expect(acknowledged).toContain("seeded claim")
	})

	it("cannot replace, weaken, recategorize, or remove an existing criterion", async () => {
		const { ledger, record } = await setupSeeded()
		for (const list of [
			[{ ...requirement, requirement: "A weakened obligation" }],
			[{ ...requirement, category: "constraint" as const }],
			[{ ...requirement, acceptance: "Anything counts" }],
		]) {
			const rejected = await record(list, { reason: "attempted rewrite" })
			expect(rejected).toMatchObject({ isError: true })
		}
		const removal = await record([{ ...requirement, id: "r2", requirement: "A different obligation" }], {
			reason: "replacing r1",
		})
		expect(removal).toMatchObject({ isError: true })
		expect(JSON.stringify(removal)).toContain("continue")
		expect(JSON.stringify(removal)).toContain("cannot change, weaken, recategorize, or remove")
		// A removal submitted alone is equally rejected: r1 must stay.
		const dropSeeded = await record([{ ...requirement, id: "r2", requirement: "Another obligation" }], {
			reason: "dropping r1",
		})
		expect(dropSeeded).toMatchObject({ isError: true })
		expect(ledger.history).toHaveLength(1)
		expect(ledger.additions).toEqual([])
	})

	it("adds an omitted obligation with a fresh ID, a source-grounded reason, and the expected version", async () => {
		const { ledger, record } = await setupSeeded()
		const added = { ...requirement, id: "r2", requirement: "An omitted obligation" }
		const accepted = await record([requirement, added], {
			reason: "Objective also requires the report to be deterministic",
			expectedVersion: 2,
		})
		expect(accepted).not.toMatchObject({ isError: true })
		expect(JSON.stringify(accepted)).toContain("Addition accepted: r2")
		expect(JSON.stringify(accepted)).toContain("seeded claim")
		expect(ledger.history).toHaveLength(2)
		expect(ledger.history[1]).toEqual({
			requirements: [requirement, added],
			reason: "Objective also requires the report to be deterministic",
		})
		expect(ledger.additions).toEqual([
			{
				items: [added],
				reason: "Objective also requires the report to be deterministic",
				basedOnVersion: 2,
			},
		])
		expect(ledger.version()).toBe(3)
		// The addition is in coverage immediately: it needs its own outcome.
		expect(ledger.coverageGap([{ requirementId: "r1" }])).toContain("r2")
		expect(ledger.coverageGap([{ requirementId: "r1" }, { requirementId: "r2" }])).toBeUndefined()
		expect(ledger.category("r2")).toBe("behavior")
	})

	it("rejects an addition without a reason, without the expected version, or with the wrong version", async () => {
		const { ledger, record } = await setupSeeded()
		const added = { ...requirement, id: "r2", requirement: "An omitted obligation" }
		expect(await record([requirement, added])).toMatchObject({ isError: true })
		expect(await record([requirement, added], { reason: "grounded" })).toMatchObject({ isError: true })
		expect(await record([requirement, added], { reason: "grounded", expectedVersion: 1 })).toMatchObject({
			isError: true,
		})
		expect(await record([requirement, added], { reason: "grounded", expectedVersion: 3 })).toMatchObject({
			isError: true,
		})
		expect(ledger.history).toHaveLength(1)
		expect(ledger.additions).toEqual([])
	})

	it("rejects retired or colliding IDs and enforces the 64-item bound", async () => {
		const seeded = Array.from({ length: 63 }, (_, index) => ({
			...requirement,
			id: `r${index + 1}`,
			requirement: `Obligation ${index + 1}`,
		}))
		const ledger = createRequirementLedger("context", {
			seeded,
			seededVersion: 1,
			idWatermark: 70,
		})
		const child = createExtensionApi()
		await ledger.extension(child.api)
		const tool = child.getRegisteredTool(RECORD_REQUIREMENTS_TOOL)
		const call = (requirements: VerifierRequirement[], expectedVersion = 1, reason = "grounded") =>
			tool.execute("record", { requirements, reason, expectedVersion }, undefined, undefined, createContext())
		// A fresh-looking ID at or below the watermark is a retired ID: rejected.
		const retired = await call([...seeded, { ...requirement, id: "r64" }])
		expect(retired).toMatchObject({ isError: true })
		expect(JSON.stringify(retired)).toContain("fresh requirement IDs above r70")
		// Beyond the 64-item bound: the parser rejects the list outright.
		const overflowing = await call([...seeded, { ...requirement, id: "r100" }, { ...requirement, id: "r101" }])
		expect(overflowing).toMatchObject({ isError: true })
		expect(ledger.additions).toEqual([])
	})

	it("accepts a chained addition against the version the first acceptance produced", async () => {
		const { ledger, record } = await setupSeeded()
		const first = { ...requirement, id: "r2", requirement: "First omitted obligation" }
		await record([requirement, first], { reason: "Objective clause A", expectedVersion: 2 })
		// A further addition must state the in-review version the first produced;
		// resubmitting the identical list is an acknowledgement, so the version
		// fence is tested with a list that grows.
		expect(
			await record([requirement, first, { ...requirement, id: "r9", requirement: "Another" }], {
				reason: "stale version",
				expectedVersion: 2,
			}),
		).toMatchObject({ isError: true })
		const second = { ...requirement, id: "r3", requirement: "Second omitted obligation" }
		const accepted = await record([requirement, first, second], {
			reason: "Objective clause B",
			expectedVersion: 3,
		})
		expect(accepted).not.toMatchObject({ isError: true })
		expect(ledger.version()).toBe(4)
		expect(ledger.additions).toEqual([
			{ items: [first], reason: "Objective clause A", basedOnVersion: 2 },
			{ items: [second], reason: "Objective clause B", basedOnVersion: 3 },
		])
		// The acknowledgement after additions compares against the grown list.
		expect(JSON.stringify(await record([first, requirement, second]))).not.toContain("isError")
		expect(ledger.history).toHaveLength(3)
	})

	it("rejects a chained addition below an ID this review already allocated", async () => {
		const { ledger, record } = await setupSeeded()
		const first = { ...requirement, id: "r3", requirement: "First omitted obligation" }
		await record([requirement, first], { reason: "Objective clause A", expectedVersion: 2 })
		// r2 was never allocated, but this review already allocated r3: the host
		// would reject r2 at settle time, so the ledger rejects it immediately
		// instead of accepting an addition that cannot persist.
		const descending = await record(
			[requirement, first, { ...requirement, id: "r2", requirement: "Below the allocation" }],
			{ reason: "Objective clause B", expectedVersion: 3 },
		)
		expect(descending).toMatchObject({ isError: true })
		expect(JSON.stringify(descending)).toContain("above r3")
		expect(ledger.additions).toEqual([{ items: [first], reason: "Objective clause A", basedOnVersion: 2 }])
		// An ID above the running allocation still applies.
		const second = { ...requirement, id: "r4", requirement: "Second omitted obligation" }
		const accepted = await record([requirement, first, second], {
			reason: "Objective clause B",
			expectedVersion: 3,
		})
		expect(accepted).not.toMatchObject({ isError: true })
		expect(ledger.additions).toHaveLength(2)
	})
})
