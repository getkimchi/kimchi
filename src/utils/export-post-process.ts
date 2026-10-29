/**
 * Single-pass export post-processing + secure export workspace.
 *
 * Structure (assemble → redact → encode, one read + one write per export):
 *
 *  - `postProcessHtmlExportOnce` / `postProcessJsonlExportOnce` transform the
 *    raw upstream export IN PLACE at a private temp path: parse, inject trace
 *    IDs, enrich sub-agent records (best-effort — a failure must not skip
 *    redaction of what we have), assemble EVERY piece of payload content
 *    (host metadata, buffered config-change entries, the JSONL header system
 *    prompt, and sub-agent tab payloads with persona-resolved prompts and full
 *    transcripts), then redact the complete assembled object graph with
 *    `redactObjectStringsStrict` — fail-closed: a redaction engine failure
 *    aborts the export rather than passing sensitive content through — and
 *    only then encode and write once. Nothing sensitive is injected after
 *    redaction, and the payload is decoded/encoded exactly once.
 *
 *  - `runSecureExport` owns the file lifecycle: the final destination is
 *    resolved BEFORE generation against the session cwd (explicit relative
 *    paths and defaults alike — never `process.cwd()`), a private 0600 temp
 *    is exclusively pre-created next to it, upstream always generates into
 *    the temp (never `undefined`, never the public name, so raw content never
 *    exists publicly), the pipeline transforms the temp, and publish is a
 *    single atomic rename on success only. Failures sweep the temp and never
 *    touch the destination — a pre-existing export survives every failed
 *    attempt.
 */

import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { redactObjectStringsStrict } from "../extensions/pii-redaction/redactor.js"
import { getVersion } from "../utils.js"
import { collectSubAgentTabData, enrichSubAgentEntries, type SubAgentTabData } from "./export-subagents.js"
import {
	type ConfigChangeRecord,
	getConfigChanges,
	getSessionStartMetadata,
	type SessionStartMetadata,
} from "./session-metadata-store.js"
import { type ExportEntry, injectTraceIdsIntoEntries } from "./trace-id-export.js"

/** Append a snippet before `</body>` if present, otherwise append to the end of the document. */
export function appendBeforeBody(html: string, snippet: string): string {
	if (html.includes("</body>")) {
		return html.replace("</body>", `${snippet}\n</body>`)
	}
	return `${html}\n${snippet}\n`
}

/** Options shared by the single-pass export pipelines. */
export interface ExportPipelineOptions {
	/** Effective system prompt at export time (JSONL header injection; the HTML payload already carries it). */
	systemPrompt?: string
	/** Launch-time host/config metadata. Defaults to the in-process store — the offloaded worker passes it explicitly. */
	metadata?: SessionStartMetadata
	/** Buffered in-session config changes. Defaults to the in-process store — the offloaded worker passes it explicitly. */
	configChanges?: ReadonlyArray<ConfigChangeRecord>
	/**
	 * Persona fallback prompts (agent type → system prompt, lowercase keys),
	 * built from the parent's live persona registry — user agents registered
	 * from `.kimchi/agents` exist only in the exporting process, so the
	 * offloaded worker carries them explicitly. Built-in defaults resolve
	 * identically in the child and are not serialized.
	 */
	agentSystemPrompts?: Readonly<Record<string, string>>
}

function resolvePipelineOptions(options?: ExportPipelineOptions): {
	metadata: SessionStartMetadata | undefined
	configChanges: ReadonlyArray<ConfigChangeRecord>
} {
	return {
		metadata: options?.metadata ?? getSessionStartMetadata(),
		configChanges: options?.configChanges ?? getConfigChanges(),
	}
}

/**
 * Append buffered config-change events as standalone custom entries.
 * Idempotent: deterministic ids are de-duped against existing entry ids.
 */
