import { readFileSync, writeFileSync } from "node:fs"
import { redactObjectStrings } from "../extensions/pii-redaction/redactor.js"
import { getVersion } from "../utils.js"
import { collectSubAgentTabs, enrichSubAgentEntries } from "./export-subagents.js"
import { getConfigChanges, getSessionStartMetadata } from "./session-metadata-store.js"
import { injectTraceIdsIntoEntries, injectTraceIdsIntoExport } from "./trace-id-export.js"

/** Append a snippet before `</body>` if present, otherwise append to the end of the document. */
export function appendBeforeBody(html: string, snippet: string): string {
	if (html.includes("</body>")) {
		return html.replace("</body>", `${snippet}\n</body>`)
	}
	return `${html}\n${snippet}\n`
}

export function postProcessJsonlExport(filePath: string): void {
	const raw = readFileSync(filePath, "utf-8")
	const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
	const traceInjected = injectTraceIdsIntoExport(lines)

	// Parse entries for enrichment. Skip malformed lines so one bad line does
	// not crash the entire export pipeline. Secret redaction is handled
	// separately by redactJsonlExport, which runs after this step.
	const parsedEntries: Record<string, unknown>[] = []
	for (const line of traceInjected) {
		try {
			parsedEntries.push(JSON.parse(line) as Record<string, unknown>)
		} catch (err) {
			console.warn("[export] skipping malformed JSONL line:", line.slice(0, 200), err)
		}
	}

	// Enrich sub-agent records with full transcripts from .output files
	enrichSubAgentEntries(parsedEntries)

	const processed = parsedEntries.map((e) => JSON.stringify(e))

	// Inject version + OS/config metadata into the session header line if present.
	const metadata = getSessionStartMetadata()
	if (processed.length > 0) {
		const first = JSON.parse(processed[0]) as Record<string, unknown>
		if (first.type === "session") {
			first.appVersion = getVersion()
			// Spread the flat telemetry.* / config.* key-value pairs onto the
			// header. Naturally idempotent: reassigning the same primitives.
			if (metadata) {
				Object.assign(first, metadata.os, metadata.config)
			}
			processed[0] = JSON.stringify(first)
		}
	}

	// Append buffered config-change events as standalone custom entries.
	// Idempotent: deterministic ids are de-duped against existing entries.
	const changes = getConfigChanges()
	if (changes.length > 0) {
		const existingIds = new Set<string>()
		for (const line of processed) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>
				if (typeof entry.id === "string") {
					existingIds.add(entry.id)
				}
			} catch {
				// Skip unparseable lines when building the id set.
			}
		}
		for (const change of changes) {
			const deterministicId = `config_changed:${change.key}:${change.timestamp}`
			if (existingIds.has(deterministicId)) {
				continue
			}
			existingIds.add(deterministicId)
			processed.push(
				JSON.stringify({
					type: "custom",
					id: deterministicId,
					parentId: null,
					customType: "config_changed",
					data: { key: change.key, value: change.value, timestamp: change.timestamp },
				}),
			)
		}
	}

	writeFileSync(filePath, `${processed.join("\n")}\n`, "utf-8")
}

/**
 * Redact PII and secrets from a JSONL export file.
 *
 * Reads the file, parses each line as JSON, deep-walks all string values
 * redacting PII/secrets, and writes back. Lines that are not valid JSON
 * are passed through unchanged. This runs AFTER `postProcessJsonlExport`
 * so the file already has trace IDs and metadata injected.
 *
 * API keys/secrets in session transcripts are scrubbed before the
 * transcript leaves the harness.
 */
export async function redactJsonlExport(filePath: string): Promise<void> {
	const raw = readFileSync(filePath, "utf-8")
	const lines = raw.split(/\r?\n/)
	const redacted: string[] = []
	for (const line of lines) {
		if (!line.trim()) {
			redacted.push(line)
			continue
		}
		try {
			const parsed = JSON.parse(line)
			const cleaned = await redactObjectStrings(parsed)
			redacted.push(JSON.stringify(cleaned))
		} catch {
			// Not valid JSON — pass through unchanged
			redacted.push(line)
		}
	}
	writeFileSync(filePath, `${redacted.join("\n")}\n`, "utf-8")
}

