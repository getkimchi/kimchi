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

	it("brands the inactive-callback page as an error rather than a success or CSRF failure", () => {
		const html = brandMcpOAuthCallbackHtml(adapterPage("Authorization No Longer Active"))

		expect(html).toContain('class="bg-svg"')
		expect(html).toContain("<title>MCP Authorization No Longer Active</title>")
		expect(html).toContain("<h1>MCP Authorization No Longer Active</h1>")
		expect(html).toContain("This authorization link is no longer valid.")
		expect(html).toContain("start authorization again from Kimchi")
		// Error-template accent color; the success template never uses it.
		expect(html).toContain("#ef4444")
		expect(html).not.toContain("MCP Authorization Successful")
		expect(html).not.toContain("MCP Authorization Failed")
		expect(html).not.toContain("CSRF")
		expect(html).not.toContain("window.close")
		expect(html).not.toContain('class="badge ok"')
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
		expect(brandMcpAdapterText("Ignored Pi mcp.json settings: keywords")).toBe(
			"Ignored Kimchi mcp.json settings: keywords",
		)
		expect(brandMcpAdapterText("import sign-ins from Pi")).toBe("import sign-ins from Kimchi")
		expect(brandMcpAdapterText("MCP runtime tool calls require an active Pi session")).toBe(
			"MCP runtime tool calls require an active Kimchi session",
		)
	})

	it("brands every audited v5 panel and notice phrase", () => {
		expect(brandMcpAdapterText("No sign-ins from Pi left to import.")).toBe("No sign-ins from Kimchi left to import.")
		expect(brandMcpAdapterText("Failed to import the sign-in from Pi for linear: boom")).toBe(
			"Failed to import the sign-in from Kimchi for linear: boom",
		)
		expect(brandMcpAdapterText('server "linear" signs in with Pi: run /login linear')).toBe(
			'server "linear" signs in with Kimchi: run /login linear',
		)
		expect(
			brandMcpAdapterText(
				"Turned off Pi's built-in MCP so it doesn't run next to pi-mcp-adapter. If you remove the adapter, turn it back on in `pi config` → Built-in.",
			),
		).toBe(
			"Turned off Kimchi's built-in MCP so it doesn't run next to pi-mcp-adapter. If you remove the adapter, turn it back on by removing `-builtin:mcp` from the extensions list in your settings file.",
		)
		expect(
			brandMcpAdapterText(
				'MCP server "x": auth.provider isn\'t available here; it needs a Pi session whose model registry provides provider tokens (Pi 0.99.2 or later)',
			),
		).toBe(
			'MCP server "x": auth.provider isn\'t available here; it needs a Kimchi session whose model registry provides provider tokens',
		)
		expect(
			brandMcpAdapterText(
				"Local Network for the app hosting Pi; enable access if listed and restart it. Try launching Pi from Terminal.app or SSH.",
			),
		).toBe(
			"Local Network for the app hosting Kimchi; enable access if listed and restart it. Try launching Kimchi from Terminal.app or SSH.",
		)
		expect(brandMcpAdapterText("user Pi settings /tmp/x malformed")).toBe("user harness settings /tmp/x malformed")
		expect(brandMcpAdapterText("Pi package acme ignores invalid pi.mcp manifest entry")).toBe(
			"Kimchi package acme ignores invalid pi.mcp manifest entry",
		)
		expect(brandMcpAdapterText('Pi provider "linear" returned a bad token')).toBe(
			'Kimchi provider "linear" returned a bad token',
		)
		expect(brandMcpAdapterText("pi-mcp-adapter is not installed for this Pi instance")).toBe(
			"pi-mcp-adapter is not installed for this Kimchi instance",
		)
		expect(
			brandMcpAdapterText(
				"Figma's remote MCP server only accepts approved clients, and Pi isn't approved yet. Use the Figma desktop app's local server instead: run /mcp-adapter setup.",
			),
		).toBe(
			"Figma's remote MCP server only accepts approved clients, and Kimchi isn't approved yet. Use the Figma desktop app's local server with a localhost entry in .mcp.json instead.",
		)
		expect(brandMcpAdapterText("user-global Pi MCP; project Pi MCP; Kimchi mcp.json")).toBe(
			"user-global Kimchi MCP; project Kimchi MCP; Kimchi mcp.json",
		)
		expect(brandMcpAdapterText("Pi exclusive config")).toBe("Kimchi exclusive config")
		expect(brandMcpAdapterText("Pi project mcp.json")).toBe("Kimchi project mcp.json")
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