function appendConfigChangeEntries(
	entries: Array<Record<string, unknown>>,
	changes: ReadonlyArray<ConfigChangeRecord>,
): void {
	if (changes.length === 0) return
	const existingIds = new Set<string>()
	for (const entry of entries) {
		if (typeof entry.id === "string") {
			existingIds.add(entry.id)
		}
	}
	for (const change of changes) {
		const deterministicId = `config_changed:${change.key}:${change.timestamp}`
		if (existingIds.has(deterministicId)) {
			continue
		}
		existingIds.add(deterministicId)
		entries.push({
			type: "custom",
			id: deterministicId,
			parentId: null,
			customType: "config_changed",
			data: { key: change.key, value: change.value, timestamp: change.timestamp },
		})
	}
}

// ---------------------------------------------------------------------------
// Single-pass JSONL pipeline
// ---------------------------------------------------------------------------

/**
 * Post-process a raw JSONL export in place: parse lines once, inject trace
 * IDs, enrich sub-agent records (warn-only), assemble the header (appVersion,
 * system prompt, OS/config metadata) and buffered config-change entries, then
 * redact every parsed entry with the strict fail-closed walker and write the
 * file once. Malformed lines are skipped with a warning (same as before);
 * they were dropped by the old post-processing pass too.
 */