export function postProcessHtmlExport(filePath: string): void {
	let html = readFileSync(filePath, "utf-8")

	const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
	if (match) {
		const base64 = match[1]
		const json = Buffer.from(base64, "base64").toString("utf-8")
		const data = JSON.parse(json) as Record<string, unknown>
		if (Array.isArray(data.entries)) {
			injectTraceIdsIntoEntries(data.entries as import("./trace-id-export.js").ExportEntry[])

			// Enrich sub-agent records with full transcripts from .output files.
			// No baseDir confinement is applied: .output files live under the
			// session directory (e.g. ~/.config/kimchi/harness/sessions/...),
			// which is unrelated to the export file's location. The `..`
			// traversal check inside enrichSubAgentEntries still guards against
			// directory-escape attacks.
			// Secret redaction is handled separately by redactHtmlExport,
			// which runs after this post-processing step.
			enrichSubAgentEntries(data.entries as Record<string, unknown>[])

			// Collect sub-agent tabs for iframe rendering. Each sub-agent with a
			// transcript gets its own tab, rendered by the same upstream template
			// in a separate iframe.
			const subAgentTabs = collectSubAgentTabs(data.entries as Record<string, unknown>[])

			// Inject host/config launch metadata as a top-level `hostMetadata`
			// key. Naturally idempotent: reassigning the same primitives.
			const metadata = getSessionStartMetadata()
			if (metadata) {
				data.hostMetadata = {
					os: metadata.os,
					config: metadata.config,
					capturedAt: metadata.capturedAt,
				}
			}

			// Append buffered config-change events as custom entries. Idempotent:
			// deterministic ids are de-duped against existing entry ids.
			const changes = getConfigChanges()
			if (changes.length > 0) {
				const entries = data.entries as Array<Record<string, unknown>>
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

			const modified = JSON.stringify(data)
			const modifiedBase64 = Buffer.from(modified).toString("base64")
			html = html.replace(
				/<script id="session-data" type="application\/json">[\s\S]*?<\/script>/,
				`<script id="session-data" type="application/json">${modifiedBase64}</script>`,
			)

			// Inject sub-agent tabs: each sub-agent with a transcript gets its
			// own tab rendered in an iframe using the same upstream template.
			if (subAgentTabs.length > 0 && !html.includes('id="subagent-tabs"')) {
				const dataScripts = subAgentTabs
					.map((tab) => `<script type="application/json" id="subagent-data-${tab.id}">${tab.sessionDataB64}</script>`)
					.join("\n")

				const tabBar = `<div id="sa-header" style="position:fixed;top:0;left:0;width:100%;z-index:1000">\n<div id="subagent-tabs" style="display:flex;gap:0;border-bottom:1px solid #333;background:#1a1a2e;padding:0 0.5rem;box-sizing:border-box">\n<button class="sa-tab sa-tab-main" data-sa-id="main" onclick="switchToMainSession()" style="padding:0.4rem 0.8rem;background:none;border:none;border-bottom:2px solid #4a9;color:#4a9;cursor:pointer;font-size:0.8rem">Main Session</button>\n${subAgentTabs
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
				html = appendBeforeBody(html, `${dataScripts}\n${switchScript}`)
			}
		}
	}

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

	writeFileSync(filePath, html, "utf-8")
}

/**
 * Decode, redact, and re-encode every base64 JSON payload embedded in
 * matching `<script>` tags. Malformed tags are left unchanged.
 */
async function redactBase64JsonScripts(html: string, pattern: RegExp): Promise<string> {
	const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
	let result = html

	for (const match of result.matchAll(globalPattern)) {
		const fullTag = match[0]
		const base64 = match[1]
		if (!base64?.trim()) continue

		try {
			const json = Buffer.from(base64, "base64").toString("utf-8")
			const data = JSON.parse(json)
			const cleaned = await redactObjectStrings(data)
			const modifiedBase64 = Buffer.from(JSON.stringify(cleaned)).toString("base64")
			result = result.replace(fullTag, fullTag.replace(base64, modifiedBase64))
		} catch {
			// Not valid base64/JSON — pass through unchanged.
		}
	}

	return result
}

/**
 * Redact PII and secrets from an HTML export file.
 *
 * Deep-walks all string values in the base64-encoded `session-data` script
 * and any `subagent-data-*` iframe payloads, then re-encodes them.
 * If no matching script tags are found, the file is left unchanged.
 *
 * API keys/secrets in session transcripts are scrubbed before the
 * transcript leaves the harness.
 */
export async function redactHtmlExport(filePath: string): Promise<void> {
	const html = readFileSync(filePath, "utf-8")
	let redacted = await redactBase64JsonScripts(
		html,
		/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/,
	)
	redacted = await redactBase64JsonScripts(
		redacted,
		/<script type="application\/json" id="subagent-data-[^"]+">([\s\S]*?)<\/script>/,
	)
	if (redacted !== html) {
		writeFileSync(filePath, redacted, "utf-8")
	}
}
