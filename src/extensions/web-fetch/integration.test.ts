import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as browserPool from "./browser-pool.js"
import { cacheClear, cacheSize } from "./cache.js"
import { convertContent } from "./content-converter.js"
import { fetchPage } from "./page-fetcher.js"

// Allow 127.0.0.1 through URL validation for the tool handler integration tests
vi.mock("./url-validator.js", () => ({
	validateURL: (raw: string) => {
		try {
			return { valid: true, url: new URL(raw) }
		} catch {
			return { valid: false, error: `Invalid URL: "${raw}"` }
		}
	},
}))

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import webFetchExtension from "./index.js"

// Detect whether Playwright browsers are installed (they may be absent in CI).
let hasPlaywrightBrowsers = false
try {
	const pw = await import("playwright")
	const browser = await pw.chromium.launch({ headless: true })
	await browser.close()
	hasPlaywrightBrowsers = true
} catch {
	// Playwright not installed or no browsers available — SPA tests will be skipped.
}

let server: Server
let baseURL: string

/** Rich HTML page with boilerplate, relative URLs, and varied content for format testing. */
const RICH_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Rich Test Page</title>
  <style>body { font-family: sans-serif; }</style>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <script>console.log('tracking');</script>
  <nav><a href="/">Home</a> | <a href="/about">About</a></nav>

  <h1>Documentation</h1>
  <p>Welcome to the docs. See the <a href="/api/reference">API reference</a> for details.</p>
  <p>You can also check the <a href="https://external.example.com/guide">external guide</a>.</p>

  <h2>Getting Started</h2>
  <ul>
    <li>Install the package</li>
    <li>Import the module</li>
    <li>Call <code>init()</code></li>
  </ul>

  <h3>Code Example</h3>
  <pre><code>import { init } from "lib";
init({ debug: true });</code></pre>

  <p>Here is an <em>important</em> note with <strong>bold text</strong>.</p>
  <img src="/images/diagram.png" alt="Architecture diagram">

  <header><h2>Header Section</h2></header>
  <aside>This sidebar is preserved.</aside>

  <footer><p>Copyright 2026 Example Corp</p></footer>
  <iframe src="https://ads.example.com/banner"></iframe>
  <svg><circle r="50"/></svg>
  <noscript>Enable JavaScript for full experience.</noscript>
</body>
</html>`

/** SPA page — content is populated by inline JavaScript after load. */
const SPA_HTML = `<!DOCTYPE html>
<html>
<head><title>SPA Test</title></head>
<body>
  <div id="app">Loading...</div>
  <script>
    // Simulate a client-side rendered SPA
    document.getElementById('app').innerHTML = '<h1>SPA Content Rendered</h1><p>This was rendered by JavaScript.</p>';
  </script>
</body>
</html>`

function handler(req: IncomingMessage, res: ServerResponse) {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`)

	switch (url.pathname) {
		case "/html":
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			res.end(`<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
<h1>Hello World</h1>
<p>This is a test page with a <a href="/other">link</a>.</p>
</body>
</html>`)
			break

		case "/rich":
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			res.end(RICH_HTML)
			break

		case "/spa":
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			res.end(SPA_HTML)
			break

		case "/json":
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ message: "hello", items: [1, 2, 3] }))
			break

		case "/plain":
			res.writeHead(200, { "Content-Type": "text/plain" })
			res.end("Just plain text.")
			break

		case "/redirect":
			res.writeHead(302, { Location: "/html" })
			res.end()
			break

		case "/not-found":
			res.writeHead(404, { "Content-Type": "text/plain" })
			res.end("Not Found")
			break

		case "/server-error":
			res.writeHead(500, { "Content-Type": "text/plain" })
			res.end("Internal Server Error")
			break

		case "/slow": {
			const delay = Number.parseInt(url.searchParams.get("delay") ?? "5000", 10)
			setTimeout(() => {
				res.writeHead(200, { "Content-Type": "text/html" })
				res.end("<p>Slow response</p>")
			}, delay)
			break
		}

		case "/binary":
			res.writeHead(200, { "Content-Type": "application/octet-stream" })
			res.end(Buffer.from([0x00, 0x01, 0x02, 0x03]))
			break

		case "/large": {
			// Generate a large HTML page that converts to >100K characters of markdown
			const paragraphCount = 5000
			const paragraphs = Array.from(
				{ length: paragraphCount },
				(_, i) => `<p>Paragraph ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(5)}</p>`,
			).join("\n")
			const largeHTML = `<!DOCTYPE html><html><body><h1>Large Page</h1>\n${paragraphs}\n</body></html>`
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
			res.end(largeHTML)
			break
		}

		default:
			res.writeHead(404)
			res.end("Unknown route")
	}
}

