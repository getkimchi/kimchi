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

const INTERACTIVE_CSS = `
/* Palette + shapes inspired by plannotator's review UI (packages/review-editor): */
:root {
--kr-bg: #f6f8fa; --kr-panel: #ffffff; --kr-border: #d1d9e0; --kr-fg: #1f2328;
--kr-muted: #59636e; --kr-primary: #0969da; --kr-primary-tint: rgba(9,105,218,0.07);
--kr-approve: #1f883d; --kr-danger: #cf222e; --kr-radius: 8px;
--kr-shadow: 0 8px 24px rgba(140,149,159,0.2);
}
.kimchi-header { display: flex; align-items: center; gap: 16px; }
.kimchi-header h1 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Segmented decision group, plannotator-dock style */
#kimchi-actions { display: flex; gap: 0; background: #eaeef2; border-radius: 10px; padding: 3px; flex-shrink: 0; }
#kimchi-actions button { border: 0; border-radius: var(--kr-radius); padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; background: transparent; color: var(--kr-fg); white-space: nowrap; }
#kimchi-actions button:hover:not(:disabled) { background: #ffffff; box-shadow: 0 1px 3px rgba(140,149,159,0.25); }
#kimchi-actions button.primary { color: var(--kr-approve); }
#kimchi-actions button.request { color: var(--kr-danger); }
#kimchi-actions button:disabled { opacity: 0.5; cursor: default; }
@media (max-width: 900px) { #kimchi-actions button { font-size: 12px; padding: 6px 8px; } }
/* Comments panel card */
#kr-comment-panel { position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 50vh; overflow: auto; background: var(--kr-panel); border: 1px solid var(--kr-border); border-radius: 10px; box-shadow: var(--kr-shadow); padding: 10px 12px; font-size: 13px; display: none; z-index: 10; }
#kr-comment-panel.visible { display: block; }
#kr-comment-panel h2 { font-size: 13px; margin: 0 0 6px; display: flex; align-items: center; gap: 6px; }
#kr-count { background: #eaeef2; border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--kr-muted); }
.kr-comment { border-top: 1px solid var(--kr-border); padding: 6px 0; }
.kr-comment:first-of-type { border-top: 0; }
.kr-comment .kr-anchor { color: var(--kr-primary); word-break: break-all; }
.kr-comment .kr-code { color: var(--kr-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; border-left: 2px solid var(--kr-border); padding-left: 6px; margin: 3px 0; }
.kr-comment .kr-remove { float: right; color: var(--kr-danger); cursor: pointer; border: 0; background: none; padding: 0; font-size: 12px; }
#kr-summary { width: 100%; box-sizing: border-box; margin-top: 8px; min-height: 48px; font: inherit; border: 1px solid var(--kr-border); border-radius: var(--kr-radius); padding: 6px; }
/* Commented row: inset left primary border + tint (plannotator's selected-annotation marker) */
tr.kr-has-comment td { background: var(--kr-primary-tint) !important; box-shadow: inset 3px 0 0 var(--kr-primary); }
#kr-done { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: var(--kr-panel); color: var(--kr-fg); z-index: 100; font-size: 15px; text-align: center; }
#kr-done.visible { display: flex; }
`

