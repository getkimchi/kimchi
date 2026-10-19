import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ARTIFACT_EXTENSIONS, artifactsFromToolCall, resolveToolPath } from "./artifacts.js"

let cwd: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "acp-artifacts-"))
})

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true })
})

function touch(rel: string): string {
	const abs = join(cwd, rel)
	mkdirSync(join(abs, ".."), { recursive: true })
	writeFileSync(abs, "x")
	return abs
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}

describe("artifactsFromToolCall", () => {
	it("keeps the bash sniff regex in sync with ARTIFACT_EXTENSIONS", () => {
		// PATH_TOKEN inlines the extension list (regex literal); every
		// allowlisted extension must be detectable BOTH from bash output (regex)
		// and from write/edit args (map lookup) — a drift in either list
		// silently disables one path.
		for (const ext of Object.keys(ARTIFACT_EXTENSIONS)) {
			const out = artifactsFromToolCall("bash", {}, textResult(`wrote file${ext}`), cwd, { verifyExists: false })
			expect(
				out.map((a) => a.name),
				`bash sniff of file${ext}`,
			).toEqual([`file${ext}`])
			const abs = touch(`w${ext}`)
			expect(
				artifactsFromToolCall("write", { path: `w${ext}` }, textResult("ok"), cwd).map((a) => a.path),
				`write detection of w${ext}`,
			).toEqual([abs])
		}
	})

	it("detects a write to an allowlisted extension", () => {
		const abs = touch("slides.pptx")
		const out = artifactsFromToolCall("write", { path: "slides.pptx" }, textResult("ok"), cwd)
		expect(out).toEqual([
			{
				path: abs,
				name: "slides.pptx",
				uri: pathToFileURL(abs).href,
				mimeType: expect.stringContaining("presentationml"),
			},
		])
	})

	it("ignores write/edit paths outside the allowlist", () => {
		touch("notes.txt")
		expect(artifactsFromToolCall("write", { path: "notes.txt" }, textResult("ok"), cwd)).toEqual([])
		expect(artifactsFromToolCall("edit", { path: "notes.txt" }, textResult("ok"), cwd)).toEqual([])
	})

	it("detects an edit to an allowlisted extension", () => {
		const abs = touch("report.pdf")
		const out = artifactsFromToolCall("edit", { path: abs }, textResult("ok"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("returns nothing for write without a string path", () => {
		expect(artifactsFromToolCall("write", {}, textResult("ok"), cwd)).toEqual([])
		expect(artifactsFromToolCall("write", { path: 42 }, textResult("ok"), cwd)).toEqual([])
	})

	it("detects a path mentioned in bash output", () => {
		const abs = touch("out/deck.pptx")
		const out = artifactsFromToolCall("bash", { command: "python make.py" }, textResult(`saved to ${abs}\n`), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("detects cwd-relative paths in bash output", () => {
		const abs = touch("out/deck.pptx")
		const out = artifactsFromToolCall("bash", {}, textResult("wrote out/deck.pptx"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("handles quoted paths and trailing punctuation", () => {
		const abs = touch("chart.png")
		const out = artifactsFromToolCall("bash", {}, textResult('generated "chart.png", done.'), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
	})

	it("strips paren/bracket delimiters around paths", () => {
		const abs = touch("out.pdf")
		const results = touch("results.pdf")
		const out = artifactsFromToolCall("bash", {}, textResult("wrote report (out.pdf)"), cwd)
		expect(out.map((a) => a.path)).toEqual([abs])
		const md = artifactsFromToolCall("bash", {}, textResult(`see [results.pdf](file://x)`), cwd)
		expect(md.map((a) => a.path)).toEqual([results])
		// Without the bracket strip, replay mode would surface ghost tokens.
		const replay = artifactsFromToolCall("bash", {}, textResult("wrote (ghost.pdf)"), cwd, {
			verifyExists: false,
		})
		expect(replay.map((a) => a.name)).toEqual(["ghost.pdf"])
	})

	it("a repeated token does not starve the candidate budget", () => {
		touch("late.pdf")
		const noise = Array.from({ length: 500 }, () => "spam.pdf").join(" ")
		const out = artifactsFromToolCall("bash", {}, textResult(`${noise} late.pdf`), cwd)
		expect(out.map((a) => a.name)).toEqual(["late.pdf"])
	})

	it("rejects URL candidates and detects powershell output", () => {
		expect(artifactsFromToolCall("bash", {}, textResult("downloaded https://example.com/file.pdf"), cwd)).toEqual([])
		const abs = touch("ps-report.csv")
		const ps = artifactsFromToolCall("powershell", {}, textResult(`Export-Csv ${abs}`), cwd)
		expect(ps.map((a) => a.path)).toEqual([abs])
	})

	it("detects multiple distinct artifacts and dedupes repeats", () => {
		const a = touch("a.pdf")
		const b = touch("b.xlsx")
		const out = artifactsFromToolCall("bash", {}, textResult(`${a}\n${b}\n${a}\n`), cwd)
		expect(out.map((x) => x.path)).toEqual([a, b])
	})

	it("filters candidates that do not exist on disk (live mode)", () => {
		const out = artifactsFromToolCall("bash", {}, textResult("saved to ghost.pptx"), cwd)
		expect(out).toEqual([])
	})

	it("skips the existence check when verifyExists is false (replay mode)", () => {
		const out = artifactsFromToolCall("bash", {}, textResult("saved to ghost.pptx"), cwd, { verifyExists: false })
		expect(out.map((a) => a.name)).toEqual(["ghost.pptx"])
	})

	it("returns nothing for errored results", () => {
		touch("slides.pptx")
		expect(artifactsFromToolCall("write", { path: "slides.pptx" }, textResult("boom", true), cwd)).toEqual([])
		expect(artifactsFromToolCall("bash", {}, textResult("saved slides.pptx", true), cwd)).toEqual([])
	})

	it("returns nothing for read-only tools", () => {
		const abs = touch("a.pdf")
		expect(artifactsFromToolCall("read", { path: abs }, textResult(abs), cwd)).toEqual([])
	})

	it("caps bash artifacts per call", () => {
		const names = Array.from({ length: 12 }, (_, i) => `f${i}.pdf`)
		for (const n of names) touch(n)
		const out = artifactsFromToolCall("bash", {}, textResult(names.join("\n")), cwd)
		expect(out.length).toBe(8)
	})

	it("caps candidate evaluations per result so pathological output can't stall the scan", () => {
		const noise = Array.from({ length: 5000 }, (_, i) => `missing${i}.pdf`).join(" ")
		expect(artifactsFromToolCall("bash", {}, textResult(noise), cwd)).toEqual([])
		// A real file mentioned first lands well under the candidate cap.
		touch("real.pdf")
		const out = artifactsFromToolCall("bash", {}, textResult(`real.pdf ${noise}`), cwd)
		expect(out.map((a) => a.name)).toEqual(["real.pdf"])
	})

	it("never throws on malformed inputs", () => {
		expect(artifactsFromToolCall("bash", null, undefined, cwd)).toEqual([])
		expect(artifactsFromToolCall("bash", {}, { content: "not-an-array" }, cwd)).toEqual([])
		expect(artifactsFromToolCall("write", { path: `${String.fromCharCode(0)}.pdf` }, textResult("ok"), cwd)).toEqual([])
	})
})

describe("resolveToolPath", () => {
	it("resolves relative paths against cwd", () => {
		expect(resolveToolPath("a/b.pdf", cwd)).toBe(join(cwd, "a/b.pdf"))
	})

	it("strips the @ prefix and file:// scheme", () => {
		expect(resolveToolPath("@x.pdf", cwd)).toBe(join(cwd, "x.pdf"))
		expect(resolveToolPath(pathToFileURL(join(cwd, "y.pdf")).href, cwd)).toBe(join(cwd, "y.pdf"))
	})
})
