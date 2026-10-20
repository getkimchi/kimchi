/**
 * Document skills binary smoke: every pptx.mjs / pdf.mjs subcommand executed
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

	it("pdf.mjs: dump-shapes/edit-draw run the binary and degrade to a typed LibreOffice error", () => {
		// LibreOffice is optional (like pptx render): CI boxes have none, dev
		// machines may. Either the command succeeds (LO present, full loop) or
		// it fails as tool-missing naming the fix — never a crash.
		writeFileSync(join(workDir, "lo.md"), "# LO Edit Target\n\nEditable line.\n")
		expect(runSkillScript({ workDir, cli: "pdf", args: ["create", "lo.pdf", "--content", "lo.md"] }).status).toBe(0)
		const dump = runSkillScript({ workDir, cli: "pdf", args: ["dump-shapes", "lo.pdf"] })
		if (dump.status === 0) {
			const parsed = JSON.parse(dump.stdout)
			expect(Array.isArray(parsed.shapes)).toBe(true)
			const mapPath = join(workDir, "map.json")
			writeFileSync(mapPath, JSON.stringify([{ page: 1, shape: 0, text: "edited" }]))
			const edit = runSkillScript({
				workDir,
				cli: "pdf",
				args: ["edit-draw", "lo.pdf", "--out", "edited.pdf", "--map", mapPath],
			})
			expect(edit.status).toBe(0)
		} else {
			expect(dump.status).toBe(2)
			expect(dump.stderr).toContain("LibreOffice")
		}
	}, 60000)

	it("pdf.mjs: create (unicode) → read → info → split → merge → reorder → rotate", () => {
		writeFileSync(
			join(workDir, "doc.md"),
			"# Rapport\n\nTotal **cost** ici — Zażółć.\n\n- uno\n- due\n\n| Item | N |\n|---|---|\n| x | 1 |\n\n---\n\n# Second page\n\nfin.\n",
		)
		const create = runSkillScript({ workDir, cli: "pdf", args: ["create", "doc.pdf", "--content", "doc.md"] })
		expect(create.status).toBe(0)
		const read = runSkillScript({ workDir, cli: "pdf", args: ["read", "doc.pdf"] })
		expect(read.stdout).toContain("Rapport")
		expect(read.stdout).toContain("Zażółć")
		expect(read.stdout).toContain("Page 2")
		const info = runSkillScript({ workDir, cli: "pdf", args: ["info", "doc.pdf"] })
		expect(JSON.parse(info.stdout)).toMatchObject({ pageCount: 2, encrypted: false })
		expect(
			runSkillScript({ workDir, cli: "pdf", args: ["split", "doc.pdf", "--pages", "2-2", "--out", "p2.pdf"] }).status,
		).toBe(0)
		expect(JSON.parse(runSkillScript({ workDir, cli: "pdf", args: ["info", "p2.pdf"] }).stdout).pageCount).toBe(1)
		const merge = runSkillScript({ workDir, cli: "pdf", args: ["merge", "m.pdf", "p2.pdf", "doc.pdf"] })
		expect(merge.status).toBe(0)
		expect(JSON.parse(runSkillScript({ workDir, cli: "pdf", args: ["info", "m.pdf"] }).stdout).pageCount).toBe(3)
		expect(
			runSkillScript({ workDir, cli: "pdf", args: ["reorder", "m.pdf", "--order", "3,2,1", "--out", "r.pdf"] }).status,
		).toBe(0)
		expect(
			runSkillScript({ workDir, cli: "pdf", args: ["rotate", "r.pdf", "--out", "rot.pdf", "--angle", "90"] }).status,
		).toBe(0)
	})

	it("pdf.mjs: text fields list and fill", async () => {
		// @cantoo/pdf-lib is a repo dependency; build a one-field form fixture.
		const { PDFDocument } = await import("@cantoo/pdf-lib")
		const doc = await PDFDocument.create()
		const page = doc.addPage([400, 300])
		const form = doc.getForm()
		const t = form.createTextField("user.name")
		t.addToPage(page, { x: 50, y: 200, width: 200, height: 20 })
		writeFileSync(join(workDir, "form.pdf"), await doc.save())
		const fields = runSkillScript({ workDir, cli: "pdf", args: ["fields", "form.pdf"] })
		expect(fields.stdout).toContain('"name":"user.name"')
		writeFileSync(join(workDir, "v.json"), JSON.stringify({ "user.name": "Ada" }))
		const fill = runSkillScript({
			workDir,
			cli: "pdf",
			args: ["fill-form", "form.pdf", "--out", "filled.pdf", "--values", "v.json"],
		})
		expect(fill.status).toBe(0)
		const filled = runSkillScript({ workDir, cli: "pdf", args: ["fields", "filled.pdf"] })
		expect(filled.stdout).toContain('"value":"Ada"')
	})
})