export async function postProcessJsonlExportOnce(filePath: string, options?: ExportPipelineOptions): Promise<void> {
	const raw = readFileSync(filePath, "utf-8")
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)

	// Parse each line exactly once. Malformed lines are skipped with a warning
	// so one bad line cannot crash the export — the same outcome the old
	// string-round-trip produced, minus the intermediate parse+serialize pass
	// over every entry.
	const parsedEntries: Array<Record<string, unknown>> = []
	for (const line of lines) {
		try {
			parsedEntries.push(JSON.parse(line) as Record<string, unknown>)
		} catch (err) {
			console.warn("[export] skipping malformed JSONL line:", line.slice(0, 200), err)
		}
	}

	// Trace-id injection operates on the parsed objects directly.
	injectTraceIdsIntoEntries(parsedEntries as unknown as ExportEntry[])

	// Enrichment is best-effort: a failure must not skip redaction of what we have.
	try {
		enrichSubAgentEntries(parsedEntries)
	} catch (err) {
		console.warn("[export] sub-agent enrichment failed — continuing without transcripts:", err)
	}

	// Assemble: header metadata + system prompt, buffered config-change entries.
	const { metadata, configChanges } = resolvePipelineOptions(options)
	const first = parsedEntries[0]
	if (first !== undefined && first.type === "session") {
		first.appVersion = getVersion()
		const systemPrompt = options?.systemPrompt?.trim()
		if (systemPrompt) {
			first.systemPrompt = systemPrompt
		}
		// Spread the flat telemetry.* / config.* key-value pairs onto the
		// header. Naturally idempotent: reassigning the same primitives.
		if (metadata) {
			Object.assign(first, metadata.os, metadata.config)
		}
	}
	appendConfigChangeEntries(parsedEntries, configChanges)

	// Redact the complete assembled graph — fail closed.
	const redactedEntries = await redactObjectStringsStrict(parsedEntries)

	// Single write.
	writeFileSync(filePath, `${redactedEntries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8")
}

// ---------------------------------------------------------------------------
// Single-pass HTML pipeline
// ---------------------------------------------------------------------------

/**
 * Post-process a raw HTML export in place: decode the base64 session payload,
 * inject trace IDs, enrich sub-agent records (warn-only), assemble all
 * payload content (host metadata, buffered config-change entries, sub-agent
 * tab payloads with persona-resolved prompts), then redact the complete
 * assembled object graph with the strict fail-closed walker, re-encode, and
 * inject the renderer scripts, tab bar, and page scaffold — one write.
 */
export async function postProcessHtmlExportOnce(filePath: string, options?: ExportPipelineOptions): Promise<void> {
	let html = readFileSync(filePath, "utf-8")

	const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
	if (!match) {
		// No session-data block: nothing to enrich or redact. Still inject the
		// static renderer scripts (they no-op client-side without the payload).
		html = injectStaticRendererScripts(html)
		writeFileSync(filePath, html, "utf-8")
		return
	}

	const base64 = match[1]
	const json = Buffer.from(base64, "base64").toString("utf-8")
	const data = JSON.parse(json) as Record<string, unknown>

	if (!Array.isArray(data.entries)) {
		html = injectStaticRendererScripts(html)
		writeFileSync(filePath, html, "utf-8")
		return
	}
	const entries = data.entries as Array<Record<string, unknown>>

	injectTraceIdsIntoEntries(entries as unknown as ExportEntry[])

	// Enrich sub-agent records with full transcripts from .output files.
	// No baseDir confinement is applied: .output files live under the
	// session directory (e.g. ~/.config/kimchi/harness/sessions/...),
	// which is unrelated to the export file's location. The `..`
	// traversal check inside enrichSubAgentEntries still guards against
	// directory-escape attacks. Best-effort: a failure must not skip
	// redaction of what we have.
	try {
		enrichSubAgentEntries(entries)
	} catch (err) {
		console.warn("[export] sub-agent enrichment failed — continuing without transcripts:", err)
	}

	// Assemble ALL payload content before redaction: host metadata, buffered
	// config-change entries, and sub-agent tab payloads (the tab sessionData
	// includes the persona-resolved system prompt and the full transcript).
	// The top-level systemPrompt is already in the payload (upstream puts
	// state.systemPrompt there). Nothing is encoded yet.
	const { metadata, configChanges } = resolvePipelineOptions(options)
	if (metadata) {
		// Naturally idempotent: reassigning the same primitives.
		data.hostMetadata = {
			os: metadata.os,
			config: metadata.config,
			capturedAt: metadata.capturedAt,
		}
	}
	appendConfigChangeEntries(entries, configChanges)
	const tabData = collectSubAgentTabData(entries, options?.agentSystemPrompts)

	// Redact the complete assembled object graph — fail closed. The walk
	// returns new structures; assign them.
	const redactedData = await redactObjectStringsStrict(data)
	const redactedTabs = await Promise.all(tabData.map((tab) => redactObjectStringsStrict(tab)))

	// Encode after redaction: the main payload and every tab payload.
	const modifiedBase64 = Buffer.from(JSON.stringify(redactedData)).toString("base64")
	html = html.replace(
		/<script id="session-data" type="application\/json">[\s\S]*?<\/script>/,
		`<script id="session-data" type="application/json">${modifiedBase64}</script>`,
	)

	// Inject in the same order the old two-pass pipeline produced: the tab
	// scaffold and iframe data first, then the static renderer scripts —
	// keeping the output byte-identical to pre-PR-2 exports.
	html = injectSubAgentTabs(html, redactedTabs)
	html = injectStaticRendererScripts(html)

	// Single write.
	writeFileSync(filePath, html, "utf-8")
}

// ---------------------------------------------------------------------------
// Static renderer scripts + sub-agent tab scaffold (injected into the HTML)
// ---------------------------------------------------------------------------

/** Inject the trace-id, session-metadata, and request-diagnostics renderer scripts (idempotent). */
function injectStaticRendererScripts(html: string): string {
	// Inject the trace ID renderer script before </body> (idempotent).
	if (!html.includes('id="trace-id-renderer"')) {
		const traceIdScript = `<script id="trace-id-renderer">
(function() {
    var el = document.getElementById('session-data');
    if (!el) return;
    var base64 = el.textContent;
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    var entriesWithTraceIds = [];
    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (e.traceIds && e.traceIds.length > 0) entriesWithTraceIds.push(e);
    }
    if (entriesWithTraceIds.length === 0) return;
    function inject() {
        var messagesEl = document.getElementById('messages') || document.getElementById('content') || document.body;
        for (var i = 0; i < entriesWithTraceIds.length; i++) {
            var entry = entriesWithTraceIds[i];
            var el = document.getElementById('entry-' + entry.id);
            if (el && el.querySelector('.trace-ids')) continue;
            if (!el) {
                el = document.createElement('div');
                el.id = 'entry-' + entry.id;
                el.className = 'custom-entry';
                el.style.cssText = 'margin:0.5rem 0;padding:0.5rem 1rem';
                messagesEl.appendChild(el);
            }
            var d = document.createElement('div');
            d.className = 'trace-ids';
            d.textContent = 'Trace IDs: ' + entry.traceIds.join(', ');
            d.style.cssText = 'font-size:0.75rem;color:#666;margin-top:0.25rem;font-family:monospace';
            el.appendChild(d);
        }
    }
    function run() { inject(); }
    var pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        setTimeout(function() { pending = false; run(); }, 0);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else { run(); }
    var msgEl = document.getElementById('messages');
    if (msgEl && window.MutationObserver) {
        new MutationObserver(schedule).observe(msgEl, { childList: true });
    }
})();
</script>`
		html = appendBeforeBody(html, traceIdScript)
	}

	// Inject the session-metadata renderer script before </body> (idempotent).
	if (!html.includes('id="session-metadata-renderer"')) {
		const metadataScript = `<script id="session-metadata-renderer">
