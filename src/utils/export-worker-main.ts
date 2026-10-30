/**
 * Export worker subcommand main.
 *
 * argv: `--mode <html|jsonl> --file <path> --state <state.json>`
 *
 * Operates on the given pre-created private temp file (the parent owns the
 * full `runSecureExport` lifecycle — resolution, temp creation, publish,
 * cleanup) and transforms it in place via the single-pass pipeline. The state
 * JSON carries the in-process facts the child cannot see (live system
 * prompt, launch metadata, buffered config changes) and is unlinked as soon
 * as it is read.
 *
 * Mirrors the memory-capture subcommand pattern: in compiled binaries
 * process.execPath is the kimchi binary itself and cli.ts routes
 * `export-worker` here; under `bun run` the worker script is executed
 * directly (see export-worker.ts). Dynamic imports keep the child's startup
 * graph minimal — nothing from the interactive harness loads.
 */

import { readFileSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ConfigChangeRecord, SessionStartMetadata } from "./session-metadata-store.js"

interface ExportWorkerState {
	systemPrompt?: string
	metadata?: SessionStartMetadata
	configChanges?: ReadonlyArray<ConfigChangeRecord>
}

export async function runExportWorkerMain(argv: string[]): Promise<number> {
	const readFlag = (name: string): string | undefined => {
		const index = argv.indexOf(name)
		return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
	}
	const mode = readFlag("--mode")
	const file = readFlag("--file")
	const statePath = readFlag("--state")
	if (!file || !statePath || (mode !== "html" && mode !== "jsonl")) {
		console.error("usage: export-worker --mode <html|jsonl> --file <path> --state <state.json>")
		return 1
	}

	// Read then immediately remove the state file — it may carry the live
	// system prompt, so it must not outlive the worker.
	let state: ExportWorkerState = {}
	try {
		state = JSON.parse(readFileSync(statePath, "utf-8")) as ExportWorkerState
	} finally {
		try {
			unlinkSync(statePath)
		} catch {
			// Best-effort: an unremovable state file is a dotfile in the
			// user's own directory; the worker must still do its job.
		}
	}

	try {
		const { postProcessHtmlExportOnce, postProcessJsonlExportOnce } = await import("./export-post-process.js")
		if (mode === "html") {
			await postProcessHtmlExportOnce(file, state)
		} else {
			await postProcessJsonlExportOnce(file, state)
		}
		return 0
	} catch (err) {
		console.error("[export-worker] pipeline failed:", err)
		return 1
	}
}

// Self-invoke when executed directly by the dev runtime (`bun run
// export-worker-main.ts …`). The argv-comparison form (not import.meta.main)
// mirrors capture-worker.ts: the compile pipeline's cjs wrapper rejects
// surviving import.meta.* and top-level await, and in the compiled binary
// this module is never the main module anyway (kimchi export-worker routes
// via cli.ts).
const isWorkerMain = (() => {
	try {
		return typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
	} catch {
		// Defensive: argv missing / mid-replacement binary state — never treat as main.
		return false
	}
})()
if (isWorkerMain) {
	runExportWorkerMain(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			console.error("[export-worker] failed:", err instanceof Error ? err.message : err)
			process.exit(1)
		},
	)
}
