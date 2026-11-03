#!/usr/bin/env bun
/**
 * Redaction shadow-mode: measure per-entity detection volume on a real
 * session corpus WITHOUT touching live redaction.
 *
 * For each .jsonl transcript in the window, every string field is scanned by
 * two policies and the results are aggregated as **unique span counts**
 * (entity × sha256(span) × file) — never raw occurrences, so one repeated
 * FP string can't drown the numbers — and **literal-marker netted**, so
 * `[REDACTED-X]` text already present in the input (quoted docs, tests) is
 * not counted as a fresh detection.
 *
 * Policies compared:
 *   - legacy:  exclusions=[GUID] (pre-tier behavior)
 *   - tiered:  registry defaults (bare-shape excluded, anchored re-added)
 *
 * Usage:
 *   bun scripts/redaction-shadow.ts [--days N] [--dir PATH] [--verbose]
 *
 * Output: a markdown table to stdout. No transcript content is printed —
 * only counts, entity types, and truncated span hashes.
 *
 * Dev tooling (not shipped in the binary): run directly with bun.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getDefaultExcludedEntities } from "../src/extensions/pii-redaction/entity-tiers.js"
import {
	applyCustomPatterns,
	collectDetections,
	composeRedactedText,
	createRedactionEngine,
} from "../src/extensions/pii-redaction/redactor.js"

// ---------------------------------------------------------------------------

interface Options {
	days: number
	dir: string
	verbose: boolean
}

function parseArgs(argv: string[]): Options {
	const opts: Options = {
		days: 7,
		dir: resolve(homedir(), ".config", "kimchi", "harness", "sessions"),
		verbose: false,
	}
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--days") opts.days = Number(argv[++i])
		else if (argv[i] === "--dir") opts.dir = resolve(argv[++i] as string)
		else if (argv[i] === "--verbose") opts.verbose = true
	}
	if (!Number.isFinite(opts.days) || opts.days <= 0) throw new Error("--days must be a positive number")
	return opts
}

/** Policy identity: which exclusion list runs at engine level. */
interface Policy {
	name: string
	excluded: string[]
}

/** Unique-span tally: spanHash → { entity, files:Set, occurrences } */
type Tally = Map<string, { entity: string; files: Set<string>; occurrences: number }>

const MARKER_LITERAL = /\[REDACTED-[A-Z0-9_]+\]/g

function spanHash(text: string): string {
	return createHash("sha256").update(text).digest("base64url").slice(0, 12)
}

/** Deep-walk any JSON value and emit every string (session lines are JSON). */
function* walkStrings(value: unknown): Generator<string> {
	if (typeof value === "string") {
		yield value
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) yield* walkStrings(item)
		return
	}
	if (value !== null && typeof value === "object") {
		for (const v of Object.values(value as Record<string, unknown>)) yield* walkStrings(v)
	}
}

function record(tally: Tally, entity: string, span: string, file: string): void {
	const h = spanHash(span)
	const entry = tally.get(h)
	if (entry) {
		entry.occurrences += 1
		entry.files.add(file)
	} else {
		tally.set(h, { entity, files: new Set([file]), occurrences: 1 })
	}
}

