import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.js"

const templateDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../resources/oauth")

// The Kimchi logo SVG in both templates uses this exact orange — proof the
// branded template rendered rather than the unbranded fallback.
const KIMCHI_LOGO_ORANGE = "#FF521D"

beforeEach(() => {
	vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", templateDir)
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("oauthSuccessHtml", () => {
	it("applies title/heading overrides on the branded page", () => {
		const html = oauthSuccessHtml("You can close this window and return to Kimchi.", {
			title: "MCP Authorization Successful",
			heading: "MCP Authorization Successful",
		})

		expect(html).toContain(KIMCHI_LOGO_ORANGE)
		expect(html).toContain("<title>MCP Authorization Successful</title>")
		expect(html).toContain("<h1>MCP Authorization Successful</h1>")
		expect(html).toContain("You can close this window and return to Kimchi.")
	})

	it("keeps the default authentication wording without overrides", () => {
		const html = oauthSuccessHtml("done")

		expect(html).toContain("<title>Authentication successful</title>")
		expect(html).toContain("<h1>Authentication successful</h1>")
	})
})

describe("oauthErrorHtml", () => {
	it("applies overrides and HTML-escapes the details", () => {
		const html = oauthErrorHtml("An error occurred during MCP authorization.", "<script>alert(1)</script>", {
			title: "MCP Authorization Failed",
			heading: "MCP Authorization Failed",
		})

		expect(html).toContain("<title>MCP Authorization Failed</title>")
		expect(html).toContain("An error occurred during MCP authorization.")
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
		expect(html).not.toContain("<script>alert(1)</script>")
	})

	it("keeps the default authentication wording without overrides", () => {
		const html = oauthErrorHtml("nope")

		expect(html).toContain("<title>Authentication failed</title>")
	})
})

describe("unbranded fallback", () => {
	it("applies overrides when the template dir is not configured", () => {
		vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", "")

		const html = oauthSuccessHtml("msg", {
			title: "MCP Authorization Successful",
			heading: "MCP Authorization Successful",
		})

		expect(html).toContain("<title>MCP Authorization Successful</title>")
		expect(html).not.toContain(KIMCHI_LOGO_ORANGE)
	})
})
