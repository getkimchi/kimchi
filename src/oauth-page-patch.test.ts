import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const patchedFile = resolve(projectRoot, "node_modules/@earendil-works/pi-ai/dist/utils/oauth/oauth-page.js")
const patchedFileUrl = pathToFileURL(patchedFile).href
const templateDir = resolve(projectRoot, "resources/oauth")

// The Kimchi logo SVG in both templates uses this exact orange — distinct from
// upstream's Pi-branded white-on-transparent logo. Asserting the rendered HTML
// contains it catches both "patch didn't run" (still upstream's renderer) and
// "templates can't be read" (any silent fallback we might reintroduce).
const KIMCHI_LOGO_ORANGE = "#FF521D"

it("scripts/patch-pi-ai-oauth.js has been applied to node_modules", () => {
	const source = readFileSync(patchedFile, "utf-8")
	expect(source, "Run `pnpm install` (or `node scripts/patch-pi-ai-oauth.js`) first").toContain(
		"KIMCHI_OAUTH_TEMPLATE_DIR",
	)
})

let originalTemplateDir: string | undefined

beforeEach(() => {
	originalTemplateDir = process.env.KIMCHI_OAUTH_TEMPLATE_DIR
	process.env.KIMCHI_OAUTH_TEMPLATE_DIR = templateDir
})

afterEach(() => {
	if (originalTemplateDir === undefined) {
		// biome-ignore lint/performance/noDelete: process.env requires delete operator to truly unset
		delete process.env.KIMCHI_OAUTH_TEMPLATE_DIR
	} else {
		process.env.KIMCHI_OAUTH_TEMPLATE_DIR = originalTemplateDir
	}
})

it("renders the Kimchi-branded success page with substitutions", async () => {
	const { oauthSuccessHtml } = await import(/* @vite-ignore */ patchedFileUrl)

	const html = oauthSuccessHtml("You can close this window.")

	expect(html).toContain(KIMCHI_LOGO_ORANGE)
	expect(html).toContain("You can close this window.")
	expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/)
	expect(html).not.toContain('class="details"')
})

it("renders the Kimchi-branded error page with escaped details", async () => {
	const { oauthErrorHtml } = await import(/* @vite-ignore */ patchedFileUrl)

	const html = oauthErrorHtml("Token exchange failed.", "<script>alert(1)</script>")

	expect(html).toContain(KIMCHI_LOGO_ORANGE)
	expect(html).toContain("Token exchange failed.")
	expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
	expect(html).not.toContain("<script>alert(1)</script>")
	expect(html).toContain('class="details"')
	expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/)
})

it("omits the details block when no details are provided", async () => {
	const { oauthErrorHtml } = await import(/* @vite-ignore */ patchedFileUrl)

	const html = oauthErrorHtml("Missing authorization code.")

	expect(html).not.toContain('class="details"')
})

it("falls back to a minimal unbranded page when the template dir is unreadable", async () => {
	process.env.KIMCHI_OAUTH_TEMPLATE_DIR = resolve(projectRoot, "this/path/does/not/exist")
	const { oauthSuccessHtml } = await import(/* @vite-ignore */ patchedFileUrl)

	const html = oauthSuccessHtml("You can close this window.")

	expect(html).toContain("You can close this window.")
	expect(html).toContain("Authentication successful")
	// Fallback must not silently misbrand as Kimchi (orange marker) or Pi
	// (the upstream LOGO_SVG path that the original fallback shipped).
	expect(html).not.toContain(KIMCHI_LOGO_ORANGE)
	expect(html).not.toContain("M165.29 165.29")
})
