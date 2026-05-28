#!/usr/bin/env node
/**
 * Post-install patch for @earendil-works/pi-ai OAuth pages.
 *
 * Replaces the hardcoded Pi logo and HTML templates in pi-ai's oauth-page.js
 * with a version that reads custom templates from KIMCHI_OAUTH_TEMPLATE_DIR.
 *
 * This avoids pnpm patch fragility for multi-line template changes.
 * Remove when upstream supports configurable OAuth page templates.
 *
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
const LOGO_SVG = \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>\`;
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
            // fall through to default template
        }
    }
    const title = escapeHtml(options.title);
    const heading = escapeHtml(options.heading);
    const message = escapeHtml(options.message);
    const details = options.details ? escapeHtml(options.details) : undefined;
    return \`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>\${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">\${LOGO_SVG}</div>
    <h1>\${heading}</h1>
    <p>\${message}</p>
    \${details ? \`<div class="details">\${details}</div>\` : ""}
  </main>
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
	console.warn("[patch-pi-ai-oauth] Could not patch file:", err instanceof Error ? err.message : String(err))
}
