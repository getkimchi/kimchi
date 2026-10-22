/**
 * `docx.mjs` — the command-line entry the bundled docx skill drives. Runs
 * under the kimchi binary's embedded Bun runtime (`BUN_BE_BUN=1 kimchi
 * docx.mjs ...`) and under plain node; no Python, no LibreOffice required.
 *
 *   docx.mjs read <doc> [start-end]      body blocks (paragraphs pN, tables)
 *                                        as Markdown; windowed, ≤50 KB/call,
 *                                        with a continuation hint.
 *   docx.mjs info <doc>                  counts, outline, core properties.
 *   docx.mjs create <out> --content <f.md> [--template <t.docx|.dotx>]
 *                                        [--page-size A4|Letter]
 *                                        Build a docx from Markdown.
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
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { RealClock } from "./clock.js"
import { applyDocxOps, parseDocxOps } from "./editors/docx.js"
import { extractDocx } from "./extractors/docx.js"
import { maxFileBytes } from "./limits.js"
import { parseMarkdownBlocks } from "./markdown/blocks.js"
import { DocumentError, isDocumentError } from "./model.js"
import { openOoxml } from "./ooxml/package.js"
import { requireNoProblems, validateContentTypes } from "./ooxml/validate.js"
import { sameFile } from "./paths.js"
import { defaultWhich, findSoffice } from "./soffice.js"
import { type PageSizeName, writeDocx } from "./writers/docx.js"

export interface CliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	writeFile?: (path: string, data: Uint8Array) => void
}

const USAGE = `usage: docx.mjs <command> [args]

commands:
  read <doc.docx> [start-end]                     body blocks as Markdown (window of paragraphs)
  info <doc.docx>                                 paragraph/table/image counts, outline, core props
  create <out.docx> --content <file.md> [--template <tpl.docx|tpl.dotx>] [--page-size A4|Letter]
                                                  build a docx from Markdown (never in place)
  edit <in.docx> --out <out.docx> --ops <ops.json>   apply ops, never in place
  render <doc.docx> --out <out.pdf>                  visual proof via LibreOffice (optional tool)`

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]

/** Legacy .doc extension and OLE2 container (also the encrypted-OOXML wrapper)
 *  — one typed error instead of a zip parse failure. */
function rejectLegacyOrEncrypted(input: string, data: Uint8Array): void {
	if (input.toLowerCase().endsWith(".doc")) {
		throw new DocumentError(
			"unsupported-format",
			`${input} is a legacy binary Word file (.doc) — convert it first (LibreOffice: soffice --convert-to docx "${input}")`,
			"docx",
		)
	}
	if (data.length >= 4 && OLE2_MAGIC.every((b, i) => data[i] === b)) {
		throw new DocumentError(
			"unsupported-format",
			`${input} is an OLE2 container — a legacy binary file or an encrypted document; open it in Word/LibreOffice and save unencrypted .docx`,
			"docx",
		)
	}
}

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
			"docx",
		)
	}
}

function flagValue(flags: string[], name: string): string | undefined {
	const i = flags.indexOf(name)
	return i >= 0 ? flags[i + 1] : undefined
}

/** Per-call window length (body blocks); smaller than the 50 KB char cap
 *  in practice — the cap in extractDocx.window() wins first. */
const BLOCKS_PER_CALL = 500

function parseBlockRange(arg: string | undefined, total: number): { start: number; end: number } {
	if (!arg) return { start: 1, end: Math.min(total, BLOCKS_PER_CALL) }
	const match = /^(\d+)-(\d+)$/.exec(arg) ?? /^(\d+)$/.exec(arg)
	if (!match) throw new DocumentError("corrupt", `Invalid block range "${arg}" — use N or N-M (1-based).`)
	const start = Number(match[1])
	const end = match[2] !== undefined ? Number(match[2]) : start
	if (start < 1 || end < start)
		throw new DocumentError("corrupt", `Invalid block range "${arg}" — start must be ≥1 and end ≥ start.`)
	if (end - start + 1 > BLOCKS_PER_CALL)
		throw new DocumentError(
			"corrupt",
			`Block windows are capped at ${BLOCKS_PER_CALL} blocks (${start}-${end} asked).`,
			"docx",
		)
	return { start, end: Math.min(end, total) }
}

