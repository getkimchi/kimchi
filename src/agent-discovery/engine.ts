import { existsSync, readFileSync, readdirSync } from "node:fs"
import type { ServerEntry } from "../extensions/mcp-adapter/types.js"
import type { AgentDefinition, AgentDiscovery } from "./index.js"

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function hasBearerAuthorizationHeader(headers: unknown): boolean {
	// Defensive: `headers` comes from arbitrary parsed JSON and may be null,
	// an array, or a primitive at runtime even though the call sites cast it
	// to Record<string, string>. Treat anything that isn't a plain object as
	// "no bearer header" rather than crashing the discovery pass.
	if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return false
	return Object.entries(headers as Record<string, unknown>).some(
		([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string" && v.toLowerCase().startsWith("bearer "),
	)
}

function ingest(
	into: Record<string, ServerEntry>,
	block: unknown,
	transform: AgentDefinition["transformServer"],
): void {
	if (!block || typeof block !== "object" || Array.isArray(block)) return
	let entries: Record<string, unknown>
	let meta: unknown
	const maybeWrapped = block as { entries?: unknown; meta?: unknown }
	if (
		maybeWrapped.entries !== undefined &&
		typeof maybeWrapped.entries === "object" &&
		maybeWrapped.entries !== null &&
		!Array.isArray(maybeWrapped.entries)
	) {
		entries = maybeWrapped.entries as Record<string, unknown>
		meta = maybeWrapped.meta
	} else {
		entries = block as Record<string, unknown>
		meta = undefined
	}
	for (const [name, raw] of Object.entries(entries)) {
		if (into[name]) continue
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
		const entry = transform(raw, name, meta)
		if (entry) into[name] = entry
	}
}

export function discoverAgent(def: AgentDefinition): AgentDiscovery {
	const parse = def.parseConfig ?? JSON.parse
	const mcpServers: Record<string, ServerEntry> = {}

	for (const path of def.configPaths) {
		let raw: string
		try {
			raw = readFileSync(path, "utf-8")
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Failed to read ${def.displayName} config at ${path}: ${msg(err)}`)
			}
			continue
		}
		let parsed: unknown
		try {
			parsed = parse(raw)
		} catch (err) {
			console.warn(`Failed to parse ${def.displayName} config at ${path}: ${msg(err)}`)
			continue
		}
		const sources = def.extractServerSources(parsed)
		for (const block of sources) ingest(mcpServers, block, def.transformServer)
		// Continue: every readable + parseable file in configPaths contributes
		// its servers. ingest() does first-writer-wins per server name, so if
		// the same name appears in multiple files, the entry from the earlier
		// file in configPaths is kept and later files' duplicates are skipped.
	}

	let skillCount = 0
	let skillsDir: string | undefined
	for (const dir of def.skillsDirs) {
		if (existsSync(dir)) {
			skillsDir = dir
			try {
				skillCount = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
			} catch (err) {
				console.warn(`Failed to read ${def.displayName} skills directory at ${dir}: ${msg(err)}`)
			}
			break
		}
	}

	return { id: def.id, displayName: def.displayName, mcpServers, skillCount, skillsDir }
}
