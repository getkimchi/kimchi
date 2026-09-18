import { ServerResponse } from "node:http"
import type { AgentToolResult, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.js"

const ADAPTER_PAGE_MARKER = '<main class="card">'
const KIMCHI_APP_MARKER = '<span class="app">kimchi</span>'
const SUCCESS_HEADING = "<h1>Authorization Successful</h1>"
const MANUAL_SUCCESS_HEADING = "<h1>Authorization Received</h1>"
const ERROR_HEADING = "<h1>Authorization Failed</h1>"
const AUTO_CLOSE_SCRIPT = "<script>setTimeout(() => window.close(), 2000);</script>"
const INSTALL_MARKER = Symbol.for("kimchi.mcp.oauth-callback-branding")

const ADAPTER_TEXT_REPLACEMENTS = [
	["Non-MCP Pi tools", "Non-MCP Kimchi tools"],
	["No Pi model is available", "No Kimchi model is available"],
	["interactive Pi session", "interactive Kimchi session"],
	["native Pi tool", "native Kimchi tool"],
	["Pi extension UI", "Kimchi MCP UI"],
	["Pi-owned", "Kimchi-owned"],
	["Pi agent dir", "Kimchi agent dir"],
	["Pi global override", "Kimchi global override"],
	["project Pi override", "project Kimchi override"],
	["reload Pi", "reload Kimchi"],
	["Pi will reload", "Kimchi will reload"],
	["Pi should import", "Kimchi should import"],
	["Pi found", "Kimchi found"],
	["active in Pi", "active in Kimchi"],
	["into Pi", "into Kimchi"],
	["where Pi writes", "where Kimchi writes"],
	["Pi only writes", "Kimchi only writes"],
	["Pi writes", "Kimchi writes"],
	["shown by Pi", "shown by Kimchi"],
	["return to Pi", "return to Kimchi"],
	["Start Pi", "Start Kimchi"],
] as const

const BRANDED_ADAPTER_RESULT_ERRORS = new Set(["input_required_needs_ui", "native_tool"])

const SUCCESS_PAGE = { title: "MCP Authorization Successful", heading: "MCP Authorization Successful" }
const MANUAL_SUCCESS_PAGE = { title: "MCP Authorization Received", heading: "MCP Authorization Received" }
const ERROR_PAGE = { title: "MCP Authorization Failed", heading: "MCP Authorization Failed" }

function isKimchiAdapterPage(html: string): boolean {
	return html.includes(ADAPTER_PAGE_MARKER) && html.includes(KIMCHI_APP_MARKER)
}

function decodeAdapterHtml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
}

function preserveAutoClose(html: string, brandedHtml: string): string {
	if (!html.includes(AUTO_CLOSE_SCRIPT)) return brandedHtml
	return brandedHtml.replace("</body>", `  ${AUTO_CLOSE_SCRIPT}\n</body>`)
}

/** Replace only product-owned phrases emitted by pi-mcp-adapter. */
export function brandMcpAdapterText(text: string): string {
	let branded = text
	for (const [upstream, kimchi] of ADAPTER_TEXT_REPLACEMENTS) branded = branded.replaceAll(upstream, kimchi)
	return branded
}

/** Brand only results positively identified as adapter-owned, never MCP server content. */
export function brandMcpAdapterOwnedToolResult<TDetails>(result: AgentToolResult<TDetails>): AgentToolResult<TDetails> {
	const details = result.details
	if (
		typeof details !== "object" ||
		details === null ||
		!("error" in details) ||
		typeof details.error !== "string" ||
		!BRANDED_ADAPTER_RESULT_ERRORS.has(details.error)
	) {
		return result
	}
	return {
		...result,
		content: result.content.map((block) =>
			block.type === "text" ? { ...block, text: brandMcpAdapterText(block.text) } : block,
		),
	}
}

/**
 * Replace only the self-contained callback pages emitted by the pinned
 * pi-mcp-adapter. OAuth state validation and callback lifecycle remain owned by
 * the adapter; Kimchi owns the browser-facing brand contract.
 */
