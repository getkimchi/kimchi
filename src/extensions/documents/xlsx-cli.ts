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

import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { RealClock } from "./clock.js"
import { applyXlsxOps, type XlsxOp } from "./editors/xlsx.js"
import { extractCsv, extractXlsx, type XlsxExtraction } from "./extractors/xlsx.js"
import { maxFileBytes } from "./limits.js"
import { DocumentError, isDocumentError } from "./model.js"
import { openOoxml } from "./ooxml/package.js"
import { requireNoProblems, validateContentTypes } from "./ooxml/validate.js"
import { sameFile } from "./paths.js"
import { defaultWhich, findSoffice } from "./soffice.js"
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
  create <spec.json> --out <out.xlsx>           build a workbook from a JSON spec (never in place)
  edit <in.xlsx> --out <out.xlsx> --ops <ops.json>   apply ops, never in place
  recalc <in.xlsx> --out <out.xlsx>                recalculate formulas (needs LibreOffice; errors grouped by type)`

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

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]

/** Legacy .xls/.doc/.ppt extensions and the OLE2 container (also the wrapper
 *  of encrypted OOXML) — one typed error instead of a zip parse failure. */
function rejectLegacyOrEncrypted(input: string, data: Uint8Array): void {
	const lower = input.toLowerCase()
	if (lower.endsWith(".xls")) {
		throw new DocumentError(
			"unsupported-format",
			`${input} is a legacy binary spreadsheet (.xls) — convert it first (LibreOffice: soffice --convert-to xlsx "${input}")`,
			"xlsx",
		)
	}
	if (data.length >= 4 && OLE2_MAGIC.every((b, i) => data[i] === b)) {
		throw new DocumentError(
			"unsupported-format",
			`${input} is an OLE2 container — a legacy binary file or an encrypted workbook; open it in Excel/LibreOffice and save unencrypted .xlsx`,
			"xlsx",
		)
	}
}

async function load(input: string, data: Uint8Array): Promise<XlsxExtraction> {
	const lower = input.toLowerCase()
	if (lower.endsWith(".csv")) {
		return extractCsv(new TextDecoder().decode(data))
	}
	rejectLegacyOrEncrypted(input, data)
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
					if (!Number.isFinite(n) || n < 1)
						throw new DocumentError("corrupt", `${name} wants a positive integer, got ${v}`)
					return n
				}
				const w = doc.window({
					sheet: selectSheet(flagValue(flags, "--sheet")),
					startRow: parseRowFlag("--start-row"),
					endRow: parseRowFlag("--end-row"),
					maxChars: parseRowFlag("--max-chars"),
					showFormulas: flags.includes("--show-formulas"),
				})
				io.stdout(
					`# ${path} — sheet "${w.sheet}" rows ${w.fromRow}-${w.toRow}${w.truncated ? " (truncated, continue with --start-row)" : ""}\n\n${w.markdown}`,
				)
				if (w.merged.length > 0) io.stdout(`\nmerged cells on this sheet: ${w.merged.join(", ")}`)
				for (const note of doc.notes) io.stderr(`note: ${note}`)
				return 0
			}
			case "info": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "info needs a file: xlsx.mjs info <file.xlsx|file.xlsm>")
				if (args.length > 1)
					throw new DocumentError("corrupt", `info takes exactly one file (${args.slice(1).join(" ")}?)`)
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
				const known = ["--out"]
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
					const specBytes = readBytes(readFile, specPath)
					enforceSizeCap(specPath, specBytes)
					spec = JSON.parse(new TextDecoder().decode(specBytes)) as XlsxSpec
				} catch {
					throw new DocumentError("corrupt", `spec is not valid JSON: ${specPath}`, "xlsx")
				}
				const { bytes, warnings, formulas } = await writeXlsx(spec, { clock: RealClock })
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				io.stdout(`created ${out} (${spec.sheets.length} sheet(s)${formulas > 0 ? `, ${formulas} formula(s)` : ""})`)
				for (const warning of warnings) io.stderr(`warning: ${warning}`)
				return 0
			}
			case "edit": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError(
						"corrupt",
						"edit needs an input: xlsx.mjs edit <in.xlsx> --out <out.xlsx> --ops <ops.json>",
					)
				const known = ["--out", "--ops"]
				for (const f of flagsUsed(flags)) {
					if (!known.includes(f)) throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`)
				}
				const out = flagValue(flags, "--out")
				const opsPath = flagValue(flags, "--ops")
				if (!out) throw new DocumentError("corrupt", "edit needs --out <out.xlsx> — edits never write in place")
				if (!opsPath) throw new DocumentError("corrupt", "edit needs --ops <ops.json> (a JSON array of ops)")
				if (!input.toLowerCase().endsWith(".xlsx") && !input.toLowerCase().endsWith(".xlsm")) {
					throw new DocumentError("corrupt", `edit expects .xlsx/.xlsm input, got ${input}`, "xlsx")
				}
				if (!out.toLowerCase().endsWith(".xlsx") && !out.toLowerCase().endsWith(".xlsm")) {
					throw new DocumentError("corrupt", `output path must end in .xlsx/.xlsm: ${out}`, "xlsx")
				}
				if (sameFile(out, input))
					throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "xlsx")
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const opsBytes = readBytes(readFile, opsPath)
				enforceSizeCap(opsPath, opsBytes)
				let raw: unknown
				try {
					raw = JSON.parse(new TextDecoder().decode(opsBytes))
				} catch {
					throw new DocumentError("corrupt", `ops file is not valid JSON: ${opsPath}`, "xlsx")
				}
				const ops = parseXlsxOps(raw)
				const pkg = await openOoxml(data)
				const inputProblems = validateContentTypes(pkg, pkg.getXml("[Content_Types].xml"))
				const result = applyXlsxOps(pkg, ops)
				// Fail only on defects WE introduced — third-party packaging quirks are preserved.
				requireNoProblems(
					validateContentTypes(pkg, pkg.getXml("[Content_Types].xml")).filter((p) => !inputProblems.includes(p)),
					`post-edit package validation for ${input} — fix the op and retry; the input is unchanged`,
				)
				const bytes = await pkg.save()
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				const lines = [
					`edited ${input} -> ${out} (${ops.length} op${ops.length === 1 ? "" : "s"} applied)`,
					...result.applied,
				]
				for (const warning of result.warnings) lines.push(`warning: ${warning}`)
				if (result.formulasAlert) {
					lines.push(
						"note: formulas written without cached values — the workbook recalculates on open in Excel/LibreOffice",
					)
				}
				if (result.macrosPreserved) lines.push("note: macros preserved untouched")
				io.stdout(lines.join("\n"))
				return 0
			}
			case "recalc": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError("corrupt", "recalc needs an input: xlsx.mjs recalc <in.xlsx> --out <out.xlsx>")
				const known = ["--out"]
				for (const f of flagsUsed(flags)) {
					if (!known.includes(f)) throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`)
				}
				const out = flagValue(flags, "--out")
				if (!out) throw new DocumentError("corrupt", "recalc needs --out <out.xlsx> — never writes in place")
				if (sameFile(out, input)) throw new DocumentError("corrupt", "--out must differ from the input", "xlsx")
				if (input.toLowerCase().endsWith(".xlsm")) {
					throw new DocumentError(
						"corrupt",
						"recalc of .xlsm loses macros — LibreOffice does not re-save them; export to .xlsx first",
						"xlsx",
					)
				}
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				rejectLegacyOrEncrypted(input, data)
				const soffice = findSoffice(
					{ which: defaultWhich, fileExists: existsSync },
					{ format: "xlsx", commands: "recalc", core: "read/create/edit" },
				)
				const tmpDir = mkdtempSync(join(tmpdir(), "kimchi-xlsx-recalc-"))
				try {
					const staged = join(tmpDir, basename(input))
					writeFileSync(staged, data)
					const run = spawnSync(
						soffice,
						["--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", tmpDir, staged],
						{ timeout: 180_000, killSignal: "SIGKILL" },
					)
					if (run.error) {
						throw new DocumentError(
							"corrupt",
							"LibreOffice timed out after 180s — close every LibreOffice instance and retry",
							"xlsx",
						)
					}
					if (run.status !== 0) {
						throw new DocumentError(
							"corrupt",
							`libreoffice failed (${run.status}): ${String(run.stderr).slice(0, 400)}`,
							"xlsx",
						)
					}
					const converted = new Uint8Array(readFileSync(staged))
					const writeFile = io.writeFile ?? atomicWrite
					writeFile(out, converted)
					const doc = await extractXlsx(converted)
					const errorCounts = new Map<string, number>()
					for (const sheet of doc.sheets) {
						let from = 1
						while (from <= sheet.lastRow) {
							const w = doc.window({ sheet: sheet.name, startRow: from, endRow: sheet.lastRow, maxChars: 4_500_000 })
							for (const m of w.markdown.matchAll(/#(?:REF!|DIV\/0!|NAME\?|VALUE!|NUM!|N\/A|NULL!)/g)) {
								errorCounts.set(m[0], (errorCounts.get(m[0]) ?? 0) + 1)
							}
							if (w.toRow < from) break
							from = w.toRow + 1
						}
					}
					io.stdout(`recalculated ${input} -> ${out} via LibreOffice`)
					if (errorCounts.size > 0) {
						io.stdout(`error cells: ${[...errorCounts.entries()].map(([k, v]) => `${k} ×${v}`).join(", ")}`)
					}
					return 0
				} finally {
					try {
						rmSync(tmpDir, { recursive: true, force: true })
					} catch {
						// temp reclaim
					}
				}
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

const OP_KINDS = [
	"set-cells",
	"clear-range",
	"append-rows",
	"set-column-width",
	"add-sheet",
	"rename-sheet",
	"delete-sheet",
	"fill-formula",
] as const

/** Strict ops validation — messages tell the model the missing/typoed key. */
function parseXlsxOps(raw: unknown): XlsxOp[] {
	if (!Array.isArray(raw)) throw new DocumentError("corrupt", "ops must be a JSON array", "xlsx")
	if (raw.length === 0) throw new DocumentError("corrupt", "ops array is empty", "xlsx")
	return raw.map((op, i) => {
		if (op === null || typeof op !== "object")
			throw new DocumentError("corrupt", `op ${i + 1} is not an object`, "xlsx")
		const kind = (op as { kind?: string }).kind
		if (!(OP_KINDS as readonly string[]).includes(kind ?? "")) {
			throw new DocumentError(
				"corrupt",
				`op ${i + 1}: unknown kind ${JSON.stringify(kind)} — allowed: ${OP_KINDS.join(", ")}`,
				"xlsx",
			)
		}
		const o = op as Record<string, unknown>
		const requireField = (name: string): void => {
			if (o[name] === undefined) throw new DocumentError("corrupt", `op ${i + 1} (${kind}) needs "${name}"`, "xlsx")
		}
		switch (kind) {
			case "set-cells":
				requireField("cells")
				if (typeof o.cells !== "object" || o.cells === null || Array.isArray(o.cells))
					throw new DocumentError(
						"corrupt",
						`op ${i + 1} (set-cells): "cells" must be an object keyed by cell ref`,
						"xlsx",
					)
				break
			case "clear-range":
				requireField("range")
				break
			case "append-rows":
				requireField("rows")
				if (!Array.isArray(o.rows))
					throw new DocumentError("corrupt", `op ${i + 1} (append-rows): "rows" must be an array`, "xlsx")
				break
			case "set-column-width":
				requireField("columns")
				break
			case "add-sheet":
				requireField("name")
				break
			case "rename-sheet":
				requireField("name")
				break
			case "delete-sheet":
				requireField("sheet")
				break
			case "fill-formula":
				requireField("range")
				requireField("formula")
				break
		}
		return op as XlsxOp
	})
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