beforeAll(async () => {
	server = createServer(handler)
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve())
	})
	const addr = server.address()
	if (!addr || typeof addr === "string") throw new Error("Failed to start test server")
	baseURL = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
	const { shutdownBrowserPool } = await import("./browser-pool.js")
	await shutdownBrowserPool()
	await new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()))
	})
})

describe("integration: fetchPage with local HTTP server", () => {
	it("fetches a static HTML page", async () => {
		const result = await fetchPage(`${baseURL}/html`)
		expect(result.statusCode).toBe(200)
		expect(result.isHTML).toBe(true)
		expect(result.body).toContain("Hello World")
		expect(result.contentType).toContain("text/html")
	})

	it("fetches JSON content", async () => {
		const result = await fetchPage(`${baseURL}/json`)
		expect(result.isHTML).toBe(false)
		expect(result.contentType).toContain("application/json")
		const parsed = JSON.parse(result.body)
		expect(parsed.message).toBe("hello")
		expect(parsed.items).toEqual([1, 2, 3])
	})

	it("fetches plain text content", async () => {
		const result = await fetchPage(`${baseURL}/plain`)
		expect(result.isHTML).toBe(false)
		expect(result.body).toBe("Just plain text.")
	})

	it("follows redirects and reports final URL", async () => {
		const result = await fetchPage(`${baseURL}/redirect`)
		expect(result.statusCode).toBe(200)
		expect(result.finalURL).toContain("/html")
		expect(result.body).toContain("Hello World")
	})

	it("throws on 404", async () => {
		await expect(fetchPage(`${baseURL}/not-found`)).rejects.toThrow("HTTP 404")
	})

	it("throws on 500", async () => {
		await expect(fetchPage(`${baseURL}/server-error`)).rejects.toThrow("HTTP 500")
	})

	it("throws on binary content", async () => {
		await expect(fetchPage(`${baseURL}/binary`)).rejects.toThrow("binary")
	})

	it("throws on timeout", async () => {
		await expect(fetchPage(`${baseURL}/slow?delay=5000`, { timeoutSeconds: 0.5 })).rejects.toThrow(/timed out|Timeout/)
	}, 10_000)
})

describe.skipIf(!hasPlaywrightBrowsers)("integration: Playwright SPA rendering", () => {
	it("renders JavaScript-populated content in SPA page", async () => {
		const result = await fetchPage(`${baseURL}/spa`)
		expect(result.isHTML).toBe(true)
		// Playwright should have executed the JS, so the rendered content should be present
		expect(result.body).toContain("SPA Content Rendered")
		expect(result.body).toContain("This was rendered by JavaScript")
		// The "Loading..." placeholder should have been replaced
		expect(result.body).not.toContain(">Loading...</")
	})

	it("converts SPA content to markdown", async () => {
		const result = await fetchPage(`${baseURL}/spa`)
		const md = convertContent(result.body, result.finalURL, "markdown")

		expect(md).toContain("SPA Content Rendered")
		expect(md).toContain("This was rendered by JavaScript")
	})

	it("extracts SPA text content via format: text", async () => {
		const result = await fetchPage(`${baseURL}/spa`, { format: "text" })

		// Playwright's textContent should capture the JS-rendered text
		expect(result.body).toContain("SPA Content Rendered")
		expect(result.body).toContain("This was rendered by JavaScript")
	})
})