export function brandMcpOAuthCallbackHtml(html: string): string {
	if (!isKimchiAdapterPage(html)) return html

	if (html.includes(SUCCESS_HEADING)) {
		return preserveAutoClose(html, oauthSuccessHtml("You can close this window and return to Kimchi.", SUCCESS_PAGE))
	}

	if (html.includes(MANUAL_SUCCESS_HEADING)) {
		return oauthSuccessHtml(
			"Copy the full callback URL from your browser address bar and paste it back into Kimchi with auth-complete.",
			MANUAL_SUCCESS_PAGE,
		)
	}

	if (html.includes(ERROR_HEADING)) {
		const details = /<code>([\s\S]*?)<\/code>/.exec(html)?.[1]
		return oauthErrorHtml(
			"An error occurred during MCP authorization.",
			details === undefined ? undefined : decodeAdapterHtml(details),
			ERROR_PAGE,
		)
	}

	return html
}

/** Brand the two other adapter-owned browser documents without touching MCP App content. */
export function brandMcpBrowserHtml(html: string): string {
	const callbackHtml = brandMcpOAuthCallbackHtml(html)
	if (callbackHtml !== html) return callbackHtml
	if (
		(html.includes("<title>MCP UI</title>") && html.includes("Open the authenticated MCP UI URL shown by Pi.")) ||
		(html.includes('id="completion-overlay"') && html.includes("return to Pi."))
	) {
		return brandMcpAdapterText(html)
	}
	return html
}

function brandedChunk(chunk: unknown): unknown {
	if (typeof chunk === "string") return brandMcpBrowserHtml(chunk)
	if (!Buffer.isBuffer(chunk)) return chunk
	const html = chunk.toString("utf8")
	const brandedHtml = brandMcpBrowserHtml(html)
	return brandedHtml === html ? chunk : Buffer.from(brandedHtml, "utf8")
}

function isRenderableComponent(value: unknown): value is Pick<Component, "render"> {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function"
}

function brandComponent(component: unknown): unknown {
	if (!isRenderableComponent(component)) return component
	return new Proxy(component, {
		get(target, property, receiver) {
			if (property === "render") {
				return (width: number): string[] => target.render(width).map(brandMcpAdapterText)
			}
			const value = Reflect.get(target, property, receiver)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

function createBrandedMcpUi(ui: ExtensionUIContext): ExtensionUIContext {
	return new Proxy(ui, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver)
			if (typeof value !== "function") return value
			if (property === "custom") {
				return (factory: (...args: unknown[]) => unknown, options?: unknown) =>
					Reflect.apply(value, target, [
						async (...args: unknown[]) => brandComponent(await Reflect.apply(factory, undefined, args)),
						options,
					])
			}
			if (property === "notify" || property === "select" || property === "confirm" || property === "input") {
				return (...args: unknown[]) => {
					const brandedArgs = args.map((arg) =>
						typeof arg === "string"
							? brandMcpAdapterText(arg)
							: Array.isArray(arg)
								? arg.map((entry) => (typeof entry === "string" ? brandMcpAdapterText(entry) : entry))
								: arg,
					)
					return Reflect.apply(value, target, brandedArgs)
				}
			}
			return value.bind(target)
		},
	})
}

/** Brand adapter command UI while leaving the rest of the session context intact. */
export function createBrandedMcpContext<T extends ExtensionContext>(ctx: T): T {
	const brandedUi = createBrandedMcpUi(ctx.ui)
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "ui") return brandedUi
			const value = Reflect.get(target, property, receiver)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

/**
 * The adapter has no public callback-page renderer hook. Decorate its exact
 * localhost HTML response until one exists, without importing private package
 * modules or restoring the vendored OAuth server.
 */
export function installMcpOAuthCallbackBranding(): void {
	const prototype = ServerResponse.prototype
	if (Object.hasOwn(prototype, INSTALL_MARKER)) return

	const originalEnd = prototype.end
	Object.defineProperty(prototype, INSTALL_MARKER, { value: true })
	Object.defineProperty(prototype, "end", {
		configurable: true,
		writable: true,
		value: function brandedEnd(this: ServerResponse, ...args: unknown[]): ServerResponse {
			if (args.length > 0) {
				const originalChunk = args[0]
				const replacement = brandedChunk(originalChunk)
				const hasSentContentLength = this.headersSent && this.getHeader("content-length") !== undefined
				if (replacement !== originalChunk && !hasSentContentLength) {
					args[0] = replacement
					if (!this.headersSent) this.removeHeader("content-length")
				}
			}
			Reflect.apply(originalEnd, this, args)
			return this
		},
	})
}
