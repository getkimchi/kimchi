/**
 * `xlsx.mjs` — command-line entry for the bundled xlsx skill, same posture
 * as docx.mjs: runs under the kimchi binary (Bun) and plain node.
 *
 *   xlsx.mjs read <file.xlsx|file.csv> [--sheet S] [--start-row N] [--end-row N]
 *                  [--max-chars N] [--show-formulas]
 *   xlsx.mjs info <file.xlsx|file.xlsm>  sheet list, sizes, macros/links notes
 *   xlsx.mjs create <spec.json> --out <out.xlsx>
 *                                        build a workbook from a spec (never in place)
 */

import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { RealClock } from "./clock.js"
import { extractCsv, extractXlsx, type XlsxExtraction } from "./extractors/xlsx.js"
import { maxFileBytes } from "./limits.js"
import { DocumentError, isDocumentError } from "./model.js"
import { sameFile } from "./paths.js"
import { writeXlsx, type XlsxSpec } from "./writers/xlsx.js"

export interface CliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	writeFile?: (path: string, data: Uint8Array) => void
}

const USAGE = `usage: xlsx.mjs <command> [args]

commands:
  read <file.xlsx|file.csv> [--sheet S] [--start-row N] [--end-row N] [--max-chars N] [--show-formulas]
                                                  one sheet as a Markdown table, windowed by rows (≤50 KB/call)
  info <file.xlsx|file.xlsm>                    sheets (names, hidden state, dimensions), macros/links notes
  create <spec.json> --out <out.xlsx>           build a workbook from a JSON spec (never in place)`