(function() {
    var el = document.getElementById('session-data');
    if (!el) return;
    var base64 = el.textContent;
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!data.hostMetadata) return;
    var container = document.createElement('div');
    container.id = 'session-metadata';
    container.style.cssText = 'padding:0.5rem 1rem;font-size:0.75rem;color:#666;border-bottom:1px solid #eee;font-family:monospace';
    var parts = [];
    var os = data.hostMetadata.os || {};
    if (os['telemetry.os']) parts.push('OS: ' + os['telemetry.os'] + '/' + (os['telemetry.arch'] || ''));
    if (os['telemetry.is_wsl']) parts.push('WSL');
    var models = [];
    var seen = {};
    if (data.entries) {
        for (var i = 0; i < data.entries.length; i++) {
            var e = data.entries[i];
            var ref = null;
            if (e.type === 'model_change' && e.provider && e.modelId) {
                ref = e.provider + '/' + e.modelId;
            } else if (e.type === 'message' && e.message && e.message.role === 'assistant' && e.message.provider && e.message.model) {
                ref = e.message.provider + '/' + e.message.model;
            }
            if (ref && !seen[ref]) {
                seen[ref] = true;
                models.push(ref);
            }
        }
    }
    parts.push(models.length > 0 ? 'Models: ' + models.join(', ') : 'Models: —');
    container.textContent = parts.join(' · ');
    var saHeader = document.getElementById('sa-header');
    if (saHeader) {
      saHeader.insertBefore(container, saHeader.firstChild);
    } else {
      var body = document.body || document.documentElement;
      body.insertBefore(container, body.firstChild);
    }
    if (data.entries) {
        for (var i = 0; i < data.entries.length; i++) {
            var e = data.entries[i];
            if (e.type === 'custom' && e.customType === 'config_changed') {
                var entryEl = document.getElementById('entry-' + e.id);
                if (entryEl && !entryEl.querySelector('.config-change')) {
                    var d = document.createElement('div');
                    d.className = 'config-change';
                    d.textContent = 'Config changed: ' + e.data.key + ' = ' + e.data.value;
                    d.style.cssText = 'font-size:0.75rem;color:#999;margin-top:0.25rem;font-family:monospace';
                    entryEl.appendChild(d);
                }
            }
        }
    }
})();
</script>`
		html = appendBeforeBody(html, metadataScript)
	}

	// Inject the request diagnostics renderer script before </body> (idempotent).
	if (!html.includes('id="diagnostics-renderer"')) {
		const diagnosticsScript = `<script id="diagnostics-renderer">