describe("integration: fetchPage + convertContent with format parameter", () => {
	it("returns markdown with boilerplate stripped and URLs resolved", async () => {
		const result = await fetchPage(`${baseURL}/rich`)
		const md = convertContent(result.body, result.finalURL, "markdown")

		// Content is present
		expect(md).toContain("Documentation")
		expect(md).toContain("Getting Started")
		expect(md).toContain("`init()`")
		expect(md).toContain("*important*")
		expect(md).toContain("**bold text**")

		// Code block preserved
		expect(md).toContain("```")
		expect(md).toContain('import { init } from "lib"')

		// Relative URLs resolved to absolute
		expect(md).toContain(`${baseURL}/api/reference`)
		expect(md).toContain(`${baseURL}/images/diagram.png`)

		// Absolute external URLs preserved
		expect(md).toContain("https://external.example.com/guide")

		// Boilerplate stripped
		expect(md).not.toContain("tracking") // script
		expect(md).not.toContain("sans-serif") // style
		expect(md).not.toContain("Copyright") // footer
		expect(md).not.toContain("ads.example.com") // iframe
		expect(md).not.toContain("circle") // svg
		expect(md).not.toContain("Enable JavaScript") // noscript

		// Header and aside preserved
		expect(md).toContain("Header Section")
		expect(md).toContain("sidebar is preserved")
	})

	it("returns plain text with boilerplate stripped", async () => {
		const result = await fetchPage(`${baseURL}/rich`)
		const text = convertContent(result.body, result.finalURL, "text")

		// Content present as plain text
		expect(text).toContain("Documentation")
		expect(text).toContain("Getting Started")
		expect(text).toContain("init()")
		expect(text).toContain("important")

		// No HTML tags
		expect(text).not.toContain("<")
		expect(text).not.toContain(">")

		// Boilerplate stripped
		expect(text).not.toContain("tracking")
		expect(text).not.toContain("Copyright")

		// Preserved sections
		expect(text).toContain("Header Section")
		expect(text).toContain("sidebar is preserved")
	})

	it("returns raw HTML unchanged for html format", async () => {
		const result = await fetchPage(`${baseURL}/rich`)
		const html = convertContent(result.body, result.finalURL, "html")

		// Exact passthrough — content converter returns the HTML it received
		expect(html).toBe(result.body)
	})

	it("does not convert non-HTML content regardless of format", async () => {
		const result = await fetchPage(`${baseURL}/json`)
		expect(result.isHTML).toBe(false)

		// Non-HTML content should be returned as-is regardless of format
		const asMarkdown = result.isHTML ? convertContent(result.body, result.finalURL, "markdown") : result.body
		const asText = result.isHTML ? convertContent(result.body, result.finalURL, "text") : result.body

		expect(asMarkdown).toBe(result.body)
		expect(asText).toBe(result.body)
	})
})

describe("integration: redirect final URL in metadata", () => {
	it("includes Final URL in metadata when redirect occurs", async () => {
		let toolExecute!: (
			id: string,
			params: Record<string, unknown>,
		) => Promise<{ content: { type: string; text: string }[]; details: unknown }>

		const mockPi = {
			registerTool: (tool: { execute: typeof toolExecute }) => {
				toolExecute = tool.execute
			},
			on: () => {},
		} as unknown as ExtensionAPI
		webFetchExtension(mockPi)

		const result = await toolExecute?.("call-1", {
			url: `${baseURL}/redirect`,
			format: "markdown",
		})

		const text = result.content[0].text
		expect(text).toContain(`URL: ${baseURL}/redirect`)
		expect(text).toContain("Final URL:")
		expect(text).toContain("/html")
		expect(text).toContain("Hello World")
	})
})

describe("integration: web_fetch tool handler — timeout and truncation", () => {
	let toolExecute!: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>

	beforeAll(() => {
		const mockPi = {
			registerTool: (tool: { execute: typeof toolExecute }) => {
				toolExecute = tool.execute
			},
			on: () => {},
		} as unknown as ExtensionAPI
		webFetchExtension(mockPi)
	})

	it("respects custom timeout for slow endpoint", async () => {
		const result = await toolExecute("call-1", {
			url: `${baseURL}/slow?delay=5000`,
			timeout: 0.5,
		})

		expect(result.content[0].text).toContain("Error:")
		expect(result.content[0].text).toMatch(/timed out|Timeout/)
	}, 10_000)

	it("succeeds when timeout is long enough for slow endpoint", async () => {
		const result = await toolExecute("call-1", {
			url: `${baseURL}/slow?delay=100`,
			timeout: 10,
		})

		expect(result.content[0].text).toContain("URL:")
		expect(result.content[0].text).toContain("Slow response")
		expect(result.content[0].text).not.toContain("Error:")
	}, 15_000)

	it("truncates large response with notice in metadata", async () => {
		const result = await toolExecute("call-1", {
			url: `${baseURL}/large`,
			format: "markdown",
		})

		const text = result.content[0].text

		// Should have truncation metadata
		expect(text).toContain("Truncated: content truncated to 100,000 of")
		// Should have truncation notice at end
		expect(text).toContain("[Content truncated: showing 100,000 of")
		// Characters count should be the total, not truncated
		expect(text).toMatch(/Characters: \d{3},\d{3}/)
		// Should still contain the beginning of content
		expect(text).toContain("Large Page")
	}, 15_000)

	it("does not truncate responses under 100K characters", async () => {
		const result = await toolExecute("call-1", {
			url: `${baseURL}/html`,
			format: "markdown",
		})

		const text = result.content[0].text

		expect(text).not.toContain("Truncated:")
		expect(text).not.toContain("[Content truncated")
		expect(text).toContain("Hello World")
	})
})

