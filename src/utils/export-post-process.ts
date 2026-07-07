import { readFileSync, writeFileSync } from "node:fs"
import { redactObjectStrings } from "../extensions/pii-redaction/redactor.js"
import { getVersion } from "../utils.js"
import { redactDeep, redactEntries, redactSessionData } from "./export-redact.js"
import { enrichSubAgentEntries } from "./export-subagents.js"
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

	// Parse entries for enrichment and redaction
	const parsedEntries = traceInjected.map((l) => JSON.parse(l) as Record<string, unknown>)

	// Enrich sub-agent records with full transcripts from .output files
	enrichSubAgentEntries(parsedEntries)

	// Redact secrets across all entries (messages, tool calls, results, transcripts)
	redactEntries(parsedEntries)

	// Redact the session header too (may contain cwd with credential paths)
	if (parsedEntries.length > 0) {
		redactDeep(parsedEntries[0])
	}

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

			// Enrich sub-agent records with full transcripts from .output files
			enrichSubAgentEntries(data.entries as Record<string, unknown>[])

			// Redact secrets across the entire session data
			// (messages, tool calls, results, transcripts, systemPrompt, tools)
			redactSessionData(data)

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
        for (var i = 0; i < entriesWithTraceIds.length; i++) {
            var entry = entriesWithTraceIds[i];
            var el = document.getElementById('entry-' + entry.id);
            if (!el) continue;
            if (el.querySelector('.trace-ids')) continue;
            var d = document.createElement('div');
            d.className = 'trace-ids';
            d.textContent = 'Trace IDs: ' + entry.traceIds.join(', ');
            d.style.cssText = 'font-size:0.75rem;color:#666;margin-top:0.25rem;font-family:monospace';
            el.appendChild(d);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else { inject(); }
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
    var cfg = data.hostMetadata.config || {};
    if (cfg['config.multi_model_enabled']) parts.push('Multimodel: on');
    var orch = cfg['config.model_roles.orchestrator'];
    if (orch) parts.push('Orchestrator: ' + orch);
    container.textContent = parts.join(' · ');
    var body = document.body || document.documentElement;
    body.insertBefore(container, body.firstChild);
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

	// Inject the sub-agent transcript renderer script before </body> (idempotent).
	if (!html.includes('id="subagent-renderer"')) {
		const subagentScript = `<script id="subagent-renderer">
(function() {
    var el = document.getElementById('session-data');
    if (!el) return;
    var base64 = el.textContent;
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    if (!data.entries) return;
    var subagentEntries = [];
    for (var i = 0; i < data.entries.length; i++) {
        var e = data.entries[i];
        if (e.type === 'custom' && e.customType === 'subagents:record' && e.data && e.data.transcript) {
            subagentEntries.push(e);
        }
    }
    if (subagentEntries.length === 0) return;
    function inject() {
        for (var i = 0; i < subagentEntries.length; i++) {
            var entry = subagentEntries[i];
            var entryEl = document.getElementById('entry-' + entry.id);
            if (!entryEl) continue;
            if (entryEl.querySelector('.subagent-transcript')) continue;
            var details = document.createElement('details');
            details.className = 'subagent-transcript';
            details.style.cssText = 'margin-top:0.5rem;border:1px solid #444;border-radius:4px;padding:0.5rem;font-size:0.85rem';
            var summary = document.createElement('summary');
            summary.style.cssText = 'cursor:pointer;font-weight:bold;color:#aaa';
            var duration = '';
            if (entry.data.startedAt && entry.data.completedAt) {
                var dur = Math.round((entry.data.completedAt - entry.data.startedAt) / 1000);
                duration = ' (' + dur + 's)';
            }
            summary.textContent = 'Sub-agent: ' + (entry.data.type || 'unknown') + ' — ' + (entry.data.status || 'unknown') + duration;
            details.appendChild(summary);
            var transcript = entry.data.transcript;
            for (var j = 0; j < transcript.length; j++) {
                var t = transcript[j];
                var div = document.createElement('div');
                div.style.cssText = 'margin:0.25rem 0;padding-left:0.5rem;border-left:2px solid #333;font-size:0.8rem';
                var role = t.type || 'unknown';
                var text = '';
                if (t.message && t.message.content) {
                    if (typeof t.message.content === 'string') text = t.message.content;
                    else if (Array.isArray(t.message.content)) {
                        for (var k = 0; k < t.message.content.length; k++) {
                            var block = t.message.content[k];
                            if (block.text) text += block.text + ' ';
                            else if (block.type === 'toolCall') text += '[tool: ' + block.name + '] ';
                        }
                    }
                }
                div.textContent = '[' + role + '] ' + text.substring(0, 500) + (text.length > 500 ? '...' : '');
                details.appendChild(div);
            }
            entryEl.appendChild(details);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else { inject(); }
})();
</script>`
		html = appendBeforeBody(html, subagentScript)
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
        for (var i = 0; i < diagEntries.length; i++) {
            var entry = diagEntries[i];
            var entryEl = document.getElementById('entry-' + entry.id);
            if (!entryEl) continue;
            if (entryEl.querySelector('.request-diagnostics')) continue;
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else { inject(); }
})();
</script>`
		html = appendBeforeBody(html, diagnosticsScript)
	}

	writeFileSync(filePath, html, "utf-8")
}

/**
 * Redact PII and secrets from an HTML export file.
 *
 * Finds the base64-encoded session-data script tag, decodes it, deep-walks
 * all string values redacting PII/secrets, re-encodes, and writes back.
 * If the session-data tag is not found, the file is left unchanged.
 *
 * API keys/secrets in session transcripts are scrubbed before the
 * transcript leaves the harness.
 */
export async function redactHtmlExport(filePath: string): Promise<void> {
	let html = readFileSync(filePath, "utf-8")
	const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
	if (!match) return
	const base64 = match[1]
	const json = Buffer.from(base64, "base64").toString("utf-8")
	const data = JSON.parse(json)
	const cleaned = await redactObjectStrings(data)
	const modified = JSON.stringify(cleaned)
	const modifiedBase64 = Buffer.from(modified).toString("base64")
	html = html.replace(
		/<script id="session-data" type="application\/json">[\s\S]*?<\/script>/,
		`<script id="session-data" type="application/json">${modifiedBase64}</script>`,
	)
	writeFileSync(filePath, html, "utf-8")
}
