import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

// Vitest (vite) cannot consume Bun's `with { type: "text" }` asset imports —
// stub them; the browser runtime path is verified by the TUI e2e seam test.
vi.mock("../../../../node_modules/diff2html/bundles/css/diff2html.min.css", () => ({ default: "/* css */" }))
vi.mock("../../../../node_modules/diff2html/bundles/js/diff2html-ui.min.js", () => ({ default: "/* ui */" }))

import { buildDiffHtmlDocument, writeDiffHtmlFile } from "./diff-html.js"

describe("buildDiffHtmlDocument", () => {
	it("embeds the patch as JSON, escapes HTML in the title, and carries no raw </script", () => {
		const tricky = `diff --git a/x.ts b/x.ts\n+</script><script>alert(1)</script>\n`
		const doc = buildDiffHtmlDocument({ title: "my <branch>", subtitle: "1 file", patch: tricky })

		// The payload exists exactly once, JSON encoded
		expect(doc).toContain('<script id="diff-patch" type="application/json">')
		const payload = doc.split('<script id="diff-patch" type="application/json">')[1]?.split("</script>")[0] ?? ""
		expect(JSON.parse(payload)).toBe(tricky)
		// The payload itself must contain no raw "</script" boundary.
		expect(payload).not.toContain("</script")
		// Title/placeholder: tag-openers are escaped ("<" is the boundary).
		expect(doc).toContain("my &lt;branch>")
		expect(doc).not.toContain("<branch>")
	})

	it("renders the diff2html entry points client-side with an offline fallback", () => {
		const doc = buildDiffHtmlDocument({ title: "t", patch: "" })
		expect(doc).toContain("new Diff2HtmlUI(target, patch, config)")
		expect(doc).toContain('inputFormat: "diff"')
		expect(doc).toContain('outputFormat: "side-by-side"')
	})
})

describe("writeDiffHtmlFile", () => {
	it("writes remote-diff.html next to the patch and returns the path", () => {
		const dir = mkdtempSync(join(tmpdir(), "diff-html-test-"))
		const patchPath = join(dir, "remote-diff.diff")
		const htmlPath = writeDiffHtmlFile(patchPath, { title: "t", patch: "diff --git a/a b/a\n+x\n" })

		expect(htmlPath).toBe(join(dir, "remote-diff.html"))
		expect(readFileSync(htmlPath, "utf-8")).toContain("diff --git a/a b/a")
	})
})
