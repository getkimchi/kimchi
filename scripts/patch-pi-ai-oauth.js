#!/usr/bin/env node
/**
 * Post-install patch for @earendil-works/pi-ai OAuth pages.
 *
 * Replaces the hardcoded Pi-branded HTML in pi-ai's oauth-page.js with a
 * renderer that reads Kimchi templates from KIMCHI_OAUTH_TEMPLATE_DIR.
 * The templates themselves live in resources/oauth/ — designers iterate
 * on them without touching node_modules or refreshing this patch.
 *
 * If the env var is missing or the template can't be read, the renderer
 * falls through to a minimal unbranded HTML fallback. We deliberately avoid
 * upstream's Pi-branded fallback (kimchi shipping competitor branding is the
 * exact failure mode this patch exists to eliminate), and we avoid throwing
 * (the token is already saved by the time the renderer is called — blank-
 * paging the user mid-flow is worse UX than a degraded-looking page).
 *
 * Remove when upstream supports configurable OAuth page templates.
 * Tracking: TODO - open upstream issue against pi-mono for OAuth page customization.
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const target = join(
	process.cwd(),
	"node_modules",
	"@earendil-works",
	"pi-ai",
	"dist",
	"utils",
	"oauth",
	"oauth-page.js",
)

const patched = `import { readFileSync } from "node:fs";
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function renderPage(options) {
    const templateDir = process.env.KIMCHI_OAUTH_TEMPLATE_DIR;
    if (templateDir) {
        try {
            const filePath = templateDir + "/" + (options.template || "default") + ".html";
            let html = readFileSync(filePath, "utf-8");
            html = html.replaceAll("{{TITLE}}", escapeHtml(options.title || ""));
            html = html.replaceAll("{{HEADING}}", escapeHtml(options.heading || ""));
            html = html.replaceAll("{{MESSAGE}}", escapeHtml(options.message || ""));
            html = html.replaceAll("{{DETAILS}}", options.details ? \`<div class="details">\${escapeHtml(options.details)}</div>\` : "");
            return html;
        }
        catch {
            // fall through to minimal unbranded fallback
        }
    }
    const title = escapeHtml(options.title || "");
    const heading = escapeHtml(options.heading || "");
    const message = escapeHtml(options.message || "");
    const details = options.details ? escapeHtml(options.details) : undefined;
    return \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>\${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 48px auto; padding: 24px; line-height: 1.5; color: #111; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { margin: 0 0 12px; color: #555; }
    .details { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; background: #f5f5f5; padding: 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>\${heading}</h1>
  <p>\${message}</p>
  \${details ? \`<div class="details">\${details}</div>\` : ""}
</body>
</html>\`;
}
export function oauthSuccessHtml(message) {
    return renderPage({
        title: "Authentication successful",
        heading: "Authentication successful",
        message,
        template: "success",
    });
}
export function oauthErrorHtml(message, details) {
    return renderPage({
        title: "Authentication failed",
        heading: "Authentication failed",
        message,
        details,
        template: "error",
    });
}
//# sourceMappingURL=oauth-page.js.map
`

try {
	writeFileSync(target, patched)
	console.log("[patch-pi-ai-oauth] Patched pi-ai OAuth page templates.")
} catch (err) {
	console.error("[patch-pi-ai-oauth] Could not patch file:", err instanceof Error ? err.message : String(err))
	process.exit(1)
}
