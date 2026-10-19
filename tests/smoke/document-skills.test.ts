/**
 * Document skills binary smoke: every pptx.mjs subcommand executed
 * against the compiled binary's embedded runtime (`BUN_BE_BUN=1 kimchi`), with
 * real fixtures — the "does it execute and produce a working artifact" proof
 * that CI runs on the canary smoke job.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runSkillScript } from "./harness.js"

describe("document skills under the compiled binary", () => {
	let workDir: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "kimchi-doc-skills-"))
	})
	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true })
	})

	it("pptx.mjs: create → read → inspect → check", () => {
		writeFileSync(join(workDir, "deck.md"), "# Smoke deck\n\n---\n\n# Findings\n\n- bundling works\n- runner parity\n")
		const create = runSkillScript({ workDir, cli: "pptx", args: ["create", "deck.pptx", "--content", "deck.md"] })
		expect(create.status).toBe(0)
		const read = runSkillScript({ workDir, cli: "pptx", args: ["read", "deck.pptx"] })
		expect(read.status).toBe(0)
		expect(read.stdout).toContain("## Slide 1")
		expect(read.stdout).toContain("Findings")
		const inspect = runSkillScript({ workDir, cli: "pptx", args: ["inspect", "deck.pptx"] })
		expect(inspect.status).toBe(0)
		const check = runSkillScript({ workDir, cli: "pptx", args: ["check", "deck.pptx"] })
		// Findings are fine (e.g. dead-space hints on a sparse fixture deck) —
		// the contract is that check runs and prints them, not that they vanish.
		expect([0, 1]).toContain(check.status)
	})

	it("pptx.mjs: edit never writes in place", () => {
		writeFileSync(join(workDir, "deck.md"), "# E1\n\n---\n\n# Two\n\n- point\n")
		expect(runSkillScript({ workDir, cli: "pptx", args: ["create", "e.pptx", "--content", "deck.md"] }).status).toBe(0)
		writeFileSync(
			join(workDir, "ops.json"),
			JSON.stringify([{ type: "set_shape_notes", slide: 2, value: "smoke notes" }]),
		)
		const original = readFileSync(join(workDir, "e.pptx"))
		const edit = runSkillScript({
			workDir,
			cli: "pptx",
			args: ["edit", "e.pptx", "--out", "e2.pptx", "--ops", "ops.json"],
		})
		expect(edit.status).toBe(0)
		expect(readFileSync(join(workDir, "e.pptx"))).toEqual(original)
	})
})
