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
/* Design tokens lifted from plannotator's review-editor (packages/review-editor): */
:root {
--kr-bg: #f6f8fa; --kr-panel: #ffffff; --kr-border: #d1d9e0; --kr-fg: #1f2328;
--kr-muted: #59636e; --kr-primary: #0969da; --kr-primary-tint: rgba(9,105,218,0.07);
--kr-approve: #1f883d; --kr-danger: #cf222e; --kr-radius: 8px;
--kr-shadow: 0 8px 24px rgba(140,149,159,0.2);
--kr-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.kimchi-header { display: flex; align-items: center; gap: 16px; }
.kimchi-header h1 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* segmented decision group (plannotator dock style) */
#kimchi-actions { display: flex; gap: 0; background: #eaeef2; border-radius: 10px; padding: 3px; flex-shrink: 0; }
#kimchi-actions button { border: 0; border-radius: var(--kr-radius); padding: 6px 12px; font-size: 13px; font-weight: 500; cursor: pointer; background: transparent; color: var(--kr-fg); white-space: nowrap; }
#kimchi-actions button:hover:not(:disabled) { background: #ffffff; box-shadow: 0 1px 3px rgba(140,149,159,0.25); }
#kimchi-actions button.primary { color: var(--kr-approve); }
#kimchi-actions button.request { color: var(--kr-danger); }
@media (max-width: 900px) { #kimchi-actions button { font-size: 12px; padding: 6px 8px; } }

/* Gutter affordance: line numbers become clickable comment anchors. */
.d2h-code-side-linenumber, .d2h-code-linenumber { cursor: pointer; }
.d2h-code-side-linenumber:hover, .d2h-code-linenumber:hover { color: var(--kr-primary); background: var(--kr-primary-tint) !important; }

/* comment strip on annotated rows — plannotator's inset-primary marker */
tr.kr-has-comment td { background: var(--kr-primary-tint) !important; }
tr.kr-has-comment td:first-child { box-shadow: inset 3px 0 0 var(--kr-primary); }

/* floating comment dialog (anchored popover, motion-like entrance) */
#kr-popover { position: absolute; z-index: 60; width: 340px; background: var(--kr-panel); border: 1px solid var(--kr-border); border-radius: 10px; box-shadow: var(--kr-shadow), 0 0 0 1px rgba(31,35,40,0.04); overflow: hidden; transform-origin: top left; animation: kr-pop-in 120ms ease-out; display: none; font-size: 13px; }
#kr-popover.visible { display: block; }
@keyframes kr-pop-in { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: none; } }
#kr-popover .kr-pop-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--kr-bg); border-bottom: 1px solid var(--kr-border); }
#kr-popover .kr-pop-anchor { font-family: var(--kr-mono); font-size: 12px; color: var(--kr-primary); }
#kr-popover .kr-pop-close { border: 0; background: none; color: var(--kr-muted); cursor: pointer; font-size: 14px; padding: 0 2px; }
#kr-popover .kr-pop-code { margin: 8px 12px 0; padding: 6px 8px; background: var(--kr-bg); border-radius: 6px; font-family: var(--kr-mono); font-size: 12px; color: var(--kr-muted); white-space: pre-wrap; word-break: break-all; border-left: 2px solid var(--kr-border); }
#kr-popover textarea { display: block; width: calc(100% - 24px); margin: 8px 12px; box-sizing: border-box; min-height: 64px; resize: vertical; font: inherit; border: 1px solid var(--kr-border); border-radius: var(--kr-radius); padding: 8px; }
#kr-popover textarea:focus { outline: 2px solid var(--kr-primary); outline-offset: -1px; border-color: transparent; }
#kr-popover .kr-pop-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 12px 10px; }
#kr-popover .kr-pop-foot button { border: 1px solid var(--kr-border); border-radius: var(--kr-radius); background: var(--kr-panel); color: var(--kr-fg); padding: 5px 12px; font-size: 12px; font-weight: 500; cursor: pointer; }
#kr-popover .kr-pop-foot button.kr-save { background: var(--kr-primary); border-color: var(--kr-primary); color: #fff; }
#kr-popover .kr-pop-foot button.kr-delete { color: var(--kr-danger); }

/* comments panel */
#kr-comment-panel { position: fixed; right: 16px; bottom: 16px; width: 340px; max-height: 50vh; overflow: auto; background: var(--kr-panel); border: 1px solid var(--kr-border); border-radius: 10px; box-shadow: var(--kr-shadow); padding: 10px 12px; font-size: 13px; z-index: 10; }
#kr-comment-panel h2 { font-size: 13px; margin: 0 0 6px; display: flex; align-items: center; gap: 6px; }
#kr-count { background: #eaeef2; border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--kr-muted); }
.kr-comment { border-top: 1px solid var(--kr-border); padding: 8px 0; }
.kr-comment:first-of-type { border-top: 0; padding-top: 4px; }
.kr-comment .kr-anchor { color: var(--kr-primary); word-break: break-all; font-family: var(--kr-mono); font-size: 12px; cursor: pointer; }
.kr-comment .kr-anchor:hover { text-decoration: underline; }
.kr-comment .kr-code { color: var(--kr-muted); font-family: var(--kr-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; border-left: 2px solid var(--kr-border); padding-left: 6px; margin: 3px 0; }
.kr-comment .kr-remove { float: right; color: var(--kr-danger); cursor: pointer; border: 0; background: none; padding: 0; font-size: 12px; }
#kr-summary { width: 100%; box-sizing: border-box; margin-top: 8px; min-height: 48px; font: inherit; border: 1px solid var(--kr-border); border-radius: var(--kr-radius); padding: 6px; }

/* decision-received screen */
#kr-done { position: fixed; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: var(--kr-panel); color: var(--kr-fg); z-index: 100; font-size: 15px; text-align: center; }
#kr-done.visible { display: flex; }
`

/** Client review JS: click a line-number gutter → anchored comment dialog. */
const INTERACTIVE_JS = `
var krComments = [];
var krDone = false;
var krPopTarget = null; // { row, existingIndex }

function krFileOf(row) {
  var wrapper = row.closest(".d2h-file-wrapper");
  if (!wrapper) return undefined;
  var name = wrapper.querySelector(".d2h-file-name");
  return name ? name.textContent.trim() : undefined;
}

/* diff2html side-by-side = TWO halves (.d2h-file-side-diff, left old /
   right new), each row: td.d2h-code-side-linenumber with ONE number +
   a code cell. The clicked half decides the side; the cell's own text is
   the line number; filler rows (alignment padding) carry no number. */
function krAnchorOf(cell) {
  var half = cell.closest(".d2h-file-side-diff");
  var siblings = half && half.parentElement ? half.parentElement.querySelectorAll(".d2h-file-side-diff") : [];
  var side = siblings.length === 2 && half === siblings[1] ? "new" : "old";
  var n = parseInt(cell.textContent.replace(/[^0-9]/g, ""), 10);
  return { side: side, line: Number.isFinite(n) ? n : undefined };
}

function krCodeOf(row) {
  var lineEl = row.querySelector(".d2h-code-side-line, .d2h-code-line");
  return ((lineEl && lineEl.textContent) || "").trim().slice(0, 300);
}

function krOpenPopover(cell) {
  var row = cell.parentElement;
  var anchor = krAnchorOf(cell);
  var existingIndex = krComments.findIndex(function (c) {
    return c.file === krFileOf(row) && c.line === anchor.line && c.side === anchor.side;
  });
  krPopTarget = { row: row, anchor: anchor, existingIndex: existingIndex >= 0 ? existingIndex : null };

  var pop = document.getElementById("kr-popover");
  pop.querySelector(".kr-pop-anchor").textContent =
    (krFileOf(row) || "(unknown file)") + (anchor.line ? ":" + anchor.line : "") + " — " + anchor.side;
  var code = krCodeOf(row);
  var codeEl = pop.querySelector(".kr-pop-code");
  codeEl.textContent = code;
  codeEl.style.display = code ? "" : "none";
  var existing = existingIndex >= 0 ? krComments[existingIndex] : null;
  var textarea = pop.querySelector("textarea");
  textarea.value = existing ? existing.text : "";
  pop.querySelector(".kr-delete").style.display = existing ? "" : "none";

  // Anchor to the gutter cell; clamp so the dialog stays in the viewport.
  var rect = cell.getBoundingClientRect();
  var top = rect.bottom + window.scrollY + 6;
  var left = rect.left + window.scrollX;
  pop.style.top = top + "px";
  pop.style.left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - 356)) + "px";
  pop.classList.add("visible");
  textarea.focus();
}