function readBytes(io: Required<CliIo>["readFile"], path: string): Uint8Array {
	try {
		return io(path)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot read ${path}: ${(err as Error).message}`)
	}
}

function enforceSizeCap(path: string, data: Uint8Array): void {
	const cap = maxFileBytes()
	if (data.length > cap) {
		throw new DocumentError(
			"too-large",
			`${path} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with KIMCHI_DOCUMENT_MAX_MB.`,
			"xlsx",
		)
	}
}

function flagValue(flags: string[], name: string): string | undefined {
	const i = flags.indexOf(name)
	return i >= 0 ? flags[i + 1] : undefined
}

function flagsUsed(flags: string[]): string[] {
	return flags.filter((f) => f.startsWith("--"))
}

async function load(input: string, data: Uint8Array): Promise<XlsxExtraction> {
	const lower = input.toLowerCase()
	if (lower.endsWith(".csv")) {
		return extractCsv(new TextDecoder().decode(data))
	}
	if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
		throw new DocumentError("corrupt", `expected .xlsx, .xlsm or .csv — got ${input}`, "xlsx")
	}
	return extractXlsx(data)
}

/** Sheet selector: 1-based number or exact name. */
function selectSheet(selector: string | undefined): number | string {
	if (selector === undefined) return 1
	return /^\d+$/.test(selector) ? Number(selector) : selector
}

export async function runXlsxCli(argv: string[], io: CliIo): Promise<number> {
	const readFile = io.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
	const [command, ...args] = argv
	try {
		switch (command) {
			case "read": {
				const [path, ...flags] = args
				if (!path) throw new DocumentError("corrupt", "read needs a file: xlsx.mjs read <file.xlsx|file.csv> [flags]")
				const known = ["--sheet", "--start-row", "--end-row", "--max-chars", "--show-formulas"]
				for (const f of flagsUsed(flags)) {
					if (!known.includes(f)) throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`)
				}
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const doc = await load(path, data)
				const parseRowFlag = (name: string): number | undefined => {
					const v = flagValue(flags, name)
					if (v === undefined) return undefined
					const n = Number.parseInt(v, 10)
					if (!Number.isFinite(n) || n < 1) throw new DocumentError("corrupt", `${name} wants a positive integer, got ${v}`)
					return n
				}
				const w = doc.window({
					sheet: selectSheet(flagValue(flags, "--sheet")),
					startRow: parseRowFlag("--start-row"),
					endRow: parseRowFlag("--end-row"),
					maxChars: parseRowFlag("--max-chars"),
					showFormulas: flags.includes("--show-formulas"),
				})
				io.stdout(`# ${path} — sheet "${w.sheet}" rows ${w.fromRow}-${w.toRow}${w.truncated ? " (truncated, continue with --start-row)" : ""}\n\n${w.markdown}`)
				for (const note of doc.notes) io.stderr(`note: ${note}`)
				return 0
			}
			case "info": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "info needs a file: xlsx.mjs info <file.xlsx|file.xlsm>")
				if (args.length > 1) throw new DocumentError("corrupt", `info takes exactly one file (${args.slice(1).join(" ")}?)`)
				const lower = path.toLowerCase()
				if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
					throw new DocumentError("corrupt", `info expects .xlsx/.xlsm, got ${path}`, "xlsx")
				}
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const doc = await extractXlsx(data)
				const lines = [`${path} (${doc.format})`]
				for (const [i, s] of doc.sheets.entries()) {
					lines.push(
						`  sheet ${i + 1}: ${JSON.stringify(s.name)}${s.state !== "visible" ? ` (${s.state})` : ""} — ${s.lastRow} rows × ${s.lastColumn} columns`,
					)
				}
				if (doc.info.date1904) lines.push("date system: 1904")
				if (doc.info.hasMacros) lines.push("macros: yes (vbaProject.bin) — preserved untouched by edits")
				if (doc.info.hasExternalLinks) lines.push("external links: yes — never recalculated")
				io.stdout(lines.join("\n"))
				return 0
			}
			case "create": {
				const [specPath, ...flags] = args
				if (!specPath)
					throw new DocumentError("corrupt", "create needs a spec: xlsx.mjs create <spec.json> --out <out.xlsx>")
				const known = ["--out", "--force"]
				for (const f of flagsUsed(flags)) {
					if (!known.includes(f)) throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`)
				}
				const out = flagValue(flags, "--out")
				if (!out) throw new DocumentError("corrupt", "create needs --out <out.xlsx> — never writes in place")
				if (sameFile(out, specPath)) throw new DocumentError("corrupt", "--out must differ from the spec", "xlsx")
				if (!out.toLowerCase().endsWith(".xlsx"))
					throw new DocumentError("corrupt", `output path must end in .xlsx: ${out}`, "xlsx")
				let spec: XlsxSpec
				try {
					spec = JSON.parse(new TextDecoder().decode(readBytes(readFile, specPath))) as XlsxSpec
				} catch {
					throw new DocumentError("corrupt", `spec is not valid JSON: ${specPath}`, "xlsx")
				}
				const { bytes, warnings, formulas } = await writeXlsx(spec, { clock: RealClock })
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				io.stdout(
					`created ${out} (${spec.sheets.length} sheet(s)${formulas > 0 ? `, ${formulas} formula(s)` : ""})`,
				)
				for (const warning of warnings) io.stderr(`warning: ${warning}`)
				return 0
			}
			case undefined:
			case "--help":
			case "-h":
				io.stdout(USAGE)
				return command === undefined ? 2 : 0
			default:
				io.stderr(`unknown command "${command}"\n\n${USAGE}`)
				return 2
		}
	} catch (err) {
		if (isDocumentError(err)) {
			io.stderr(`error [${err.code}]: ${err.message}`)
			return 2
		}
		throw err
	}
}

/** Write via temp + rename so an interrupted create never leaves a half file. */
function atomicWrite(path: string, data: Uint8Array): void {
	const temp = `${path}.xlsx-mjs-tmp.${process.pid}.${++atomicWriteCounter}`
	try {
		writeFileSync(temp, data)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot write ${path}: ${(err as Error).message}`)
	}
	try {
		renameSync(temp, path)
	} catch (err) {
		try {
			unlinkSync(temp)
		} catch {
			// temp reclaim
		}
		throw new DocumentError("corrupt", `Cannot move output into place at ${path}: ${(err as Error).message}`)
	}
}

let atomicWriteCounter = 0

const invokedAsScript = (() => {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return realpathSync(entry) === fileURLToPath(import.meta.url)
	} catch {
		return false
	}
})()

if (invokedAsScript) {
	runXlsxCli(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	}).then((code) => {
		process.exitCode = code
	})
}