(function() {
    var el = document.getElementById('session-data');
    if (!el) return;
    var base64 = el.textContent;
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!data.entries) return;
    var diagEntries = [];
    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (e.type === 'custom' && e.customType === 'request_diagnostics') {
            diagEntries.push(e);
        }
    }
    if (diagEntries.length === 0) return;
    function inject() {
        var messagesEl = document.getElementById('messages') || document.getElementById('content') || document.body;
        for (var i = 0; i < diagEntries.length; i++) {
            var entry = diagEntries[i];
            var entryEl = document.getElementById('entry-' + entry.id);
            if (entryEl && entryEl.querySelector('.request-diagnostics')) continue;
            if (!entryEl) {
                entryEl = document.createElement('div');
                entryEl.id = 'entry-' + entry.id;
                entryEl.className = 'custom-entry';
                entryEl.style.cssText = 'margin:0.5rem 0;padding:0.5rem 1rem';
                messagesEl.appendChild(entryEl);
            }
            var d = entryEl.querySelector('.request-diagnostics') || document.createElement('div');
            d.className = 'request-diagnostics';
            d.style.cssText = 'font-size:0.75rem;color:#888;margin-top:0.25rem;font-family:monospace';
            var parts = [];
            var dt = entry.data || {};
            if (dt.status) parts.push('HTTP ' + dt.status);
            if (dt.durationMs !== undefined) parts.push(dt.durationMs + 'ms');
            if (dt.isRetry) parts.push('retry');
            if (dt.traceId) parts.push('trace: ' + dt.traceId.substring(0, 16));
            if (dt.error) parts.push('error: ' + dt.error.substring(0, 100));
            d.textContent = parts.join(' · ');
            entryEl.appendChild(d);
        }
    }
    function run() { inject(); }
    var pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        setTimeout(function() { pending = false; run(); }, 0);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else { run(); }
    var msgEl = document.getElementById('messages');
    if (msgEl && window.MutationObserver) {
        new MutationObserver(schedule).observe(msgEl, { childList: true });
    }
})();
</script>`
		html = appendBeforeBody(html, diagnosticsScript)
	}

	return html
}

/** Inject the sub-agent tab bar, iframe data scripts, and page scaffold (idempotent). */
function injectSubAgentTabs(html: string, tabs: SubAgentTabData[]): string {
	if (tabs.length === 0 || html.includes('id="subagent-tabs"')) {
		return html
	}

	// Encode the already-redacted tab payloads.
	const dataScripts = tabs
		.map((tab) => {
			const sessionDataB64 = Buffer.from(JSON.stringify(tab.sessionData), "utf-8").toString("base64")
			return `<script type="application/json" id="subagent-data-${tab.id}">${sessionDataB64}</script>`
		})
		.join("\n")

	const tabBar = `<div id="sa-header" style="position:fixed;top:0;left:0;width:100%;z-index:1000">\n<div id="subagent-tabs" style="display:flex;gap:0;border-bottom:1px solid #333;background:#1a1a2e;padding:0 0.5rem;box-sizing:border-box">\n<button class="sa-tab sa-tab-main" data-sa-id="main" onclick="switchToMainSession()" style="padding:0.4rem 0.8rem;background:none;border:none;border-bottom:2px solid #4a9;color:#4a9;cursor:pointer;font-size:0.8rem">Main Session</button>\n${tabs
		.map(
			(tab) =>
				`<button class="sa-tab" data-sa-id="${tab.id}" onclick="switchToSubAgent('${tab.id}')" style="padding:0.4rem 0.8rem;background:none;border:none;border-bottom:2px solid transparent;color:#888;cursor:pointer;font-size:0.8rem">${tab.label}<span style="color:#555;font-size:0.7rem;margin-left:0.3rem">${tab.subtitle}</span></button>`,
		)
		.join("\n")}\n</div>\n</div>`

	// Build the switcher script using string concatenation to avoid literal
	// <script> tags inside the template literal (which break HTML parsing).
	// Inject a style tag creating a proper page scaffold: fixed header + scrollable body.
	const mainStyle = `<style id="sa-scaffold">html,body{margin:0;padding:0;height:100%;overflow:hidden}#sa-header{position:fixed;top:0;left:0;width:100%;z-index:1000}#sa-body{position:fixed;top:var(--sa-header-h,31px);left:0;width:100%;height:calc(100vh - var(--sa-header-h,31px));overflow:auto;overflow-y:auto}</style>`

	const switchScript = [
		"<scr" + 'ipt id="subagent-tab-switcher">',
		"var subagentIframes = {};",
		"// Measure header height and set CSS variable for consistent positioning.",
		"// Re-measure after DOMContentLoaded to account for dynamically inserted metadata.",
		"function measureHeader() {",
		'  var header = document.getElementById("sa-header");',
		"  if (header) {",
		'    document.documentElement.style.setProperty("--sa-header-h", header.offsetHeight + "px");',
		"  }",
		"}",
		"measureHeader();",
		'if (document.readyState === "loading") {',
		'  document.addEventListener("DOMContentLoaded", function() { setTimeout(measureHeader, 100); });',
		"} else {",
		"  setTimeout(measureHeader, 100);",
		"}",
		"function switchToSubAgent(id) {",
		'  var body = document.getElementById("sa-body");',
		'  if (body) body.style.display = "none";',
		"  Object.keys(subagentIframes).forEach(function(k) {",
		'    subagentIframes[k].style.display = (k === id) ? "block" : "none";',
		"  });",
		"  if (!subagentIframes[id]) {",
		'    var dataEl = document.getElementById("subagent-data-" + id);',
		"    if (!dataEl) return;",
		"    var b64 = dataEl.textContent.trim();",
		"    // Clone the document, remove tab UI, swap session-data.",
		"    var clone = document.documentElement.cloneNode(true);",
		'    var tabsBar = clone.querySelector("#subagent-tabs");',
		"    if (tabsBar) tabsBar.remove();",
		'    var switcher = clone.querySelector("#subagent-tab-switcher");',
		"    if (switcher) switcher.remove();",
		'    clone.querySelectorAll("[id^=subagent-data-]").forEach(function(el) { el.remove(); });',
		"    // Remove injected renderer elements that should not appear in the iframe.",
		"    // Unwrap #app from #sa-body before removing the wrapper.",
		'    var saBody = clone.querySelector("#sa-body");',
		"    if (saBody) {",
		"      while (saBody.firstChild) { saBody.parentNode.insertBefore(saBody.firstChild, saBody); }",
		"      saBody.remove();",
		"    }",
		'    clone.querySelectorAll("#sa-header, #subagent-tab-switcher, #session-metadata").forEach(function(el) { el.remove(); });',
		'    clone.querySelectorAll("style#sa-scaffold").forEach(function(el) { el.remove(); });',
		"    // Reset #app display — the parent page hides it when switching tabs.",
		'    var cloneApp = clone.querySelector("#app");',
		'    if (cloneApp) cloneApp.style.display = "";',
		'    var cloneBody = clone.querySelector("#sa-body");',
		'    if (cloneBody) cloneBody.style.display = "";',
		'    var sd = clone.querySelector("#session-data");',
		"    if (sd) sd.textContent = b64;",
		"    // Inject CSS overrides so the upstream template layout works inside an iframe.",
		'    var head = clone.querySelector("head");',
		"    if (head) {",
		'      var css = document.createElement("style");',
		'      css.textContent = "html,body{margin:0;padding:0;height:100%;overflow:hidden}#app{display:flex !important;height:100vh !important}#content{height:100vh !important}#header-container .header h1,#header-container .header .help-bar,#header-container .header .header-info{display:none}#header-container .header{padding:0;margin:0;background:transparent}"',
		"      head.appendChild(css);",
		"    }",
		'    var iframe = document.createElement("iframe");',
		'    iframe.style.cssText = "position:fixed;top:var(--sa-header-h,31px);left:0;width:100vw;height:calc(100vh - var(--sa-header-h,31px));border:none;z-index:998";',
		"    iframe.srcdoc = clone.outerHTML;",
		"    document.body.appendChild(iframe);",
		"    subagentIframes[id] = iframe;",
		"  }",
		'  subagentIframes[id].style.display = "block";',
		'  document.querySelectorAll(".sa-tab").forEach(function(btn) {',
		'    btn.style.borderBottom = "2px solid transparent";',
		'    btn.style.color = "#888";',
		"  });",
		'  document.querySelectorAll(".sa-tab").forEach(function(btn) { if (btn.getAttribute("data-sa-id") === id) { btn.style.borderBottom = "2px solid #4a9"; btn.style.color = "#4a9"; } });',
		"}",
		"function switchToMainSession() {",
		"  Object.keys(subagentIframes).forEach(function(k) {",
		'    subagentIframes[k].style.display = "none";',
		"  });",
		'  var body = document.getElementById("sa-body");',
		'  if (body) body.style.display = "";',
		'  document.querySelectorAll(".sa-tab").forEach(function(btn) {',
		'    btn.style.borderBottom = "2px solid transparent";',
		'    btn.style.color = "#888";',
		"  });",
		'  var mainBtn = document.querySelector(".sa-tab-main");',
		"  if (mainBtn) {",
		'    mainBtn.style.borderBottom = "2px solid #4a9";',
		'    mainBtn.style.color = "#4a9";',
		"  }",
		"}",
		"</scr" + "ipt>",
	].join("\n")

	html = html.replace(/<body([^>]*)>/, `<body$1>\n${tabBar}\n${mainStyle}`)
	// Wrap #app in a scrollable #sa-body container so content never scrolls
	// under the fixed #sa-header.
	html = html.replace(/(<div id="app")/, '<div id="sa-body">$1')
	// Close #sa-body before </body>
	html = html.replace(/<\/body>/, "</div>\n</body>")
	return appendBeforeBody(html, `${dataScripts}\n${switchScript}`)
}