function krClosePopover() {
  document.getElementById("kr-popover").classList.remove("visible");
  krPopTarget = null;
}

function krSaveComment() {
  if (!krPopTarget) return;
  var text = document.querySelector("#kr-popover textarea").value.trim();
  var anchor = krPopTarget.anchor;
  if (!text) return krDeleteComment();
  var comment = {
    file: krFileOf(krPopTarget.row),
    line: anchor.line,
    side: anchor.side,
    code: krCodeOf(krPopTarget.row) || undefined,
    text: text,
  };
  if (krPopTarget.existingIndex !== null) {
    krComments[krPopTarget.existingIndex] = comment;
  } else {
    krComments.push(comment);
    krPopTarget.row.classList.add("kr-has-comment");
  }
  krClosePopover();
  krRenderPanel();
}

function krDeleteComment() {
  if (!krPopTarget) return krClosePopover();
  if (krPopTarget.existingIndex !== null) krComments.splice(krPopTarget.existingIndex, 1);
  if (!krComments.some(function (c) { return c.file === krFileOf(krPopTarget.row) && krRowHasLine(krPopTarget.row, c.line); })) {
    krPopTarget.row.classList.remove("kr-has-comment");
  }
  krClosePopover();
  krRenderPanel();
}

function krRowHasLine(row, line) {
  var cell = row.querySelector(".d2h-code-side-linenumber, .d2h-code-linenumber");
  if (!cell) return false;
  return parseInt(cell.textContent.replace(/[^0-9]/g, ""), 10) === line;
}

