import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gzip } from "node:zlib"
import { resolveAuxiliaryFilesDir } from "../auxiliary-files/resolver.js"
import { appendBeforeBody } from "../utils/export-post-process.js"
import { enrichReplayDetails } from "./details.js"
import type { Recording } from "./recorder.js"

const compress = promisify(gzip)

function assetsDirectory(): string {
	const staged = join(resolveAuxiliaryFilesDir(process.env, homedir(), process.execPath), "terminal-replay")
	return existsSync(staged)
		? staged
		: fileURLToPath(new URL("../../resources/terminal-replay/generated/", import.meta.url))
}

export async function addTerminalReplay(html: string, recordings: Recording[]): Promise<string> {
	if (recordings.length === 0) {
		return appendBeforeBody(
			html,
			'<p id="terminal-replay-unavailable" style="position:fixed;bottom:12px;right:20px;background:#222;color:#ddd;padding:8px;z-index:1100">Terminal replay unavailable: recording was disabled, expired, or could not be saved.</p>',
		)
	}
	const assets = assetsDirectory()
	const [template, js, css] = await Promise.all(
		["player.html", "player.js", "player.css"].map((file) => readFile(join(assets, file), "utf8")),
	)
	const enrichedRecordings = await enrichReplayDetails(html, recordings)
	const packedRecordings: Recording[] = []
	for (const { traceDetails, ...recording } of enrichedRecordings) {
		// Pack one part at a time; the player only expands details for the selected part.
		packedRecordings.push(
			traceDetails
				? {
						...recording,
						traceDetailsGzip: (await compress(JSON.stringify(traceDetails), { level: 6 })).toString("base64"),
					}
				: recording,
		)
	}
	const document = template
		.replace("/* PLAYER_JS */", () => js.replace(/<\/script/gi, "<\\/script"))
		.replace("/* PLAYER_CSS */", () => css)
		.replace("/* RECORDINGS */", () => JSON.stringify(packedRecordings).replaceAll("<", "\\u003c"))
	// JSON protects the script boundary without base64-encoding the gzip payload a second time.
	const encoded = JSON.stringify(document).replaceAll("<", "\\u003c")
	return appendBeforeBody(
		html,
		`
<style id="terminal-replay-style">
  #terminal-replay-toolbar { position:sticky;top:0;z-index:1000;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 18px;background:var(--container-bg,#1e1e24);border-bottom:1px solid var(--borderMuted,#505050);color:var(--muted,#9999a5);font:12px/18px ui-monospace,Menlo,Consolas,monospace; }
  #terminal-replay-toolbar strong { color:var(--borderAccent,#00d7ff);font-size:12px; }
  #terminal-replay-toolbar [role="group"] { display:flex;gap:6px; }
  #terminal-replay-toolbar button { padding:2px 8px;border:1px solid var(--border,#5f87ff);border-radius:3px;background:var(--container-bg,#1e1e24);color:var(--muted,#9999a5);cursor:pointer;font:inherit;font-size:10px; }
  #terminal-replay-toolbar button[aria-pressed="true"] { background:var(--selectedBg,#3a3a4a);color:var(--accent,#8abeb7); }
  #terminal-replay-toolbar button:hover { border-color:var(--borderAccent,#00d7ff);color:var(--accent,#8abeb7); }
  #terminal-replay-toolbar button:focus-visible { outline:2px solid var(--accent,#8abeb7);outline-offset:2px; }
  body.terminal-replay-inline:not(.terminal-replay-active) #terminal-replay-toolbar { display:none; }
  body.terminal-replay-inline:not(.terminal-replay-active) #hamburger { top:12px; }
  #terminal-replay-panel { display:none;position:fixed;inset:var(--terminal-replay-header-h,62px) 0 0;z-index:999;background:var(--body-bg,#18181e); }
  #terminal-replay-frame { display:block;width:100%;height:100%;border:0; }
  body.terminal-replay-active { overflow:hidden; }
  body.terminal-replay-active #app, body.terminal-replay-active #hamburger, body.terminal-replay-active #sidebar-overlay, body.terminal-replay-active #subagent-tabs, body.terminal-replay-active > iframe { display:none !important; }
  body.terminal-replay-active #terminal-replay-panel { display:block; }
  #sidebar, #sidebar-resizer { top:var(--terminal-replay-header-h,62px);height:calc(100vh - var(--terminal-replay-header-h,62px)); }
  #sidebar-overlay { top:var(--terminal-replay-header-h,62px); }
  #hamburger { top:15px;left:12px;z-index:1001; }
  @media (max-width:900px) { body:not(.terminal-replay-active) #terminal-replay-toolbar strong { margin-left:40px; } }
  @media (max-width:600px) { #terminal-replay-toolbar { padding:8px 12px;gap:8px; } }
  @media print { #terminal-replay-toolbar, #terminal-replay-panel { display:none !important; } body.terminal-replay-active #app { display:flex !important; } }
</style>
<nav id="terminal-replay-toolbar" aria-label="Session views">
  <strong>Session</strong>
  <div role="group" aria-label="View">
    <button id="terminal-replay-close" type="button" aria-pressed="true">Transcript</button>
    <button id="terminal-replay-open" type="button" aria-pressed="false" aria-controls="terminal-replay-panel">Replay</button>
  </div>
</nav>
<section id="terminal-replay-panel" aria-label="Terminal replay">
  <iframe id="terminal-replay-frame" title="Terminal recording" sandbox="allow-scripts allow-downloads"></iframe>
</section>
<script id="terminal-replay-document" type="application/json">${encoded}</script>
<script id="terminal-replay-launcher">
(() => {
  const toolbar = document.getElementById('terminal-replay-toolbar');
  const frame = document.getElementById('terminal-replay-frame');
  const replay = document.getElementById('terminal-replay-open');
  const transcript = document.getElementById('terminal-replay-close');
  const sessionHeader = document.getElementById('sa-header');
  (sessionHeader || document.body).prepend(toolbar);
  new ResizeObserver(() => {
    const height = (sessionHeader || toolbar).getBoundingClientRect().height + 'px';
    document.documentElement.style.setProperty('--terminal-replay-header-h', height);
    if (sessionHeader) document.documentElement.style.setProperty('--sa-header-h', height);
  }).observe(sessionHeader || toolbar);
  function placeActions() {
    const actions = document.querySelector('#header-container .help-actions');
    if (!actions || replay.parentElement === actions) return;
    replay.className = 'download-json-btn';
    replay.textContent = '▶ Replay';
    actions.append(replay);
    document.body.classList.add('terminal-replay-inline');
  }
  placeActions();
  const header = document.getElementById('header-container');
  if (header) new MutationObserver(placeActions).observe(header, { childList:true, subtree:true });
  let active = false;
  let scrollPositions = [];
  function showReplay(show) {
    if (show === active) return;
    if (show) {
      scrollPositions = [document.scrollingElement, document.getElementById('sa-body'), document.getElementById('content')]
        .filter(Boolean).map(element => [element, element.scrollTop]);
    }
    active = show;
    document.body.classList.toggle('terminal-replay-active', show);
    replay.setAttribute('aria-pressed', String(show));
    transcript.setAttribute('aria-pressed', String(!show));
    if (show && !frame.hasAttribute('srcdoc')) {
      frame.srcdoc = JSON.parse(document.getElementById('terminal-replay-document').textContent);
    }
    if (!show) {
      frame.contentWindow?.postMessage('kimchi-replay-pause', '*');
      for (const [element, top] of scrollPositions) element.scrollTop = top;
      replay.focus({ preventScroll:true });
    }
  }
  replay.onclick = () => showReplay(true);
  transcript.onclick = () => showReplay(false);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) showReplay(false);
  });
})();
</script>`,
	)
}

export async function appendTerminalReplayExport(path: string, recordings: Recording[]): Promise<void> {
	const html = await readFile(path, "utf8")
	await writeFile(path, await addTerminalReplay(html, recordings), "utf8")
}