export async function runDocxCli(argv: string[], io: CliIo): Promise<number> {
	const readFile = io.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
	const [command, ...args] = argv
	try {
		switch (command) {
			case "read": {
				const [path, rangeArg] = args
				if (!path)
					throw new DocumentError("corrupt", "read needs a document path: docx.mjs read <doc.docx> [start-end]")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				rejectLegacyOrEncrypted(path, data)
				const doc = await extractDocx(data)
				const { start, end } = parseBlockRange(rangeArg, doc.totalBlocks)
				const w = doc.window({ start, end })
				io.stdout(`# ${path} (docx — blocks ${w.from}-${w.to} of ${doc.totalBlocks})\n\n${w.markdown}`.trim())
				if (w.to < doc.totalBlocks || w.truncated) {
					io.stderr(
						`showing blocks ${w.from}-${w.to} of ${doc.totalBlocks}; continue with: read ${path} ${w.to + 1}-${doc.totalBlocks}`,
					)
				}
				return 0
			}
			case "info": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "info needs a document path: docx.mjs info <doc.docx>")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				rejectLegacyOrEncrypted(path, data)
				const doc = await extractDocx(data)
				const lines = [
					`${path} (docx)`,
					`blocks: ${doc.totalBlocks} (${doc.tables} table${doc.tables === 1 ? "" : "s"}), images: ${doc.images}`,
				]
				if (doc.info.title) lines.push(`title: ${doc.info.title}`)
				if (doc.info.creator) lines.push(`creator: ${doc.info.creator}`)
				if (doc.info.lastModifiedBy) lines.push(`last modified by: ${doc.info.lastModifiedBy}`)
				if (doc.info.trackedChanges) lines.push(`tracked changes: yes (read-only as annotations)`)
				if (doc.info.comments > 0) lines.push(`comments: ${doc.info.comments}`)
				if (doc.info.footnotes > 0) lines.push(`footnotes: ${doc.info.footnotes}`)
				if (doc.outline.length > 0) {
					lines.push("outline:")
					for (const line of doc.outline) lines.push(`  ${line}`)
				}
				io.stdout(lines.join("\n"))
				return 0
			}
			case "create": {
				const [out, ...flags] = args
				if (!out)
					throw new DocumentError(
						"corrupt",
						"create needs an output path: docx.mjs create <out.docx> --content <file.md>",
					)
				if (!out.toLowerCase().endsWith(".docx"))
					throw new DocumentError("corrupt", `output path must end in .docx: ${out}`)
				const contentPath = flagValue(flags, "--content")
				if (!contentPath) throw new DocumentError("corrupt", "create needs --content <file.md> (Markdown)")
				const pageSize = (flagValue(flags, "--page-size") ?? "Letter") as PageSizeName
				if (!(pageSize in { A4: 1, Letter: 1 }))
					throw new DocumentError("corrupt", `--page-size must be A4 or Letter (got "${pageSize}")`)
				if (sameFile(out, contentPath)) {
					throw new DocumentError("corrupt", "--out must differ from --content", "docx")
				}
				const content = new TextDecoder().decode(readBytes(readFile, contentPath))
				const blocks = parseMarkdownBlocks(content)
				const bytes = await writeDocx(
					{ blocks },
					{ baseDir: dirname(resolve(contentPath)), pageSize, clock: RealClock },
				)
				const templatePath = flagValue(flags, "--template")
				if (
					templatePath &&
					!templatePath.toLowerCase().endsWith(".docx") &&
					!templatePath.toLowerCase().endsWith(".dotx")
				) {
					throw new DocumentError("corrupt", `template must be a .docx or .dotx: ${templatePath}`, "docx")
				}
				const finalBytes = templatePath
					? await applyTemplate(bytes, readBytes(readFile, templatePath), templatePath)
					: bytes
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, finalBytes)
				io.stdout(`created ${out} (${blocks.length} block${blocks.length === 1 ? "" : "s"})`)
				return 0
			}
			case "edit": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError(
						"corrupt",
						"edit needs an input: docx.mjs edit <in.docx> --out <out.docx> --ops <ops.json>",
					)
				const out = flagValue(flags, "--out")
				const opsPath = flagValue(flags, "--ops")
				if (!out) throw new DocumentError("corrupt", "edit needs --out <out.docx> — edits never write in place")
				if (!opsPath) throw new DocumentError("corrupt", "edit needs --ops <ops.json> (a JSON array of ops)")
				if (!out.toLowerCase().endsWith(".docx"))
					throw new DocumentError("corrupt", `output path must end in .docx: ${out}`)
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "docx")
				}
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				rejectLegacyOrEncrypted(input, data)
				const opsBytes = readBytes(readFile, opsPath)
				enforceSizeCap(opsPath, opsBytes)
				const opsJson = new TextDecoder().decode(opsBytes)
				let raw: unknown
				try {
					raw = JSON.parse(opsJson)
				} catch {
					throw new DocumentError("corrupt", `ops file is not valid JSON: ${opsPath}`)
				}
				const ops = parseDocxOps(raw)
				const pkg = await openOoxml(data)
				const inputProblems = validateContentTypes(pkg, pkg.getXml("[Content_Types].xml"))
				const result = applyDocxOps(pkg, ops)
				// Fail only on defects WE introduced — third-party packaging quirks are preserved.
				requireNoProblems(
					validateContentTypes(pkg, pkg.getXml("[Content_Types].xml")).filter((p) => !inputProblems.includes(p)),
					`post-edit package validation for ${input} — fix the op and retry; the input is unchanged`,
				)
				const bytes = await pkg.save()
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)

				// Post-write summary: re-read the output, list per-op results and
				// flag leftover placeholder text — a silent template fill failure
				// must be visible.
				const reread = await extractDocx(bytes)
				const fullText: string[] = []
				const scanLimit = Math.min(reread.totalBlocks, 2000)
				for (let b = 1; b <= scanLimit; b++) fullText.push(reread.blockText(b))
				const leftovers = findPlaceholders(fullText.join("\n"))
				const lines = [
					`edited ${input} -> ${out} (${ops.length} op${ops.length === 1 ? "" : "s"} applied)`,
					...result.applied,
				]
				if (result.trackedChangesPresent) {
					lines.push("note: the document contains tracked changes — they were preserved, not applied")
				}
				if (leftovers.length > 0) {
					lines.push(`leftover placeholder text: ${leftovers.join(", ")}`)
				}
				io.stdout(lines.join("\n"))
				return 0
			}
			case "render": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError("corrupt", "render needs an input: docx.mjs render <doc.docx> --out <out.pdf>")
				const known = ["--out"]
				for (const f of flags) {
					if (f.startsWith("--") && !known.includes(f)) {
						throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`)
					}
				}
				const out = flagValue(flags, "--out")
				if (!out) throw new DocumentError("corrupt", "render needs --out <out.pdf>")
				if (!out.toLowerCase().endsWith(".pdf"))
					throw new DocumentError("corrupt", `render output must end in .pdf: ${out}`, "docx")
				if (sameFile(out, input)) throw new DocumentError("corrupt", "--out must differ from the input", "docx")
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				rejectLegacyOrEncrypted(input, data)
				const soffice = findSoffice(
					{ which: defaultWhich, fileExists: existsSync },
					{ format: "docx", commands: "render", core: "read/create/edit/info" },
				)
				const tmpDir = mkdtempSync(join(tmpdir(), "kimchi-docx-render-"))
				try {
					const staged = join(tmpDir, basename(input))
					writeFileSync(staged, data)
					const run = spawnSync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, staged], {
						timeout: 120_000,
						killSignal: "SIGKILL",
					})
					if (run.error) {
						throw new DocumentError(
							"corrupt",
							"LibreOffice timed out after 120s — close every LibreOffice instance and retry",
							"docx",
						)
					}
					if (run.status !== 0) {
						throw new DocumentError(
							"corrupt",
							`libreoffice failed (${run.status}): ${String(run.stderr).slice(0, 400)}`,
							"docx",
						)
					}
					const pdfPath = staged.replace(/\.docx$/i, ".pdf")
					const writeFile = io.writeFile ?? atomicWrite
					writeFile(out, new Uint8Array(readFileSync(pdfPath)))
					io.stdout(`rendered ${input} -> ${out} via LibreOffice`)
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

const PLACEHOLDER_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /\blorem\b/i, label: "lorem" },
	{ re: /\bxxx+\b/i, label: "xxx" },
	{ re: /\[insert[^\]]*\]/i, label: "[insert …]" },
	{ re: /\bTODO\b/, label: "TODO" },
	{ re: /click to add/i, label: "click to add" },
]

/** Placeholder phrases left in the output (labels, deduped, capped). */
function findPlaceholders(text: string): string[] {
	const found = new Set<string>()
	for (const { re, label } of PLACEHOLDER_PATTERNS) {
		if (re.test(text)) found.add(label)
	}
	return [...found]
}

/**
 * Style template support: copy the template's styles/numbering/fontTable
 * parts into the generated package, so headings and fonts follow a
 * company .dotx/.docx. Content comes from the Markdown, never the template.
 */
export async function applyTemplate(
	generated: Uint8Array,
	template: Uint8Array,
	templatePath: string,
): Promise<Uint8Array> {
	if (!templatePath.toLowerCase().endsWith(".docx") && !templatePath.toLowerCase().endsWith(".dotx")) {
		throw new DocumentError("corrupt", `template must be a .docx or .dotx: ${templatePath}`, "docx")
	}
	const tpl = await openOoxml(template)
	if (!tpl.hasXml("word/document.xml")) {
		throw new DocumentError("corrupt", `template is not a DOCX/DOTX package: ${templatePath}`, "docx")
	}
	const out = await openOoxml(generated)
	for (const part of ["word/styles.xml", "word/numbering.xml", "word/fontTable.xml"]) {
		const bytes = tpl.getBytes(part)
		if (bytes) out.putBytes(part, bytes)
	}
	return out.save()
}

/** Write via temp + rename so an interrupted create never leaves a half file. */
function atomicWrite(path: string, data: Uint8Array): void {
	const temp = `${path}.docx-mjs-tmp.${process.pid}.${++atomicWriteCounter}`
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
			// temp cleanup is best-effort; the OS reclaims temp files
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
	runDocxCli(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	}).then((code) => {
		process.exitCode = code
	})
}
