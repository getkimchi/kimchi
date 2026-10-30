import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isDocCliCommand, isReadOnlyDocCliCommand, isUnderBundledSkillsDir } from "./bundled-skill-cli.js"

describe("isDocCliCommand", () => {
	// Tokenizer-divergence shapes (shell-quote vs the executing shell): each
	// direction is either benign (the real shell errors) or expands to the
	// allowed command itself. Pinned so a future divergence that flips a
	// direction fails here first.
	const accepts = [
		"kimchi doc-cli pdf read report.pdf",
		"kimchi doc-cli pdf read report.pdf 1-5",
		"kimchi doc-cli pdf info report.pdf",
		"kimchi doc-cli docx create out.docx --content doc.md",
		"kimchi doc-cli xlsx info sheet.xlsx",
		"kimchi doc-cli pptx read deck.pptx",
		"kimchi doc-cli pdf read x.pdf 2>&1",
		"kimchi doc-cli pdf read x.pdf 2>&1 | tail -20",
		"kimchi doc-cli pdf read 'my file.pdf'",
		"kimchi  doc-cli pdf read x.pdf",
		"kimchi doc-cli pdf read x.pdf ",
		// U+00A0 joins the program name for the real shell → command not found;
		// the matcher sees the allowed shape. Benign divergence.
		"kimchi\u00A0doc-cli pdf read x.pdf",
		// shell-quote erases the $-glued variable; the real shell expands it to
		// the plain token only when unset — fresh shell per bash call, and an
		// env prefix on the same command is rejected above.
		"kimchi ${A}doc-cli pdf read x.pdf",
	]

	const rejects = [
		// not the route / not bare kimchi
		"./kimchi doc-cli pdf read x.pdf",
		"/usr/local/bin/kimchi doc-cli pdf read x.pdf",
		"node /bundled/skills/pdf/scripts/pdf.mjs read x.pdf",
		`BUN_BE_BUN=1 kimchi /bundled/skills/pdf/scripts/pdf.mjs read x.pdf`,
		"kimchi pdf read x.pdf",
		"kimi doc-cli pdf read x.pdf",
		// wrong / missing closed-set members
		"kimchi doc-cli",
		"kimchi doc-cli pdf",
		"kimchi doc-cli evil read x.pdf",
		"kimchi doc-cli Pdf read x.pdf",
		"kimchi doc-cli pdf.. read x.pdf",
		"kimchi doc-cli pdıf read x.pdf",
		// env prefixes must never reach the harness's own resolution
		"BUN_BE_BUN=1 kimchi doc-cli pdf read x.pdf",
		"FOO=bar kimchi doc-cli pdf read x.pdf",
		// ops that write files or hide code
		"kimchi doc-cli pdf read x.pdf > out.txt",
		"kimchi doc-cli pdf read x.pdf >> out.txt",
		"kimchi doc-cli pdf read x.pdf < in.txt",
		// compound tails
		"kimchi doc-cli pdf read x.pdf; rm -rf ~",
		"kimchi doc-cli pdf read x.pdf && echo done",
		"kimchi doc-cli pdf read x.pdf | sh",
		"kimchi doc-cli pdf read x.pdf | bash",
		// substitution and newline/CR smuggling (the tokenizer folds them, the
		// executing shell does not)
		"kimchi doc-cli pdf read x.pdf\nrm -rf ~",
		"kimchi doc-cli pdf read x.pdf\r\nrm -rf ~",
		"kimchi doc-cli $(rm -rf ~) pdf read x.pdf",
		"kimchi doc-cli `rm -rf ~` pdf read x.pdf",
		// hard-blocked commands stay hard-blocked
		"kimchi doc-cli pdf read x.pdf; sudo rm -rf /",
		// degenerate inputs
		"",
		"   ",
	]

	for (const command of accepts) {
		it(`accepts: ${JSON.stringify(command)}`, () => {
			expect(isDocCliCommand(command)).toBe(true)
		})
	}

	for (const command of rejects) {
		it(`rejects: ${JSON.stringify(command)}`, () => {
			expect(isDocCliCommand(command)).toBe(false)
		})
	}
})