/** Client-side review JS: click lines to comment, post the decision back. */
const INTERACTIVE_JS = `
var krComments = [];
var krDone = false;

function krFileOf(row) {
  var wrapper = row.closest(".d2h-file-wrapper");
  if (!wrapper) return undefined;
  var name = wrapper.querySelector(".d2h-file-name");
  return name ? name.textContent.trim() : undefined;
}

function krLineOf(row, cell) {
  var nums = row.querySelectorAll(".line-num1, .line-num2");
  if (!nums.length) return undefined;
  // Side-by-side: left cell holds the old line number, right the new one.
  var isSide = !!cell.closest(".d2h-code-side-line");
  var el = isSide ? (cell === cell.parentElement.children[1] ? nums[0] : nums[1]) : nums[1] || nums[0];
  if (!el) return undefined;
  var n = parseInt(el.textContent, 10);
  return Number.isFinite(n) ? n : undefined;
}

function krSideOf(row, cell) {
  if (!cell.closest(".d2h-code-side-line")) return "new";
  return cell === cell.parentElement.children[1] ? "old" : "new";
}

function krRenderPanel() {
  var panel = document.getElementById("kr-comment-panel");
  var list = document.getElementById("kr-comments");
  list.innerHTML = "";
  krComments.forEach(function (c, i) {
    var div = document.createElement("div");
    div.className = "kr-comment";
    var anchor = c.file ? c.file + (c.line ? ":" + c.line : "") : "(file level)";
    div.innerHTML =
      '<button class="kr-remove" data-i="' + i + '">remove</button>' +
      '<div class="kr-anchor"></div>' +
      (c.code ? '<div class="kr-code"></div>' : "") +
      "<div></div>";
    div.children[1].textContent = anchor;
    if (c.code) div.children[2].textContent = c.code;
    div.lastElementChild.textContent = c.text;
    list.appendChild(div);
  });
  list.querySelectorAll(".kr-remove").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var i = parseInt(btn.getAttribute("data-i"), 10);
      var row = krComments[i] && krComments[i]._row;
      if (row) row.classList.remove("kr-has-comment");
      krComments.splice(i, 1);
      krRenderPanel();
    });
  });
  panel.classList.toggle("visible", krComments.length > 0 || true);
  document.getElementById("kr-count").textContent = krComments.length ? krComments.length + " comment(s)" : "no comments yet";
}

document.addEventListener("click", function (ev) {
  if (krDone) return;
  var cell = ev.target.closest(".d2h-code-line, .d2h-code-side-line");
  if (!cell || !cell.parentElement) return;
  var row = cell.parentElement;
  var text = window.prompt("Comment on " + krFileOf(row) + " (new line " + (krLineOf(row, cell) || "?") + "):");
  if (!text || !text.trim()) return;
  var snippet = (cell.textContent || "").trim().slice(0, 300);
  var comment = {
    file: krFileOf(row),
    line: krLineOf(row, cell),
    side: krSideOf(row, cell),
    code: snippet || undefined,
    text: text.trim(),
  };
  comment._row = row;
  krComments.push(comment);
  row.classList.add("kr-has-comment");
  krRenderPanel();
});

function krPost(action) {
  var payload = {
    action: action,
    summary: (document.getElementById("kr-summary") || {}).value || undefined,
    comments: krComments.map(function (c) {
      return { file: c.file, line: c.line, side: c.side, code: c.code, text: c.text };
    }),
  };
  fetch("decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
    .then(function () {
      krDone = true;
      document.getElementById("kr-done").classList.add("visible");
      document.getElementById("kr-done-text").textContent =
        action === "approve" ? "Approved — kimchi will push the branch and open a draft PR. You can close this tab." :
        action === "request-changes" ? "Sent to the remote agent — it's now addressing your comments. You can close this tab." :
        "Review cancelled. Back to the kimchi menu in the terminal — you can close this tab.";
    })
    .catch(function () {
      window.alert("Could not reach kimchi (the decision may already be recorded). Check the terminal.");
    });
}

krRenderPanel();
`

const INTERACTIVE_BODY = `<div id="kimchi-actions">
<button type="button" class="request" onclick="krPost('request-changes')">Request changes &#8594; remote agent</button>
<button type="button" class="primary" onclick="krPost('approve')">Approve &#8212; push &amp; open draft PR</button>
<button type="button" onclick="krPost('closed')">Cancel</button>
</div>
<div id="kr-comment-panel">
<h2>Review comments <span id="kr-count" style="color:#59636e;font-weight:normal"></span></h2>
<p style="margin:4px 0;color:#59636e">Click any code line in the diff to add a comment.</p>
<div id="kr-comments"></div>
<textarea id="kr-summary" placeholder="Overall note to the agent (optional)"></textarea>
</div>
<div id="kr-done"><div id="kr-done-text"></div></div>
`

export function buildDiffHtmlDocument(opts: {
	title: string
	subtitle?: string
	patch: string
	/** Interactive REVIEW page (comment + decision buttons, posted to the kimchi review server). */
	interactive?: boolean
}): string {
	const { title, subtitle, patch, interactive = false } = opts
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; background: #f6f8fa; color: #1f2328; }
.kimchi-header { padding: 12px 20px; border-bottom: 1px solid #d1d9e0; background: #ffffff; position: sticky; top: 0; z-index: 1; }
.kimchi-header h1 { font-size: 15px; margin: 0; font-weight: 600; }
.kimchi-header .kimchi-stat { font-size: 13px; color: #59636e; margin-top: 2px; }
#diff { padding: 12px 20px 40px; }
${diff2htmlCss}
${interactive ? INTERACTIVE_CSS : ""}
/* Contrast overrides: diff2html's defaults sit below WCAG AA on some screen
   setups — pin the text colors up-front rather than inheriting theme vars. */
.d2h-file-header, .d2h-file-name, .d2h-file-name-wrapper { color: #1f2328; }
.d2h-code-line, .d2h-code-side-line { color: #1f2328; }
.d2h-code-linenumber, .d2h-code-side-linenumber { color: #57606a; }
.d2h-file-list-text a { color: #0969da; }
</style>
</head>
<body>
<div class="kimchi-header">
<h1>${title.replace(/</g, "&lt;")}</h1>
${subtitle ? `<div class="kimchi-stat">${subtitle.replace(/</g, "&lt;")}</div>` : ""}
</div>
${interactive ? INTERACTIVE_BODY : ""}
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
${interactive ? `<script>${INTERACTIVE_JS}</script>` : ""}
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
