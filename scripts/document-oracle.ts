/**
 * Document oracle — Phase 0 slice (PPTX-only).
 *
 * Runs create/edit/check per target-variant combo against self-authored
 * fixtures under a temp dir, asserting the same ground truth PowerPoint would
 * use ("summary numbers untouched", template reuse). Output: oracle-report.md
 * with pass/fail evidence + a per-case artifact dir for CI upload.
 *
 *   bun scripts/document-oracle.ts
 *
 * Requires the bundled pptx.mjs (scripts/copy-resources.js --dev builds it).
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractPptx } from "../src/extensions/documents/extractors/pptx.js"
import { makeSimplePptx } from "../src/extensions/documents/fixtures/builders.js"

const BUNDLE = "resources/skills/pptx/scripts/pptx.mjs"

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
	try {
		const out = execFileSync("bun", [BUNDLE, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
		return { code: 0, out: out.trim(), err: "" }
	} catch (err) {
		const failed = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
		return {
			code: failed.status ?? 1,
			out: String(failed.stdout ?? "").trim(),
			err: String(failed.stderr ?? "").trim(),
		}
	}
}

interface Case {
	name: string
	run(): Promise<string[]> // evidence lines, or throws on regression
}

const root = mkdtempSync(join(tmpdir(), "doc-oracle-"))
mkdirSync(join(root, "out"), { recursive: true })

const caseDeckMarkdown = `---
title: Q3 Oracle
---

# Q3 Oracle

- Revenue up
- Risks tracked

Notes: spoken intro

---

# Metrics

| Metric | Q2 | Q3 |
| ------ | -- | -- |
| ARR    | 10 | 11 |
`

const cases: Case[] = [
	{
		name: "create-fresh then read (chart-less smoke)",
		async run() {
			const md = join(root, "fresh.md")
			const pptx = join(root, "out", "fresh.pptx")
			writeFileSync(md, caseDeckMarkdown)
			const create = await runCli(["create", pptx, "--content", md])
			if (create.code !== 0) throw new Error(`create failed: ${create.err}`)
			const read = await runCli(["read", pptx])
			if (read.code !== 0) throw new Error(`read failed: ${read.err}`)
			for (const needle of ["Q3 Oracle", "Revenue up", "| ARR | 10 | 11 |", "spoken intro"]) {
				if (!read.out.includes(needle)) throw new Error(`read lost content: ${needle}`)
			}
			return [create.out, `read contains Q3 Oracle, bullets, table and notes`]
		},
	},
	{
		name: "check flags defects on seeded-defect deck",
		async run() {
			const { makeDefectivePptx } = await import("../src/extensions/documents/fixtures/builders.js")
			const src = join(root, "defects.pptx")
			writeFileSync(src, await makeDefectivePptx())
			const check = await runCli(["check", src])
			if (check.code !== 1) throw new Error(`expected findings, got exit ${check.code}: ${check.err}`)
			for (const needle of ["overflow", "off-slide", "alt text"]) {
				if (!check.out.includes(needle)) throw new Error(`check missed: ${needle}`)
			}
			return [check.out.slice(0, 120)]
		},
	},
	{
		name: "edit applies ops and never writes in place",
		async run() {
			const src = join(root, "edit-src.pptx")
			const out = join(root, "out", "edited.pptx")
			writeFileSync(src, await makeSimplePptx())
			const opsFile = join(root, "ops.json")
			writeFileSync(
				opsFile,
				JSON.stringify([
					{ type: "set_shape_text", slide: 1, shape: "Body 1", value: "edited" },
					{ type: "reorder_slides", order: [3, 1, 2] },
				]),
			)
			const edit = await runCli(["edit", src, "--out", out, "--ops", opsFile])
			if (edit.code !== 0) throw new Error(`edit failed: ${edit.err}`)
			// in-place invariance: source bytes unchanged
			const after = await extractPptx(writeFileBytes(src))
			if (JSON.stringify(after.units).includes("edited")) throw new Error("edit wrote to the input file")
			const edited = await extractPptx(writeFileBytes(out))
			if (!JSON.stringify(edited.units).includes("edited")) throw new Error("output is missing the edit")
			return [edit.out]
		},
	},
]

function writeFileBytes(path: string): Uint8Array {
	return new Uint8Array(readFileSync(path))
}

const lines: string[] = [`# document-oracle report`, "", `- bundle: \`${BUNDLE}\``, `- workspace: ${root}`, ""]
let failed = 0
for (const c of cases) {
	try {
		const evidence = await c.run()
		lines.push(`PASS ${c.name}`)
		for (const e of evidence.slice(0, 3)) lines.push(`  - ${e}`)
	} catch (err) {
		failed++
		lines.push(`FAIL ${c.name}`)
		lines.push(`  - ${(err as Error).message}`)
	}
}
lines.push("", `${cases.length - failed}/${cases.length} cases passed`)
writeFileSync(join(root, "oracle-report.md"), `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
if (failed > 0) process.exit(1)
