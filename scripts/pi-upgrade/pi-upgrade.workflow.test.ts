import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRun, reply } from "@kimchi-dev/kimchi-workflows/testing"
import { describe, expect, it, onTestFinished } from "vitest"
import workflow from "./pi-upgrade.workflow.ts"
import type { Digest, Impact } from "./schemas.ts"

const digest = (from: string, to: string): Digest => ({
	from,
	to,
	features: [{ summary: `feature in ${to}`, evidence: `CHANGELOG.md [${to}]` }],
	breaking: [],
	behaviorChanges: [],
	builtins: [],
	internalsTouched: [],
	badReleaseNotes: [],
})

const impact: Impact = {
	verdict: { risk: "moderate", effort: "M", effortWhy: "one patch conflict", apiBreakage: "none", topHazard: "x" },
	breaking: [],
	keepDisabled: [],
	patchRework: [],
	freeWins: [],
	testTriage: [],
}

function outDir(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-upgrade-wf-"))
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
	mkdirSync(dir, { recursive: true })
	for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, `${name}.json`), JSON.stringify(value))
	const previous = process.env.PI_UPGRADE_OUT_DIR
	process.env.PI_UPGRADE_OUT_DIR = dir
	onTestFinished(() => {
		process.env.PI_UPGRADE_OUT_DIR = previous
	})
	return dir
}

const inputs = {
	settle: { baseline: "1.3.0", target: "1.5.0", chain: ["1.4.0", "1.5.0"] },
	"dry-run": [],
	internals: { methods: [], overwrites: [] },
	tests: { install: { ok: true }, net: [] },
	state: { v: 1, digests: { "1.3.0..1.4.0": digest("1.3.0", "1.4.0") } },
}

describe("pi-upgrade workflow", () => {
	it("digests only release steps missing from the cached state", async () => {
		const dir = outDir(inputs)

		const run = await createTestRun(workflow, {
			agents: { digest: [reply(digest("1.4.0", "1.5.0"))], impact: [reply(impact)] },
		})

		expect(run.status).toBe("completed")
		const analysis = JSON.parse(readFileSync(join(dir, "analysis.json"), "utf8"))
		expect(analysis.digests.map((d: Digest) => `${d.from}..${d.to}`)).toEqual(["1.3.0..1.4.0", "1.4.0..1.5.0"])
		expect(analysis.newDigests.map((d: Digest) => `${d.from}..${d.to}`)).toEqual(["1.4.0..1.5.0"])
		expect(analysis.verdict.effort).toBe("M")
	})
})

describe("pi-upgrade workflow errors", () => {
	it("fails at load when a step's output is missing, naming the file", async () => {
		const { tests: _omitted, ...rest } = inputs
		outDir(rest)

		const run = await createTestRun(workflow, { agents: { impact: [reply(impact)] } })

		expect(run.status).not.toBe("completed")
		expect(run.error).toMatch(/tests\.json/)
	})
})
