/**
 * kimchi memory-import: bulk-load facts into the memory store.
 *
 * Reads a JSONL file of {"fact": "<text>"} records and adds each fact
 * through the extension's own store path — the same mem0 backend and
 * embeddings as organic capture, so the schema stays compatible by
 * construction. The benchmark's oracle-capture arm uses this to load
 * ground-truth facts directly, isolating retrieval quality from capture
 * quality. Facts import verbatim: no extraction, no supersede pass.
 *
 * Usage: kimchi memory-import --facts <file.jsonl> [--scope personal|project] [--cwd <dir>]
 *
 * JSONL format: one JSON object per line, each with a non-empty "fact"
 * string. Extra fields are ignored. Blank lines are skipped.
 */
import { readFileSync } from "node:fs"
import { createMemoryBackend, projectDbPath } from "./backend.js"
import { digestDbPath, MEMORY_USER_ID } from "./config.js"
import { resolveProjectScope } from "./scope.js"

export interface ImportFact {
	fact: string
}

export interface ImportOptions {
	scope: "personal" | "project"
	cwd: string
}

/**
 * Minimal backend surface the importer needs. Structural: the mem0 Memory
 * instance from createMemoryBackend satisfies it (same shape the capture
 * worker's CaptureBackend relies on for add).
 */
export interface ImportBackend {
	add(fact: string, options: { userId: string; infer: boolean }): Promise<unknown>
}

const defaultImportBackend = (dbPath: string): Promise<ImportBackend> => createMemoryBackend({ dbPath })

export interface ParsedImportArgs extends ImportOptions {
	factsFile?: string
}

export function parseImportArgs(argv: string[]): ParsedImportArgs {
	let factsFile: string | undefined
	let scope: "personal" | "project" = "personal"
	let cwd: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--facts") {
			factsFile = argv[++i]
		} else if (arg === "--scope") {
			const value = argv[++i]
			if (value !== "personal" && value !== "project") {
				throw new Error(`--scope must be "personal" or "project", got ${JSON.stringify(value)}`)
			}
			scope = value
		} else if (arg === "--cwd") {
			cwd = argv[++i]
		} else {
			throw new Error(`unknown argument: ${JSON.stringify(arg)}`)
		}
	}
	return { factsFile, scope, cwd: cwd ?? process.cwd() }
}

export function parseFactsJsonl(content: string): ImportFact[] {
	const facts: ImportFact[] = []
	for (const [index, line] of content.split("\n").entries()) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			throw new Error(`line ${index + 1}: invalid JSON`)
		}
		const fact = typeof parsed === "object" && parsed !== null ? (parsed as { fact?: unknown }).fact : undefined
		if (typeof fact !== "string" || !fact.trim()) {
			throw new Error(`line ${index + 1}: each record must be {"fact": "<non-empty string>"}`)
		}
		facts.push({ fact })
	}
	return facts
}

export function importDbPath(options: ImportOptions): string {
	if (options.scope === "personal") return digestDbPath()
	const project = resolveProjectScope(options.cwd)
	if (!project) {
		throw new Error(`project scope requires a git repository at ${options.cwd} (or --cwd pointing into one)`)
	}
	return projectDbPath(project.id)
}

export async function importFacts(
	facts: readonly ImportFact[],
	options: ImportOptions,
	createBackend: (dbPath: string) => Promise<ImportBackend> = defaultImportBackend,
): Promise<number> {
	const backend = await createBackend(importDbPath(options))
	for (const { fact } of facts) {
		await backend.add(fact, { userId: MEMORY_USER_ID, infer: false })
	}
	return facts.length
}

export async function runImportMain(argv: string[]): Promise<number> {
	try {
		const options = parseImportArgs(argv)
		if (!options.factsFile) throw new Error("--facts <file.jsonl> is required")
		const content = readFileSync(options.factsFile, "utf-8")
		const facts = parseFactsJsonl(content)
		if (facts.length === 0) {
			console.error(`[memory-import] no facts found in ${options.factsFile}`)
			return 1
		}
		const added = await importFacts(facts, options)
		console.log(`[memory-import] imported ${added} fact(s) into the ${options.scope} store`)
		return 0
	} catch (err: unknown) {
		console.error("[memory-import] failed:", err instanceof Error ? err.message : err)
		return 1
	}
}
