// Branded OAuth callback pages for the Kimchi-account browser login.
//
// This mirrors the renderer that `scripts/patch-pi-ai-oauth.js` injects into
// pi-ai's `oauth-page.js`: both read the SAME templates from
// `KIMCHI_OAUTH_TEMPLATE_DIR` (resources/oauth/{success,error}.html, set in
// entry.ts) and substitute the same `{{TITLE}}/{{HEADING}}/{{MESSAGE}}/{{DETAILS}}`
// placeholders. We re-implement the ~20 lines here because pi-ai does not export
// `oauth-page.js` (its package `exports` map blocks the deep import), but by
// sharing the template files the Kimchi-account login and pi's subscription
// providers serve identical branded pages, and designer edits propagate to both.
//
// If the env var is missing or the template can't be read we fall through to a
// minimal *unbranded* page, deliberately not a Kimchi- or Pi-branded fallback,
// matching the patch's behavior (the token is already saved by the time this
// renders, so a degraded page beats blanking the user mid-flow).

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

interface PageOptions {
	title: string
	heading: string
	message: string
	details?: string
	template: "success" | "error"
}

function renderPage(options: PageOptions): string {
	const templateDir = process.env.KIMCHI_OAUTH_TEMPLATE_DIR
	if (templateDir) {
		try {
			const html = readFileSync(resolve(templateDir, `${options.template}.html`), "utf-8")
			return html
				.replaceAll("{{TITLE}}", escapeHtml(options.title))
				.replaceAll("{{HEADING}}", escapeHtml(options.heading))
				.replaceAll("{{MESSAGE}}", escapeHtml(options.message))
				.replaceAll("{{DETAILS}}", options.details ? `<div class="details">${escapeHtml(options.details)}</div>` : "")
		} catch {
			// fall through to minimal unbranded fallback
		}
	}

	const title = escapeHtml(options.title)
	const heading = escapeHtml(options.heading)
	const message = escapeHtml(options.message)
	const details = options.details ? escapeHtml(options.details) : undefined
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 48px auto; padding: 24px; line-height: 1.5; color: #111; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { margin: 0 0 12px; color: #555; }
    .details { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f5f5f5; padding: 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  <p>${message}</p>
  ${details ? `<div class="details">${details}</div>` : ""}
</body>
</html>`
}

export function oauthSuccessHtml(message: string): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
		template: "success",
	})
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
		template: "error",
	})
}