// ---------------------------------------------------------------------------
// Secure export workspace
// ---------------------------------------------------------------------------

/** Export mode — determines the default filename format. */
export type ExportMode = "html" | "jsonl"

/**
 * Session facts the secure workspace needs: the session file's basename feeds
 * the default HTML filename, and the session cwd anchors both default and
 * explicit relative output paths.
 */
export interface ExportSessionInfo {
	/** The session file backing the export. Undefined for in-memory sessions (they cannot export). */
	sessionFile?: string
	/** The session cwd — never `process.cwd()`: long-lived processes (ACP, RPC) host sessions with their own cwd. */
	cwd: string
}

/**
 * Upstream's HTML export name (piConfig.name in the runtime package.json —
 * "kimchi" for this harness). Pinned by the default-naming parity test; if
 * the product name ever changes, that test fails and forces the update.
 */
const EXPORT_APP_NAME = "kimchi"

/**
 * The default export path for a mode, anchored at the session cwd.
 *
 * Filename formats match upstream's exporter exactly (HTML:
 * `${APP_NAME}-session-<basename>.html`, JSONL: `session-<timestamp>.jsonl`)
 * — only the base directory deliberately diverges from upstream's
 * `process.cwd()` to the session cwd (repo ctx.cwd constraint). Pinned by the
 * default-naming parity test.
 */
