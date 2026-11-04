// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
// @ts-expect-error — domino types are declared under 'domino', not '@mixmark-io/domino'
import domino from "@mixmark-io/domino"
import { describe, expect, it, vi } from "vitest"
import { convertContent } from "./content-converter.js"

describe("convertContent", () => {
	const BASE_URL = "https://example.com/page"

	describe("format: markdown", () => {
		it("converts headings to ATX style", () => {
			const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("# Title")
			expect(md).toContain("## Subtitle")
			expect(md).toContain("### Section")
		})

		it("converts links with resolved URLs", () => {
			const html = '<p>Visit <a href="/docs">the docs</a> for help.</p>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("[the docs](https://example.com/docs)")
		})

		it("preserves absolute URLs unchanged", () => {
			const html = '<a href="https://other.com/path">external</a>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("[external](https://other.com/path)")
		})

		it("converts unordered lists", () => {
			const html = "<ul><li>one</li><li>two</li><li>three</li></ul>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("-   one")
			expect(md).toContain("-   two")
			expect(md).toContain("-   three")
		})

		it("converts ordered lists", () => {
			const html = "<ol><li>first</li><li>second</li></ol>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("1.  first")
			expect(md).toContain("2.  second")
		})

		it("converts inline code", () => {
			const html = "<p>Use <code>npm install</code> to install.</p>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("`npm install`")
		})

		it("converts fenced code blocks", () => {
			const html = "<pre><code>const x = 1;\nconst y = 2;</code></pre>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("```")
			expect(md).toContain("const x = 1;")
		})

		it("converts emphasis and strong", () => {
			const html = "<p><em>italic</em> and <strong>bold</strong></p>"
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("*italic*")
			expect(md).toContain("**bold**")
		})

		it("converts nested structures", () => {
			const html =
				'<div><h2>Section</h2><p>Text with <a href="/link">a link</a> and <em>emphasis</em>.</p><ul><li>item with <code>code</code></li></ul></div>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("## Section")
			expect(md).toContain("[a link](https://example.com/link)")
			expect(md).toContain("*emphasis*")
			expect(md).toContain("`code`")
		})

		it("resolves relative src attributes on images", () => {
			const html = '<img src="/img/photo.png" alt="photo">'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("https://example.com/img/photo.png")
		})

		it("resolves parent-relative URLs (../)", () => {
			const html = '<a href="../other">up</a>'
			const md = convertContent(html, "https://example.com/a/b/page", "markdown")
			expect(md).toContain("https://example.com/a/other")
		})
	})

	describe("format: text", () => {
		it("extracts plain text from paragraphs", () => {
			const html = "<p>Hello world</p>"
			const text = convertContent(html, BASE_URL, "text")
			expect(text).toContain("Hello world")
		})

		it("strips all HTML tags", () => {
			const html = "<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <a href='/x'>link</a>.</p>"
			const text = convertContent(html, BASE_URL, "text")
			expect(text).not.toContain("<")
			expect(text).not.toContain(">")
			expect(text).toContain("Title")
			expect(text).toContain("Paragraph with bold and link.")
		})

		it("separates block elements with newlines", () => {
			const html = "<h1>Title</h1><p>Paragraph</p>"
			const text = convertContent(html, BASE_URL, "text")
			const lines = text.split("\n")
			expect(lines).toContain("Title")
			expect(lines).toContain("Paragraph")
		})

		it("extracts text from lists", () => {
			const html = "<ul><li>one</li><li>two</li></ul>"
			const text = convertContent(html, BASE_URL, "text")
			expect(text).toContain("one")
			expect(text).toContain("two")
		})

		it("collapses excessive whitespace", () => {
			const html = "<p>  lots   of    spaces  </p>"
			const text = convertContent(html, BASE_URL, "text")
			expect(text).toBe("lots of spaces")
		})
	})

	describe("format: html", () => {
		it("returns raw HTML unchanged", () => {
			const html = "<h1>Title</h1><nav>menu</nav><script>alert(1)</script>"
			const result = convertContent(html, BASE_URL, "html")
			expect(result).toBe(html)
		})

		it("does not strip any elements", () => {
			const html = "<nav>nav</nav><footer>footer</footer><script>x</script><style>.y{}</style>"
			const result = convertContent(html, BASE_URL, "html")
			expect(result).toContain("<nav>")
			expect(result).toContain("<footer>")
			expect(result).toContain("<script>")
			expect(result).toContain("<style>")
		})

		it("does not modify URLs", () => {
			const html = '<a href="/relative">link</a>'
			const result = convertContent(html, BASE_URL, "html")
			expect(result).toContain('href="/relative"')
		})
	})

	describe("boilerplate stripping", () => {
		const boilerplateHTML = `<html><head>
			<style>.x{color:red}</style>
			<meta charset="utf-8">
			<link rel="stylesheet" href="/style.css">
		</head><body>
			<script>alert('xss')</script>
			<nav><a href="/">Home</a> <a href="/about">About</a></nav>
			<h1>Content</h1>
			<p>Main text</p>
			<footer><p>Copyright 2026</p></footer>
			<iframe src="https://ad.example.com"></iframe>
			<svg><circle r="10"/></svg>
			<noscript>Please enable JavaScript</noscript>
			<header><h2>Header section</h2></header>
			<aside>Sidebar content</aside>
		</body></html>`

		it("strips script elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("alert")
		})

		it("strips style elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("color:red")
		})

		it("strips meta elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("charset")
		})

		it("strips link elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("style.css")
		})

		it("strips nav elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("About")
		})

		it("strips footer elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("Copyright")
		})

		it("strips iframe elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("ad.example.com")
		})

		it("strips svg elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("circle")
		})

		it("strips noscript elements in markdown", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).not.toContain("enable JavaScript")
		})

		it("preserves header elements", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).toContain("Header section")
		})

		it("preserves aside elements", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).toContain("Sidebar content")
		})

		it("preserves main content", () => {
			const md = convertContent(boilerplateHTML, BASE_URL, "markdown")
			expect(md).toContain("# Content")
			expect(md).toContain("Main text")
		})

		it("strips boilerplate in text format too", () => {
			const text = convertContent(boilerplateHTML, BASE_URL, "text")
			expect(text).not.toContain("alert")
			expect(text).not.toContain("Copyright")
			expect(text).not.toContain("About")
			expect(text).toContain("Content")
			expect(text).toContain("Main text")
			expect(text).toContain("Header section")
			expect(text).toContain("Sidebar content")
		})
	})

	describe("malformed HTML fallback", () => {
		it("handles null input without throwing in markdown format", () => {
			const result = convertContent(null as unknown as string, BASE_URL, "markdown")
			expect(typeof result).toBe("string")
		})

		it("handles null input without throwing in text format", () => {
			const result = convertContent(null as unknown as string, BASE_URL, "text")
			expect(typeof result).toBe("string")
		})

		it("returns raw HTML unchanged for null input in html format", () => {
			// html format is passthrough — returns input before parsing
			const result = convertContent(null as unknown as string, BASE_URL, "html")
			expect(result).toBeNull()
		})

		it("handles empty string without throwing", () => {
			const mdResult = convertContent("", BASE_URL, "markdown")
			expect(typeof mdResult).toBe("string")

			const textResult = convertContent("", BASE_URL, "text")
			expect(typeof textResult).toBe("string")
		})

		it("handles binary garbage without throwing", () => {
			const garbage = "\x00\x01\x02\xFF\xFE\x80\x81"
			const mdResult = convertContent(garbage, BASE_URL, "markdown")
			expect(typeof mdResult).toBe("string")

			const textResult = convertContent(garbage, BASE_URL, "text")
			expect(typeof textResult).toBe("string")
		})

		it("returns fallback when domino.createDocument throws", () => {
			const spy = vi.spyOn(domino, "createDocument").mockImplementation(() => {
				throw new Error("Simulated parse failure")
			})
			try {
				const mdResult = convertContent("<html>valid</html>", BASE_URL, "markdown")
				expect(mdResult).toBe("[Error: failed to parse HTML content]")

				const textResult = convertContent("<html>valid</html>", BASE_URL, "text")
				expect(textResult).toBe("[Error: failed to parse HTML content]")
			} finally {
				spy.mockRestore()
			}
		})
	})

	describe("relative URL resolution", () => {
		it("resolves root-relative paths", () => {
			const html = '<a href="/docs/api">API</a>'
			const md = convertContent(html, "https://example.com/page", "markdown")
			expect(md).toContain("https://example.com/docs/api")
		})

		it("resolves parent-relative paths", () => {
			const html = '<a href="../sibling">link</a>'
			const md = convertContent(html, "https://example.com/a/b/page", "markdown")
			expect(md).toContain("https://example.com/a/sibling")
		})

		it("resolves same-directory relative paths", () => {
			const html = '<a href="other.html">link</a>'
			const md = convertContent(html, "https://example.com/dir/page", "markdown")
			expect(md).toContain("https://example.com/dir/other.html")
		})

		it("preserves absolute URLs", () => {
			const html = '<a href="https://other.com/page">link</a>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("https://other.com/page")
		})

		it("preserves fragment-only URLs", () => {
			const html = '<a href="#section">link</a>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("https://example.com/page#section")
		})

		it("resolves src attributes", () => {
			const html = '<img src="/images/pic.jpg" alt="pic">'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("https://example.com/images/pic.jpg")
		})

		it("leaves malformed URLs as-is", () => {
			const html = '<a href="://broken">link</a>'
			const md = convertContent(html, BASE_URL, "markdown")
			expect(md).toContain("link")
		})

		it("resolves URLs in text format too", () => {
			// text format still strips boilerplate and resolves URLs (for potential later use)
			// but since text output doesn't show URLs, we just verify it doesn't crash
			const html = '<a href="/docs">docs</a>'
			const text = convertContent(html, BASE_URL, "text")
			expect(text).toContain("docs")
		})
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
