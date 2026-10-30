/**
 * Document skills binary smoke: every pptx.mjs / pdf.mjs subcommand executed
 * against the compiled binary's embedded runtime (`BUN_BE_BUN=1 kimchi`), with
 * real fixtures — the "does it execute and produce a working artifact" proof
 * that CI runs on the canary smoke job.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runBinary, runSkillScript } from "./harness.js"

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

	it("doc-cli subcommand: the in-binary route runs the same CLIs", () => {
		writeFileSync(join(workDir, "doc.md"), "# Subcommand route\n\n- via the in-binary import\n")
		const create = runBinary({
			args: ["doc-cli", "pdf", "create", "sub.pdf", "--content", "doc.md"],
			cwd: workDir,
		})
		expect(create.status).toBe(0)
		const read = runBinary({ args: ["doc-cli", "pdf", "read", "sub.pdf"], cwd: workDir })
		expect(read.status).toBe(0)
		expect(read.stdout).toContain("Subcommand route")
		const info = runBinary({ args: ["doc-cli", "pdf", "info", "sub.pdf"], cwd: workDir })
		expect(JSON.parse(info.stdout)).toMatchObject({ pageCount: 1, encrypted: false })
		const unknown = runBinary({
			args: ["doc-cli", "evil", "info", "x.pdf"],
			cwd: workDir,
			throwOnError: false,
		})
		expect(unknown.status).toBe(2)
		expect(unknown.stderr).toContain("usage: kimchi doc-cli")
	})

	it("doc-cli subcommand: docx create → read round trip", () => {
		writeFileSync(join(workDir, "doc2.md"), "# Docx via doc-cli\n\nA paragraph.\n")
		const create = runBinary({
			args: ["doc-cli", "docx", "create", "sub.docx", "--content", "doc2.md"],
			cwd: workDir,
		})
		expect(create.status).toBe(0)
		const read = runBinary({ args: ["doc-cli", "docx", "read", "sub.docx"], cwd: workDir })
		expect(read.status).toBe(0)
		expect(read.stdout).toContain("Docx via doc-cli")
	})

	it("doc-cli subcommand: xlsx reads CSVs through the route", () => {
		writeFileSync(join(workDir, "data.csv"), "a,b\n1,2\n3,4\n")
		const read = runBinary({ args: ["doc-cli", "xlsx", "read", "data.csv"], cwd: workDir })
		expect(read.status).toBe(0)
		expect(read.stdout).toContain("a")
		expect(read.stdout).toContain("4")
	})

	it("doc-cli subcommand: pptx create → read round trip", () => {
		writeFileSync(join(workDir, "deck2.md"), "# Deck via doc-cli\n\n---\n\n# Two\n\n- point\n")
		const create = runBinary({
			args: ["doc-cli", "pptx", "create", "sub.pptx", "--content", "deck2.md"],
			cwd: workDir,
		})
		expect(create.status).toBe(0)
		const read = runBinary({ args: ["doc-cli", "pptx", "read", "sub.pptx"], cwd: workDir })
		expect(read.status).toBe(0)
		expect(read.stdout).toContain("Deck via doc-cli")
	})

	it("doc-cli subcommand: large piped output arrives complete (drain before exit)", async () => {
		// >64 KB of stdout through a pipe: if process.exit raced ahead of the
		// stream flush, the tail would be truncated.
		const { PDFDocument } = await import("@cantoo/pdf-lib")
		const doc = await PDFDocument.create()
		const page = doc.addPage([600, 800])
		const form = doc.getForm()
		for (let i = 0; i < 3000; i++) {
			form.createTextField(`field${String(i).padStart(5, "0")}`).addToPage(page, {
				x: 10,
				y: 5,
				width: 50,
				height: 8,
			})
		}
		writeFileSync(join(workDir, "fields.pdf"), await doc.save())
		const fields = runBinary({ args: ["doc-cli", "pdf", "fields", "fields.pdf"], cwd: workDir })
		expect(fields.status).toBe(0)
		expect(fields.stdout.length, "output exceeds the 64 KB pipe buffer").toBeGreaterThan(64 * 1024)
		const lines = fields.stdout.trim().split("\n")
		expect(lines.length).toBe(3000)
		expect(lines.at(-1)).toContain('"name":"field02999"')
	}, 60000)

	it("doc-cli subcommand: cold route exits without touching the network", async () => {
		// Any pre-route regression (org-policy fetch, telemetry ping) would hit
		// the recording endpoint; the route must exit before any of that.
		const requests: string[] = []
		const server: Server = createServer((req, res) => {
			requests.push(`${req.method} ${req.url}`)
			res.destroy()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const { port } = server.address() as AddressInfo
		try {
			const result = runBinary({
				args: ["doc-cli", "evil", "info", "x.pdf"],
				cwd: workDir,
				throwOnError: false,
				extraEnv: {
					KIMCHI_API_KEY: "cold-route-probe",
					KIMCHI_REMOTE_ENDPOINT: `http://127.0.0.1:${port}`,
				},
			})
			expect(result.status).toBe(2)
			expect(requests).toEqual([])
		} finally {
			server.close()
		}
	}, 60000)

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