describe("integration: session-scoped cache", () => {
	let toolExecute!: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: { type: string; text: string }[]; details: unknown }>

	beforeAll(() => {
		const mockPi = {
			registerTool: (tool: { execute: typeof toolExecute }) => {
				toolExecute = tool.execute
			},
			on: () => {},
		} as unknown as ExtensionAPI
		webFetchExtension(mockPi)
	})

	beforeEach(() => {
		cacheClear()
	})

	it("second fetch of same URL returns cache hit without re-fetching", async () => {
		const first = await toolExecute("call-1", {
			url: `${baseURL}/html`,
			format: "markdown",
		})
		expect(first.content[0].text).toContain("Cache: miss")

		const second = await toolExecute("call-2", {
			url: `${baseURL}/html`,
			format: "markdown",
		})
		expect(second.content[0].text).toContain("Cache: hit")
		// Content should be the same (minus the cache status which differs only in stored version)
		expect(second.content[0].text).toContain("Hello World")
	})

	it("different formats for same URL are cached separately", async () => {
		await toolExecute("call-1", {
			url: `${baseURL}/html`,
			format: "markdown",
		})

		// Same URL, different format — should be a miss
		const textResult = await toolExecute("call-2", {
			url: `${baseURL}/html`,
			format: "text",
		})
		expect(textResult.content[0].text).toContain("Cache: miss")
		expect(textResult.content[0].text).toContain("Format: text")

		// Now text format should hit
		const textHit = await toolExecute("call-3", {
			url: `${baseURL}/html`,
			format: "text",
		})
		expect(textHit.content[0].text).toContain("Cache: hit")
	})

	it("cache is cleared by cacheClear (session shutdown)", async () => {
		await toolExecute("call-1", {
			url: `${baseURL}/html`,
			format: "markdown",
		})
		expect(cacheSize()).toBeGreaterThan(0)

		cacheClear()
		expect(cacheSize()).toBe(0)

		// After clearing, next fetch should be a miss
		const result = await toolExecute("call-2", {
			url: `${baseURL}/html`,
			format: "markdown",
		})
		expect(result.content[0].text).toContain("Cache: miss")
	})

	it("errors are not cached", async () => {
		await toolExecute("call-1", {
			url: `${baseURL}/not-found`,
			format: "markdown",
		})
		// The 404 should not be cached
		const sizeAfterError = cacheSize()

		const result = await toolExecute("call-2", {
			url: `${baseURL}/not-found`,
			format: "markdown",
		})
		// Still an error, still a miss
		expect(result.content[0].text).toContain("Error:")
		expect(cacheSize()).toBe(sizeAfterError)
	})
})

describe("integration: native fetch fallback when Playwright is unavailable", () => {
	let getBrowserSpy: ReturnType<typeof vi.spyOn>

	beforeAll(() => {
		// Force native fetch path by making getBrowser return null
		getBrowserSpy = vi.spyOn(browserPool, "getBrowser").mockResolvedValue(null)
	})

	afterAll(() => {
		getBrowserSpy.mockRestore()
	})

	it("fetches static HTML via native fetch and includes fallback warning", async () => {
		const result = await fetchPage(`${baseURL}/html`)

		expect(result.statusCode).toBe(200)
		expect(result.isHTML).toBe(true)
		expect(result.body).toContain("Hello World")
		expect(result.fallbackWarning).toBeDefined()
		expect(result.fallbackWarning).toContain("Playwright is not installed")
		expect(result.fallbackWarning).toContain("npx playwright install chromium")
	})

	it("fallback warning appears in tool handler metadata", async () => {
		let toolExecute!: (
			id: string,
			params: Record<string, unknown>,
		) => Promise<{ content: { type: string; text: string }[]; details: unknown }>

		const mockPi = {
			registerTool: (tool: { execute: typeof toolExecute }) => {
				toolExecute = tool.execute
			},
			on: () => {},
		} as unknown as ExtensionAPI
		webFetchExtension(mockPi)

		const result = await toolExecute?.("call-1", {
			url: `${baseURL}/html`,
			format: "markdown",
		})

		const text = result.content[0].text
		expect(text).toContain("Playwright is not installed")
		expect(text).toContain("npx playwright install chromium")
		expect(text).toContain("Hello World")
	})

	it("does not render SPA JavaScript content via native fetch", async () => {
		const result = await fetchPage(`${baseURL}/spa`)
		expect(result.isHTML).toBe(true)
		// Native fetch returns raw HTML — JS is not executed, so the placeholder
		// is still inside the app div (Playwright would have replaced it).
		expect(result.body).toContain(">Loading...</div>")
		// The script source is present but was never executed
		expect(result.body).toContain("<script>")
		expect(result.fallbackWarning).toBeDefined()
	})

	it("follows redirects via native fetch", async () => {
		const result = await fetchPage(`${baseURL}/redirect`)
		expect(result.finalURL).toContain("/html")
		expect(result.body).toContain("Hello World")
		expect(result.fallbackWarning).toBeDefined()
	})
})