function* sessionFiles(dir: string, cutoffMs: number): Generator<string> {
	let entries: string[]
	try {
		entries = readdirSync(dir)
	} catch {
		return
	}
	for (const entry of entries) {
		const path = join(dir, entry)
		try {
			const st = statSync(path)
			if (st.isDirectory()) {
				yield* sessionFiles(path, cutoffMs)
			} else if (entry.endsWith(".jsonl") && st.mtimeMs >= cutoffMs) {
				yield path
			}
		} catch {
			// unreadable entry — skip
		}
	}
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2))
	const cutoff = Date.now() - opts.days * 24 * 60 * 60 * 1000

	const policies: Policy[] = [
		{ name: "legacy", excluded: ["GUID"] },
		{ name: "tiered", excluded: getDefaultExcludedEntities() },
	]
	const engines = new Map<string, ReturnType<typeof createRedactionEngine>>(
		policies.map((p) => [p.name, createRedactionEngine(p.excluded)]),
	)
	const tallies = new Map<string, Tally>(policies.map((p) => [p.name, new Map()]))

	let files = 0
	let strings = 0
	for (const file of sessionFiles(opts.dir, cutoff)) {
		files++
		let text: string
		try {
			text = readFileSync(file, "utf8")
		} catch {
			continue
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue
			let strings_: string[]
			try {
				strings_ = [...walkStrings(JSON.parse(line))]
			} catch {
				strings_ = [line]
			}
			for (const s of strings_) {
				strings++
				// Heritage markers are data, not detections: record them as
				// literals, then blank them so fresh detections can't span across.
				const netted = s.replace(MARKER_LITERAL, (literal) => {
					for (const tally of tallies.values()) record(tally, literal.slice(10, -1), literal, file)
					return " "
				})
				for (const policy of policies) {
					const engine = engines.get(policy.name) as ReturnType<typeof createRedactionEngine>
					const excluded = new Set(policy.excluded)
					const tally = tallies.get(policy.name) as Tally
					const kept = await collectDetections(netted, engine, excluded)
					for (const d of kept) record(tally, d.entityType, d.text, file)
					applyCustomPatterns(composeRedactedText(netted, kept), new Set(), (m) =>
						record(tally, m.name, m.secret, file),
					)
				}
			}
		}
	}

	// Aggregate per entity: unique spans, files, occurrences.
	interface EntityRow {
		uniqueSpans: number
		files: number
		occurrences: number
		literals: number
	}
	function aggregate(tally: Tally): Map<string, EntityRow> {
		const rows = new Map<string, EntityRow>()
		for (const entry of tally.values()) {
			const row = rows.get(entry.entity) ?? { uniqueSpans: 0, files: 0, occurrences: 0, literals: 0 }
			row.uniqueSpans += 1
			row.files = Math.max(row.files, entry.files.size)
			row.occurrences += entry.occurrences
			rows.set(entry.entity, row)
		}
		return rows
	}

	const legacyRows = aggregate(tallies.get("legacy") as Tally)
	const tieredRows = aggregate(tallies.get("tiered") as Tally)
	const entities = [...new Set([...legacyRows.keys(), ...tieredRows.keys()])].sort(
		(a, b) =>
			(tieredRows.get(b)?.uniqueSpans ?? 0) +
			(legacyRows.get(b)?.uniqueSpans ?? 0) -
			((tieredRows.get(a)?.uniqueSpans ?? 0) + (legacyRows.get(a)?.uniqueSpans ?? 0)),
	)

	console.log(`# Redaction shadow report`)
	console.log()
	console.log(`Corpus: \`${opts.dir}\`, ${files} files, ${strings} strings, last ${opts.days} day(s).`)
	console.log(`Counts are unique spans (entity × hash × file); marker-shaped literals netted out.`)
	console.log()
	console.log(`| Entity | legacy unique | tiered unique | Δ | legacy occ | tiered occ |`)
	console.log(`|---|---|---|---|---|---|`)
	for (const entity of entities) {
		const l = legacyRows.get(entity)
		const t = tieredRows.get(entity)
		const lu = l?.uniqueSpans ?? 0
		const tu = t?.uniqueSpans ?? 0
		const delta = tu - lu
		console.log(
			`| ${entity} | ${lu} | ${tu} | ${delta > 0 ? "+" : ""}${delta} | ${l?.occurrences ?? 0} | ${t?.occurrences ?? 0} |`,
		)
		if (opts.verbose) {
			for (const [h, entry] of tallies.get("tiered") as Tally) {
				if (entry.entity === entity) console.log(`  - span ${h} ×${entry.occurrences} in ${entry.files.size} file(s)`)
			}
		}
	}
	const totL = [...legacyRows.values()].reduce((a, r) => a + r.uniqueSpans, 0)
	const totT = [...tieredRows.values()].reduce((a, r) => a + r.uniqueSpans, 0)
	console.log(`| **TOTAL** | ${totL} | ${totT} | ${totT - totL > 0 ? "+" : ""}${totT - totL} | | |`)
}

await main()