function krRenderPanel() {
  var list = document.getElementById("kr-comments");
  list.innerHTML = "";
  krComments.forEach(function (c, i) {
    var div = document.createElement("div");
    div.className = "kr-comment";
    var anchor = c.file ? c.file + (c.line ? ":" + c.line : "") : "(unanchored)";
    div.innerHTML =
      '<button class="kr-remove" data-i="' + i + '">remove</button>' +
      '<div class="kr-anchor" data-i="' + i + '"></div>' +
      (c.code ? '<div class="kr-code"></div>' : "") +
      "<div></div>";
    div.children[1].textContent = anchor;
    if (c.code) div.children[2].textContent = c.code;
    div.lastElementChild.textContent = c.text;
    list.appendChild(div);
  });
  list.querySelectorAll(".kr-remove").forEach(function (btn) {
    btn.addEventListener("click", function () {
      krComments.splice(parseInt(btn.getAttribute("data-i"), 10), 1);
      krSyncRowMarkers();
      krRenderPanel();
    });
  });
  list.querySelectorAll(".kr-anchor").forEach(function (a) {
    a.addEventListener("click", function () {
      var c = krComments[parseInt(a.getAttribute("data-i"), 10)];
      var rows = document.querySelectorAll(".d2h-file-wrapper tr");
      for (var i = 0; i < rows.length; i++) {
        if (krFileOf(rows[i]) === c.file && krRowHasLine(rows[i], c.line)) {
          rows[i].scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
    });
  });
  document.getElementById("kr-count").textContent = krComments.length ? krComments.length : "0";
}

function krSyncRowMarkers() {
  document.querySelectorAll("tr.kr-has-comment").forEach(function (row) {
    if (!krComments.some(function (c) { return c.file === krFileOf(row) && krRowHasLine(row, c.line); })) {
      row.classList.remove("kr-has-comment");
    }
  });
}

document.addEventListener("click", function (ev) {
  if (krDone) return;
  var insidePop = ev.target.closest("#kr-popover");
  var gutter = ev.target.closest(".d2h-code-side-linenumber, .d2h-code-linenumber");
  if (gutter && gutter.parentElement.closest("#kr-popover") == null) krOpenPopover(gutter);
  else if (!insidePop) krClosePopover();
});
document.addEventListener("keydown", function (ev) {
  if (ev.key === "Escape") krClosePopover();
  if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && krPopTarget) krSaveComment();
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
        action === "approve" ? "Approved — kimchi is pushing the branch and opening a draft PR. You can close this tab." :
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
<div id="kr-popover" role="dialog" aria-label="Add comment">
<div class="kr-pop-head"><span class="kr-pop-anchor"></span><button type="button" class="kr-pop-close" onclick="krSaveComment();" title="Save &amp; close">&#10005;</button></div>
<div class="kr-pop-code"></div>
<textarea placeholder="Write a comment (Cmd/Ctrl+Enter saves)"></textarea>
<div class="kr-pop-foot">
<button type="button" class="kr-delete" onclick="krDeleteComment()">Delete</button>
<button type="button" onclick="krClosePopover()">Cancel</button>
<button type="button" class="kr-save" onclick="krSaveComment()">Save</button>
</div>
</div>
<div id="kr-comment-panel">
<h2>Review comments <span id="kr-count"></span></h2>
<p style="margin:4px 0;color:var(--kr-muted)">Click any <b>line number</b> in the diff to comment on that line.</p>
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
