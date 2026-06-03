import { readFileSync, writeFileSync } from "node:fs"
import { getVersion } from "../utils.js"
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
	const processed = injectTraceIdsIntoExport(lines)

	// Inject version into header line if present.
	if (processed.length > 0) {
		const first = JSON.parse(processed[0]) as Record<string, unknown>
		if (first.type === "header") {
			first.appVersion = getVersion()
			processed[0] = JSON.stringify(first)
		}
	}

	writeFileSync(filePath, `${processed.join("\n")}\n`, "utf-8")
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

	writeFileSync(filePath, html, "utf-8")
}
