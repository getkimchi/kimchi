import { createServer } from "node:http"
import { resolve } from "node:path"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import {
	brandMcpAdapterOwnedToolResult,
	brandMcpAdapterText,
	brandMcpBrowserHtml,
	brandMcpOAuthCallbackHtml,
	createBrandedMcpContext,
	installMcpOAuthCallbackBranding,
} from "./oauth-callback-branding.js"

const templateDir = resolve(import.meta.dirname, "../../../resources/oauth")

function adapterPage(heading: string, extra = "", autoClose = false): string {
	return `<!DOCTYPE html><html><body><main class="card"><div class="badge ok"></div><h1>${heading}</h1><p>Return to <span class="app">kimchi</span>.</p>${extra}</main>${
		autoClose ? "<script>setTimeout(() => window.close(), 2000);</script>" : ""
	}</body></html>`
}

describe("MCP OAuth callback branding", () => {
	beforeEach(() => vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", templateDir))
	afterEach(() => vi.unstubAllEnvs())

	it("restores the Kimchi success page and keeps the adapter auto-close behavior", () => {
		const html = brandMcpOAuthCallbackHtml(adapterPage("Authorization Successful", "", true))

		expect(html).toContain('class="bg-svg"')
		expect(html).toContain('fill="#FF521D"')
		expect(html).toContain("<title>MCP Authorization Successful</title>")
		expect(html).toContain("<h1>MCP Authorization Successful</h1>")
		expect(html).toContain("You can close this window and return to Kimchi.")
		expect(html).toContain("setTimeout(() => window.close(), 2000)")
		expect(html).not.toContain('class="badge ok"')
	})

	it("restores the Kimchi error page and safely carries provider details across", () => {
		const html = brandMcpOAuthCallbackHtml(
			adapterPage(
				"Authorization Failed",
				"<code>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; denied</code>",
			),
		)

		expect(html).toContain('class="bg-svg"')
		expect(html).toContain("<title>MCP Authorization Failed</title>")
		expect(html).toContain("An error occurred during MCP authorization.")
		expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; denied")
		expect(html).not.toContain('<script>alert("x")</script>')
	})

	it("brands the adapter manual-completion page without losing its instructions", () => {
		const html = brandMcpOAuthCallbackHtml(adapterPage("Authorization Received"))

		expect(html).toContain("<title>MCP Authorization Received</title>")
		expect(html).toContain("paste it back into Kimchi with auth-complete")
		expect(html).toContain('fill="#FF521D"')
	})

	it("leaves unrelated HTTP pages untouched", () => {
		const html = '<main class="card"><h1>Authorization Successful</h1><p>Another application</p></main>'

		expect(brandMcpOAuthCallbackHtml(html)).toBe(html)
	})

	it("brands adapter-owned MCP App browser pages", () => {
		const unauthenticated =
			"<!doctype html><html><head><title>MCP UI</title></head><body><p>Open the authenticated MCP UI URL shown by Pi.</p></body></html>"
		const completed =
			'<div class="overlay" id="completion-overlay"><p>MCP UI session finished. You can close this page and return to Pi.</p></div>'

		expect(brandMcpBrowserHtml(unauthenticated)).toContain("shown by Kimchi")
		expect(brandMcpBrowserHtml(completed)).toContain("return to Kimchi")
	})

	it("brands known adapter UI phrases without broad product-name replacement", () => {
		expect(brandMcpAdapterText("Pi-owned files; reload Pi; server named Pi remains available")).toBe(
			"Kimchi-owned files; reload Kimchi; server named Pi remains available",
		)
	})

	it("brands adapter-owned tool errors without rewriting MCP server results", () => {
		const adapterResult = brandMcpAdapterOwnedToolResult({
			content: [{ type: "text", text: '"read" is a native Pi tool.' }],
			details: { error: "native_tool" },
		})
		const serverResult = brandMcpAdapterOwnedToolResult({
			content: [{ type: "text", text: "A server-owned Pi migration guide" }],
			details: { error: "tool_error" },
		})

		expect(adapterResult.content).toEqual([{ type: "text", text: '"read" is a native Kimchi tool.' }])
		expect(serverResult.content).toEqual([{ type: "text", text: "A server-owned Pi migration guide" }])
	})

	it("brands command notifications and custom component rendering", async () => {
		const rendered = { render: () => ["Pi found setup; return to Pi"], invalidate() {} }
		const custom = vi.fn(async (factory: (...args: unknown[]) => unknown) =>
			factory(),
		) as unknown as ExtensionUIContext["custom"]
		const notify = vi.fn()
		const ctx = createContext({ ui: { custom, notify } })
		const branded = createBrandedMcpContext(ctx)

		branded.ui.notify("Pi-owned configuration", "info")
		const component = (await branded.ui.custom(() => rendered)) as typeof rendered

		expect(notify).toHaveBeenCalledWith("Kimchi-owned configuration", "info")
		expect(component.render()).toEqual(["Kimchi found setup; return to Kimchi"])
	})

	it("decorates an adapter response after it has sent its HTTP headers", async () => {
		installMcpOAuthCallbackBranding()
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" })
			response.end(adapterPage("Authorization Successful", "", true))
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", resolve)
		})

		try {
			const address = server.address()
			if (!address || typeof address === "string") throw new Error("OAuth branding test server did not bind")
			const response = await fetch(`http://127.0.0.1:${address.port}`)
			const html = await response.text()

			expect(response.status).toBe(200)
			expect(html).toContain('fill="#FF521D"')
			expect(html).toContain("<title>MCP Authorization Successful</title>")
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		}
	})
})
