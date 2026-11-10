import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { type PipelineSteps, runPipeline } from "./all.ts"
import type { RunConfig } from "./config.ts"

function setup(target: string | null) {
	const outDir = mkdtempSync(join(tmpdir(), "pi-upgrade-all-"))
	onTestFinished(() => rmSync(outDir, { recursive: true, force: true }))
	const cfg = { outDir } as RunConfig
	const ran: string[] = []
	const step = (name: string) => async () => {
		ran.push(name)
		return name === "settle" ? { target } : {}
	}
	const steps: PipelineSteps = {
		settle: step("settle"),
		fetch: step("fetch"),
		"dry-run": step("dry-run"),
		internals: step("internals"),
		tests: step("tests"),
		analyze: step("analyze"),
		render: step("render"),
		publish: step("publish"),
	}
	return { cfg, ran, steps }
}

describe("runPipeline", () => {
	it("runs every step in order when a report is due", async () => {
		const { cfg, ran, steps } = setup("1.4.0")
		await runPipeline(cfg, steps, () => true)
		expect(ran).toEqual(["settle", "fetch", "dry-run", "internals", "tests", "analyze", "render", "publish"])
	})

	it("only settles and publishes when there is no settled target", async () => {
		const { cfg, ran, steps } = setup(null)
		await runPipeline(cfg, steps, () => true)
		expect(ran).toEqual(["settle", "publish"])
	})

	it("skips the expensive steps when the issue is already current", async () => {
		const { cfg, ran, steps } = setup("1.4.0")
		await runPipeline(cfg, steps, () => false)
		expect(ran).toEqual(["settle", "publish"])
	})
})

describe("runPipeline errors", () => {
	it("records a failing step and keeps going so the report still renders", async () => {
		const { cfg, ran, steps } = setup("1.4.0")
		steps.tests = async () => {
			ran.push("tests")
			throw new Error("pnpm exploded")
		}
		await runPipeline(cfg, steps, () => true)
		expect(ran).toEqual(["settle", "fetch", "dry-run", "internals", "tests", "analyze", "render", "publish"])
		expect(JSON.parse(readFileSync(join(cfg.outDir, "tests.error.json"), "utf8"))).toEqual({ message: "pnpm exploded" })
		expect(existsSync(join(cfg.outDir, "fetch.error.json"))).toBe(false)
	})
})
