#!/usr/bin/env node
/**
 * docs-check — mechanical invariants for docs/memory/ (the Memory Book).
 *
 * Parser-level, browserless, zero-dependency. Verifies:
 *   1. Mermaid block syntax (structural: diagram type, balanced brackets,
 *      balanced subgraph/end, well-formed arrows).
 *   2. Relative markdown links between book pages resolve.
 *   3. Curated memory terms used on a page appear with at least one
 *      glossary backlink to reading-guide.md on that page.
 *   4. Cited repo paths (`src/...`, `docs/...` in code spans) exist.
 *   5. Every appendix ledger pin resolves: the §heading exists in the cited
 *      source file, and any double-quoted fragment of the claim appears
 *      (whitespace-insensitively) in that file.
 *   6. Status discipline: every book page carries a Status header;
 *      06-dreaming is labeled RESEARCHED; Part III pages are PROPOSED.
 *
 * Self-test: `--self-test` runs the checker against
 * scripts/fixtures/docs-check/ and requires each planted defect to be caught.
 *
 * Usage: node scripts/docs-check.mjs [--self-test] [--root <dir>]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")
const BOOK = join(REPO, "docs", "memory")
const FIXTURES = join(HERE, "fixtures", "docs-check")

/** Curated glossary terms (from docs/memory/reading-guide.md). Update when the glossary changes. */
const MEMORY_TERMS = [
	"paraphrase ceiling",
	"landing band",
	"background distribution",
	"support set",
	"truth tier",
	"k-anonymity",
	"value gate",
	"supersede",
	"digest",
	"anisotropy",
]

const MERMAID_TYPES = new Set([
	"flowchart",
	"graph",
	"sequenceDiagram",
	"classDiagram",
	"stateDiagram",
	"erDiagram",
	"gantt",
	"pie",
	"journey",
	"mindmap",
	"timeline",
])

const errors = []
let checked = 0

function fail(page, check, detail) {
	errors.push(`${page}: [${check}] ${detail}`)
}

function extractMermaid(text) {
	const blocks = []
	const re = /```mermaid\n([\s\S]*?)```/g
	let m = re.exec(text)
	while (m) {
		blocks.push(m[1])
		m = re.exec(text)
	}
	return blocks
}

function checkMermaid(page, block, idx) {
	const tag = `diagram #${idx + 1}`
	const first = block.trim().split("\n")[0].trim().split(/\s/)[0]
	if (!MERMAID_TYPES.has(first)) fail(page, "mermaid", `${tag}: unknown diagram type "${first}"`)
	let depth = 0
	for (const [i, line] of block.split("\n").entries()) {
		const t = line.trim()
		if (t.startsWith("subgraph")) depth++
		if (t === "end") depth--
		if (depth < 0) fail(page, "mermaid", `${tag}: unbalanced end at line ${i + 1}`)
	}
	if (depth !== 0) fail(page, "mermaid", `${tag}: ${depth} unclosed subgraph block(s)`)
	const open = (block.match(/\[/g) || []).length
	const close = (block.match(/\]/g) || []).length
	if (open !== close) fail(page, "mermaid", `${tag}: unbalanced brackets [${open}/${close}]`)
	// arrows must connect two node-ish tokens (edge labels |label| stripped first)
	for (const [i, line] of block.split("\n").entries()) {
		const t = line.trim()
		const arrow = ["-.->", "==>", "-->"].find((a) => t.includes(a))
		if (!arrow) continue
		const sides = t.split(arrow).map((p) => p.replace(/\|[^|]*\|/g, "").trim())
		if (sides.some((s) => s === "")) {
			fail(page, "mermaid", `${tag}: dangling arrow at line ${i + 1}: "${t.slice(0, 60)}"`)
		}
	}
	checked++
}

