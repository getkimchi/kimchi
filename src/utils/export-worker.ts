/**
 * Offload the export post-processing pipeline to a child process.
 *
 * The 10s-class redaction pass used to run synchronously on the TUI main
 * event loop, freezing the harness for the duration. This module runs the
 * single-pass pipeline in a child instead: the parent stays responsive
 * (upstream generation still runs inline — see the plan's offload boundary),
 * and a worker crash triggers the same ownership-scoped cleanup via the
 * parent's `runSecureExport` error path.
 *
 * The parent owns the `runSecureExport` lifecycle (resolution, temp
 * creation, publish, cleanup); the worker only transforms the pre-created
 * private temp file in place.
 *
 * Runtime routing mirrors the memory-capture pattern: under `bun run`
 * (dev) the worker script is executed directly; in compiled binaries
 * process.execPath is the kimchi binary itself and cli.ts routes the
 * `export-worker` subcommand to the same main.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getAgentConfig, getUserAgentNames } from "../extensions/agents/personas/agent-types.js"
import type { ExportMode, ExportPipelineOptions } from "./export-post-process.js"
import { postProcessHtmlExportOnce, postProcessJsonlExportOnce } from "./export-post-process.js"
import { getConfigChanges, getSessionStartMetadata } from "./session-metadata-store.js"

/** What the worker needs to run the pipeline: mode + the pre-created private temp file. */
export interface ExportOffloadOptions {
	mode: ExportMode
	/** The pre-created private temp file to transform in place. */
	filePath: string
	/** Live system prompt at export time (JSONL header injection). */
	systemPrompt?: string
}

/** The pipeline state serialized to the worker — the in-process facts, which the child cannot see. */
type ExportWorkerState = ExportPipelineOptions

/**
 * Persona fallback prompts from the live registry — user-defined agents
 * (`.kimchi/agents`) are registered only in the exporting process, so the
 * worker child would otherwise fall back to built-in defaults for
 * sub-records without a persisted system prompt. Keys are lowercased agent
 * types; built-in defaults resolve identically in the child and are not
 * serialized. Empty-string prompts ARE serialized: a user persona may
 * deliberately blank a prompt, and the nullish (??) fallback chain treats
 * "" as a present value — omitting it would diverge from the inline path.
 */
function collectAgentSystemPrompts(): Record<string, string> | undefined {
	const prompts: Record<string, string> = {}
	for (const name of getUserAgentNames()) {
		const prompt = getAgentConfig(name)?.systemPrompt
		if (typeof prompt === "string") {
			prompts[name.toLowerCase()] = prompt
		}
	}
	return Object.keys(prompts).length > 0 ? prompts : undefined
}

/**
 * Build the child command for the given worker argv.
 *
 * Dev (`bun run`): execute the worker script directly. Compiled binary:
 * process.execPath is the kimchi binary itself; the worker is routed as the
 * `export-worker` subcommand (cli.ts).
 */
export function buildExportWorkerCommand(args: string[]): { command: string; args: string[] } {
	if (basename(process.execPath) === "bun") {
		return {
			command: process.execPath,
			args: [fileURLToPath(new URL("./export-worker-main.ts", import.meta.url)), ...args],
		}
	}
	return { command: process.execPath, args: ["export-worker", ...args] }
}

/**
 * Write the worker state JSON next to the export temp: a private (0600)
 * dotfile that may carry the live system prompt, unlinked by the worker as
 * soon as it is read. Writing into the exclusively pre-created file keeps the
 * mode (POSIX create-mode applies only at creation).
 */
function writeWorkerStateFile(exportFilePath: string, state: ExportWorkerState): string {
	const statePath = join(
		dirname(exportFilePath),
		`.${basename(exportFilePath)}.state-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
	)
	closeSync(openSync(statePath, "wx", 0o600))
	writeFileSync(statePath, JSON.stringify(state), "utf-8")
	return statePath
}

/** Test seam: allow tests to substitute the child command builder. */
export interface ExportOffloadDeps {
	/** Override the command builder (defaults to `buildExportWorkerCommand`). Receives the full worker argv. */
	buildCommand?: (args: string[]) => { command: string; args: string[] }
}

/**
 * Run the single-pass pipeline for `options.filePath` in a child process.
 * Resolves on exit 0; rejects with the worker's stderr on any non-zero exit
 * (fail-closed: a pipeline failure must abort the export). A spawn `error`
 * event (e.g. ENOENT — the child never started) is the one fallback: it
 * warns and runs the inline pipeline instead, restoring today's behavior.
 */
export async function runExportOffloaded(options: ExportOffloadOptions, deps: ExportOffloadDeps = {}): Promise<void> {
	// Serialize the in-process state the child cannot see: live system prompt,
	// launch metadata, buffered config changes, and the user persona registry.
	const state: ExportWorkerState = {
		systemPrompt: options.systemPrompt,
		metadata: getSessionStartMetadata(),
		configChanges: [...getConfigChanges()],
		agentSystemPrompts: collectAgentSystemPrompts(),
	}
	const statePath = writeWorkerStateFile(options.filePath, state)

	const runInline = async (): Promise<void> => {
		if (options.mode === "html") {
			await postProcessHtmlExportOnce(options.filePath, state)
		} else {
			await postProcessJsonlExportOnce(options.filePath, state)
		}
	}

	try {
		const buildCommand = deps.buildCommand ?? buildExportWorkerCommand
		const built = buildCommand(["--mode", options.mode, "--file", options.filePath, "--state", statePath])

		// Resolves true when the child completed the pipeline, false when the
		// spawn itself failed (fallback); rejects when the child ran and failed.
		const childRan = await new Promise<boolean>((resolvePromise, rejectPromise) => {
			const child: ChildProcess = spawn(built.command, built.args, {
				stdio: ["ignore", "ignore", "pipe"],
			})
			const stderrChunks: Buffer[] = []
			child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
			child.on("error", (err) => {
				// Spawn failure (e.g. ENOENT): the child never ran — fall back to
				// the inline pipeline, today's behavior. Warn loudly: the fallback
				// re-introduces the multi-second event-loop block this offload
				// exists to remove.
				console.error(
					"[export] worker spawn failed — running the export pipeline inline (the harness may block briefly):",
					err instanceof Error ? err.message : err,
				)
				resolvePromise(false)
			})
			child.on("close", (code) => {
				if (code === 0) {
					resolvePromise(true)
					return
				}
				const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim()
				rejectPromise(new Error(stderr || `export worker exited with code ${code ?? "unknown"} (mode=${options.mode})`))
			})
		})

		if (!childRan) {
			await runInline()
		}
	} finally {
		// The state file may carry the live system prompt — never outlive the run.
		try {
			unlinkSync(statePath)
		} catch {
			// Best-effort: the worker normally already unlinked it.
		}
	}
}