describe("isUnderBundledSkillsDir", () => {
	let root: string

	it("requires a root and a path", () => {
		expect(isUnderBundledSkillsDir("", "/bundled", "/cwd")).toBe(false)
		expect(isUnderBundledSkillsDir("x.pdf", null, "/cwd")).toBe(false)
	})

	it("detects paths inside the root (absolute and cwd-relative)", () => {
		root = mkdtempSync(join(tmpdir(), "kimchi-doc-cli-root-"))
		try {
			mkdirSync(join(root, "pdf", "scripts"), { recursive: true })
			writeFileSync(join(root, "pdf", "scripts", "pdf.mjs"), "")
			expect(isUnderBundledSkillsDir(join(root, "pdf", "scripts", "pdf.mjs"), root, "/cwd")).toBe(true)
			expect(isUnderBundledSkillsDir("pdf/scripts/pdf.mjs", root, root)).toBe(true)
			// creation inside the root: the target does not exist, the longest
			// existing prefix is the root itself
			expect(isUnderBundledSkillsDir(join(root, "pwn", "scripts", "pwn.mjs"), root, "/cwd")).toBe(true)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("rejects paths outside the root and prefix lookalikes", () => {
		root = mkdtempSync(join(tmpdir(), "kimchi-doc-cli-root-"))
		const sibling = mkdtempSync(join(tmpdir(), "kimchi-doc-cli-root-sibling-"))
		try {
			expect(isUnderBundledSkillsDir(join(sibling, "x.mjs"), root, "/cwd")).toBe(false)
			expect(isUnderBundledSkillsDir("../etc/passwd", root, root)).toBe(false)
		} finally {
			rmSync(root, { recursive: true, force: true })
			rmSync(sibling, { recursive: true, force: true })
		}
	})

	it("rejects a symlinked target that realpaths outside the root", () => {
		root = mkdtempSync(join(tmpdir(), "kimchi-doc-cli-root-"))
		try {
			// Injected realpath: the root resolves to itself, everything under it
			// (a symlink) escapes to /etc/passwd.
			const escaping: Record<string, string> = { [root]: root }
			expect(isUnderBundledSkillsDir(join(root, "link.mjs"), root, "/cwd", (p) => escaping[p] ?? "/etc/passwd")).toBe(
				false,
			)
			// The root itself must resolve; an unresolvable root fails closed.
			expect(isUnderBundledSkillsDir(join(root, "x.mjs"), root, "/cwd", () => null)).toBe(false)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})

describe("isReadOnlyDocCliCommand", () => {
	const readOnly = [
		"kimchi doc-cli pdf read report.pdf",
		"kimchi doc-cli pdf fields report.pdf",
		"kimchi doc-cli pdf dump-shapes report.pdf --page 2",
		"kimchi doc-cli pdf info report.pdf 2>&1 | tail -5",
		"kimchi doc-cli docx read notes.docx",
		"kimchi doc-cli docx info notes.docx",
		"kimchi doc-cli xlsx read sheet.xlsx --sheet Budget",
		"kimchi doc-cli xlsx info sheet.xlsx",
		"kimchi doc-cli pptx read deck.pptx",
		"kimchi doc-cli pptx inspect deck.pptx",
		"kimchi doc-cli pptx check deck.pptx",
	]
	it.each(readOnly)("accepts %s", (command) => {
		expect(isReadOnlyDocCliCommand(command)).toBe(true)
	})

	const mutating = [
		"kimchi doc-cli pdf fill-form report.pdf --values v.json",
		"kimchi doc-cli pdf write out.pdf --content doc.md",
		"kimchi doc-cli pdf render page.pdf --out page.png",
		"kimchi doc-cli pdf merge a.pdf b.pdf --out merged.pdf",
		"kimchi doc-cli docx create out.docx --content doc.md",
		"kimchi doc-cli docx edit in.docx --out out.docx --ops ops.json",
		"kimchi doc-cli xlsx edit in.xlsx --out out.xlsx --ops ops.json",
		"kimchi doc-cli xlsx recalc in.xlsx --out out.xlsx",
		"kimchi doc-cli pptx create out.pptx --spec spec.json",
		"kimchi doc-cli pptx edit in.pptx --out out.pptx --ops ops.json",
	]
	it.each(mutating)("rejects the mutating subcommand %s", (command) => {
		expect(isReadOnlyDocCliCommand(command)).toBe(false)
		// the shape itself still matches — only the subcommand class differs
		expect(isDocCliCommand(command)).toBe(true)
	})

	it("rejects shapes the doc-cli matcher rejects", () => {
		expect(isReadOnlyDocCliCommand("pdftotext report.pdf -")).toBe(false)
		expect(isReadOnlyDocCliCommand("kimchi doc-cli pdf read x.pdf && echo hi")).toBe(false)
		expect(isReadOnlyDocCliCommand("BUN_BE_BUN=1 kimchi doc-cli pdf read x.pdf")).toBe(false)
	})
})
