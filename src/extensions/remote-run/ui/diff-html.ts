/**
 * Self-contained browser diff viewer: the patch is emb+edded into ONE html
 * file together with the diff2html CSS + UI JS (both inlined at build time —
 * the file opens fully offline, no CDN). Side-by-side rendering, per-file
 * collapse and a file list with anchor navigation — the closest local
 * equivalent of GitHub's Files view, with zero reliance on what editors a
 * user has installed.
 *
 * Assets embed pattern: `with { type: "text" }` — bundled by Bun during
 * compile, inlined as string constants (same pattern as behaviours bodies).
 */

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
// Asset integrity: these inline paths pin the vendored diff2html bundles —
// if the package layout changes, the build fails loudly here, not at runtime.
import diff2htmlCss from "../../../../node_modules/diff2html/bundles/css/diff2html.min.css" with { type: "text" }
import diff2htmlUiJs from "../../../../node_modules/diff2html/bundles/js/diff2html-ui.min.js" with { type: "text" }

/** JSON.stringify'd content must not terminate an enclosing <script>. */
function scriptSafeJson(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c")
}

export function buildDiffHtmlDocument(opts: { title: string; subtitle?: string; patch: string }): string {
	const { title, subtitle, patch } = opts
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
.kimchi-header { padding: 12px 20px; border-bottom: 1px solid #30363d; background: #161b22; position: sticky; top: 0; z-index: 1; }
.kimchi-header h1 { font-size: 15px; margin: 0; font-weight: 600; }
.kimchi-header .kimchi-stat { font-size: 13px; color: #8b949e; margin-top: 2px; }
#diff { padding: 12px 20px 40px; }
${diff2htmlCss}
</style>
</head>
<body>
<div class="kimchi-header">
<h1>${title.replace(/</g, "&lt;")}</h1>
${subtitle ? `<div class="kimchi-stat">${subtitle.replace(/</g, "&lt;")}</div>` : ""}
</div>
<div id="diff"></div>
<script id="diff-patch" type="application/json">${scriptSafeJson(patch)}</script>
<script>${diff2htmlUiJs}</script>
<script>
var patch = JSON.parse(document.getElementById("diff-patch").textContent);
var target = document.getElementById("diff");
var config = {
  inputFormat: "diff",
  showFiles: true,
  matching: "lines",
  outputFormat: "side-by-side",
  synchronisedScroll: false,
  pagePagination: { enabled: false },
};
try {
  var ui = new Diff2HtmlUI(target, patch, config);
  ui.draw();
} catch (err) {
  var pre = document.createElement("pre");
  pre.textContent = String(patch);
  target.innerHTML = "";
  target.appendChild(pre);
}
</script>
</body>
</html>
`
}

/**
 * Writes remote-diff.html next to the given patch file. Returns the path.
 */
export function writeDiffHtmlFile(
	patchPath: string,
	opts: { title: string; subtitle?: string; patch: string },
): string {
	const htmlPath = join(dirname(patchPath), "remote-diff.html")
	writeFileSync(htmlPath, buildDiffHtmlDocument(opts), "utf-8")
	return htmlPath
}