export function computeDefaultExportPath(mode: ExportMode, session: ExportSessionInfo): string {
	if (mode === "jsonl") {
		return join(session.cwd, `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
	}
	if (!session.sessionFile) {
		throw new Error("Cannot export in-memory session to HTML")
	}
	return join(session.cwd, `${EXPORT_APP_NAME}-session-${basename(session.sessionFile, ".jsonl")}.html`)
}

export interface SecureExportOptions {
	mode: ExportMode
	/** User-supplied output path (absolute, or relative to the session cwd). Omitted → `computeDefaultExportPath`. */
	outputPath?: string
	/** Session facts for default naming and path resolution. */
	session: ExportSessionInfo
	/** Upstream generation: writes the raw export into the given private temp path. */
	upstreamExport: (tempPath: string) => string | Promise<string>
	/** Single-pass in-place transform of the temp file (enrich + redact + encode). */
	pipeline: (tempPath: string) => Promise<void>
}

/**
 * Secure export workspace lifecycle:
 *
 * 1. Resolve the final destination BEFORE generation, against the session
 *    cwd — explicit relative paths and defaults alike. Absolute inputs pass
 *    through so upstream's own `resolvePath(x, process.cwd())` can never
 *    re-anchor them.
 * 2. Pre-create a private temp next to the destination: exclusive `wx` create
 *    at mode 0600 (no umask exposure). Upstream's `writeFileSync` into the
 *    pre-created file truncates and keeps the mode (POSIX create-mode applies
 *    only at creation), so the raw export only ever exists as a 0600 private
 *    temp — there is no public-then-move window.
 * 3. Always pass the temp to upstream — never `undefined`, never the public
 *    name.
 * 4. Run the single-pass pipeline in place.
 * 5. Publish on success only: an existing destination keeps its previous
 *    mode across replacement (never widened, never narrowed by our choice); a
 *    new destination publishes at 0600 (secure default for a full session
 *    transcript; restrictive umasks are never bypassed). A single atomic
 *    `renameSync` replaces a pre-existing export only at this final step.
 * 6. Failure cleanup is ownership-scoped: any error (upstream throw, pipeline
 *    throw, worker non-zero exit) unlinks the temp and rethrows. The public
 *    path is never touched on failure — a pre-existing export survives every
 *    failed attempt.
 *
 * Returns the resolved `finalPath` so the TUI status message
 * ("Session exported to: …") stays correct regardless of upstream's own
 * return value.
 */
/**
 * Normalize a user-supplied output path the way upstream's exporter does
 * (normalizePath with its defaults): expand `~` / `~/` against the home
 * directory (plus `~\` on Windows) and convert `file://` URLs to plain
 * paths. Without this, `/export ~/out.html` would resolve to a literal
 * `~` directory under the session cwd.
 */
function expandExportOutputPath(raw: string): string {
	if (raw === "~") return homedir()
	if (raw.startsWith("~/") || (process.platform === "win32" && raw.startsWith("~\\"))) {
		return join(homedir(), raw.slice(2))
	}
	if (/^file:\/\//.test(raw)) {
		return fileURLToPath(raw)
	}
	return raw
}

export async function runSecureExport(options: SecureExportOptions): Promise<string> {
	const { mode, outputPath, session, upstreamExport, pipeline } = options

	// 1. Resolve the destination before generation. Tilde and file:// forms
	// are normalized first (upstream parity), then resolved against the
	// session cwd; absolute paths pass through unchanged.
	const finalPath =
		outputPath !== undefined && outputPath !== ""
			? resolve(session.cwd, expandExportOutputPath(outputPath))
			: computeDefaultExportPath(mode, session)
	const destDir = dirname(finalPath)
	// Upstream's JSONL exporter mkdirs the destination directory; keep that
	// for both modes so explicit paths into new directories keep working.
	mkdirSync(destDir, { recursive: true })

	// 2. Securely pre-create the private temp.
	const tempPath = join(
		destDir,
		`.${basename(finalPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
	)
	closeSync(openSync(tempPath, "wx", 0o600))

	try {
		// 3. Upstream always writes into the pre-created temp.
		await upstreamExport(tempPath)
		// 4. Single-pass transform in place.
		await pipeline(tempPath)
		// 5. Publish on success only, preserving destination permissions.
		// Inside the protected lifecycle: a failed rename (e.g. the destination
		// is a directory) must sweep the temp too — otherwise a widened temp
		// (destMode is applied before the rename) is left behind.
		const destMode = existsSync(finalPath) ? statSync(finalPath).mode & 0o777 : 0o600
		chmodSync(tempPath, destMode)
		renameSync(tempPath, finalPath)
	} catch (err) {
		// Ownership-scoped cleanup: remove only the temp we created. Applies to
		// every failure phase — generation, pipeline, and publication alike.
		try {
			unlinkSync(tempPath)
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn("[export] failed to remove temp export file:", tempPath, unlinkErr)
			}
		}
		throw err
	}

	// 6. Our own resolution keeps the caller's status message correct.
	return finalPath
}