function checkLinks(page, text, baseDir) {
	const re = /\[[^\]]*\]\(([^)#]+)(#[^)]*)?\)/g
	let m = re.exec(text)
	while (m) {
		const target = m[1]
		if (/^(https?|mailto):/.test(target)) {
			m = re.exec(text)
			continue
		}
		const resolved = resolve(baseDir, target)
		if (!existsSync(resolved)) fail(page, "link", `unresolved relative link: ${target}`)
		m = re.exec(text)
	}
	checked++
}

function checkGlossaryBacklinks(page, text) {
	if (page.endsWith("reading-guide.md")) return
	for (const term of MEMORY_TERMS) {
		const used = new RegExp(`\\b${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i").test(text)
		if (!used) continue
		if (!text.includes("reading-guide.md")) {
			fail(page, "glossary", `uses term "${term}" without any glossary backlink on the page`)
		}
	}
	checked++
}

function checkRepoPaths(page, text) {
	const re = /`((?:src|docs)\/[^`\s]+?)`/g
	let m = re.exec(text)
	while (m) {
		if (m[1].includes("*") || m[1].includes("...")) {
			m = re.exec(text)
			continue
		}
		const p = m[1]
		if (p.endsWith("/")) {
			if (!existsSync(join(REPO, p))) fail(page, "repo-path", `missing dir: ${p}`)
		} else if (!existsSync(join(REPO, p))) {
			// allow extensionless doc references resolved by .md
			if (!existsSync(join(REPO, `${p}.md`))) fail(page, "repo-path", `missing path: ${p}`)
		}
		m = re.exec(text)
	}
	checked++
}

function checkStatus(page, text) {
	if (!/\*\*Status:/.test(text)) fail(page, "status", "missing **Status:** header line")
	if (page.endsWith("06-dreaming.md") && !/RESEARCHED/.test(text)) {
		fail(page, "status", "dreaming page must be labeled RESEARCHED")
	}
	const base = page.split("/").pop()
	if (/^1\d-.*\.md$/.test(base) && !/PROPOSED/.test(text)) {
		fail(page, "status", `Part III page ${base} must be labeled PROPOSED`)
	}
	checked++
}

function checkLedger(rootForSources) {
	const appendixPath = join(rootForSources, "appendix.md")
	if (!existsSync(appendixPath)) {
		fail("appendix.md", "ledger", "appendix.md missing")
		return
	}
	const text = readFileSync(appendixPath, "utf8")
	const rows = text.split("\n").filter((l) => l.startsWith("| E") || l.startsWith("| S"))
	for (const row of rows) {
		const cells = row
			.split("|")
			.map((c) => c.trim())
			.filter(Boolean)
		if (cells.length < 4) continue
		const [id, claim, , source] = cells
		// Source cells look like: "whitepaper §5.13 (`docs/research/…md`)" or "spike E2 (`…md`)"
		const fileMatch = source.match(/`([^`]+\.md)`/)
		const sectionMatch = source.match(/§([\d.~–-]+)/)
		let srcFile = null
		if (fileMatch) srcFile = fileMatch[1]
		else if (/whitepaper/.test(source)) srcFile = "docs/research/memory-dreaming-whitepaper.md"
		else if (/spike/i.test(source)) srcFile = ".kimchi/docs/decision-model-spike/report.md"
		if (!srcFile) {
			fail("appendix.md", "ledger", `${id}: cannot determine source file from "${source}"`)
			continue
		}
		const abs = join(REPO, srcFile)
		if (!existsSync(abs)) {
			// .kimchi/docs sources are expected to exist locally even if git-ignored
			fail("appendix.md", "ledger", `${id}: source file not found: ${srcFile}`)
			continue
		}
		const srcText = readFileSync(abs, "utf8")
		if (sectionMatch) {
			// Source documents number sections as "### 5.11"; ledger pins write "§5.11".
			// Literal contains (no regex) — heading style and §-mention style both accepted.
			const num = sectionMatch[1].split(/[~–-]/)[0].replace(/\.$/, "")
			if (!srcText.includes(`### ${num}`) && !srcText.includes(`§${num}`)) {
				fail("appendix.md", "ledger", `${id}: section §${num} not found in ${srcFile}`)
			}
		}
		const quoted = claim.match(/"([^"]{12,})"/)
		if (quoted) {
			const norm = (s) => s.replace(/\s+/g, " ")
			if (!norm(srcText).includes(norm(quoted[1]))) {
				fail("appendix.md", "ledger", `${id}: quoted fragment not found in ${srcFile}: "${quoted[1].slice(0, 60)}…"`)
			}
		}
		checked++
	}
}

function run(rootForSources) {
	const pages = readdirSync(rootForSources).filter((f) => f.endsWith(".md"))
	if (pages.length === 0) fail(rootForSources, "structure", "no markdown pages found")
	for (const f of pages) {
		const path = join(rootForSources, f)
		const text = readFileSync(path, "utf8")
		checkLinks(f, text, rootForSources)
		checkGlossaryBacklinks(f, text)
		checkRepoPaths(f, text)
		checkStatus(f, text)
		for (const [i, block] of extractMermaid(text).entries()) checkMermaid(f, block, i)
	}
	checkLedger(rootForSources)
}

function selfTest() {
	const cases = [
		{ dir: join(FIXTURES, "broken-link"), expect: /link/ },
		{ dir: join(FIXTURES, "bad-mermaid"), expect: /mermaid/ },
		{ dir: join(FIXTURES, "shifted-pin"), expect: /ledger/ },
	]
	let ok = true
	for (const c of cases) {
		errors.length = 0
		run(c.dir)
		const found = errors.some((e) => c.expect.test(e))
		if (!found) {
			console.error(`SELF-TEST FAIL: expected ${c.expect} error in ${c.dir}, got:`, errors)
			ok = false
		} else {
			console.log(`self-test ok: ${c.dir.split("/").pop()} → caught ${errors.length} defect(s)`)
		}
	}
	process.exit(ok ? 0 : 1)
}

const args = process.argv.slice(2)
if (args.includes("--self-test")) {
	selfTest()
} else {
	const rootIdx = args.indexOf("--root")
	run(rootIdx >= 0 ? resolve(args[rootIdx + 1]) : BOOK)
	if (errors.length > 0) {
		console.error(`docs-check: ${errors.length} failure(s) over ${checked} checks:`)
		for (const e of errors) console.error(`  ✗ ${e}`)
		process.exit(1)
	}
	console.log(`docs-check: green (${checked} checks)`)
}
