/**
 * `pdf.mjs` — the command-line entry the bundled pdf skill drives. Runs
 * under the kimchi binary's embedded Bun runtime (`BUN_BE_BUN=1 kimchi
 * pdf.mjs ...`) and under plain node. No Python, no system libraries.
 *
 *   pdf.mjs read <file.pdf> [N-M]              Pages as Markdown (≤20 per call);
 *                                              continuation hint when capped.
 *   pdf.mjs info <file.pdf>                    Page count, encryption.
 *   pdf.mjs fields <file.pdf>                  AcroForm fields (name, type,
 *                                              value/options) as JSON lines.
 *   pdf.mjs fill-form <in> --out <out> --values f.json
 *
 *   pdf.mjs create <out.pdf> --content doc.md [--page-size a4|letter]
 *   pdf.mjs merge <out.pdf> <in1.pdf> <in2.pdf> [...]
 *   pdf.mjs split <in.pdf> --pages N-M --out <out.pdf>
 *   pdf.mjs reorder <in.pdf> --order 3,1,2 --out <out.pdf>
 *   pdf.mjs rotate <in.pdf> --out <out.pdf> --angle 90|180|270 [--pages N-M]
 *
 *   pdf.mjs dump-shapes <file.pdf> [--page N]   text shapes (page, index, xywh,
 *                                              text) as JSON — discovery for
 *                                              edit-draw. Needs LibreOffice.
 *   pdf.mjs edit-draw <in.pdf> --out <out.pdf> --map map.json
 *                                              replace shape text in place
 *                                              (styling preserved). map entries:
 *                                              {"page":1,"shape":4,"text":"..."}.
 *                                              Needs LibreOffice.
 *
 * Pages are 1-based. Writes are atomic (temp + rename) and outputs are
 * re-parsed before landing; --out must differ from every input.
 */

import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { PDFDocument } from "@cantoo/pdf-lib"
import { fillForm, listFields, mergePdfs, reorderPdf, rotatePdf, splitPdf } from "./editors/pdf.js"
import { extractPdf, pdfInfo } from "./extractors/pdf.js"
import { MAX_UNITS_PER_CALL, maxFileBytes } from "./limits.js"
import { parseMarkdownBlocks } from "./markdown/blocks.js"
import { DocumentError, isDocumentError } from "./model.js"
import { sameFile } from "./paths.js"
import { findPdfFonts, pdfFontSearchDirs } from "./pdf-fonts.js"
import { type LoDrawDeps, runLoDraw } from "./pdf-lo-draw.js"
import { renderDocument } from "./render.js"
import { PAGE_SIZES, renderBlocksToPdf } from "./writers/pdf.js"

export interface PdfCliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	writeFile?: (path: string, data: Uint8Array) => void
	/** Font bytes override for tests (host fonts via pdf-fonts.ts otherwise). */
	fonts?: { regular: Uint8Array; bold: Uint8Array; mono: Uint8Array }
	/** LibreOffice runner override for tests (real soffice otherwise). */
	loDraw?: LoDrawDeps
}

const USAGE = `usage: pdf.mjs <command> [args]

commands:
  read <file.pdf> [N-M]                          pages as Markdown (20 per call)
  info <file.pdf>                                page count, encryption
  fields <file.pdf>                              form fields as JSON lines
  fill-form <in.pdf> --out <out.pdf> --values <f.json>
  create <out.pdf> --content <doc.md> [--page-size a4|letter]
  merge <out.pdf> <in1.pdf> <in2.pdf> [...]
  split <in.pdf> --pages N-M --out <out.pdf>
  reorder <in.pdf> --order 3,1,2 --out <out.pdf>
  rotate <in.pdf> --out <out.pdf> --angle 90|180|270 [--pages N-M]
  dump-shapes <file.pdf> [--page N]              text shapes as JSON (LibreOffice)
  edit-draw <in.pdf> --out <out.pdf> --map <map.json>
                                                 replace shape text (LibreOffice)`

function readBytes(readFile: NonNullable<PdfCliIo["readFile"]>, path: string): Uint8Array {
	try {
		return readFile(path)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot read ${path}: ${(err as Error).message}`, "pdf")
	}
}

function enforceSizeCap(path: string, data: Uint8Array): void {
	const cap = maxFileBytes()
	if (data.length > cap) {
		throw new DocumentError(
			"too-large",
			`${path} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with KIMCHI_DOCUMENT_MAX_MB.`,
			"pdf",
		)
	}
}

function flagValue(flags: string[], name: string): string | undefined {
	const i = flags.indexOf(name)
	return i >= 0 ? flags[i + 1] : undefined
}

/** "N", "N-M" → 1-based page list against a known page count. */
function parsePageList(spec: string, total: number): number[] {
	if (!/^\d+(-\d*)?$/.test(spec)) {
		throw new DocumentError("corrupt", `invalid page range "${spec}" — use N or N-M (1-based)`, "pdf")
	}
	const [a, b] = spec.split("-")
	const start = Number.parseInt(a!, 10)
	const end = b === undefined || b === "" ? total : Number.parseInt(b, 10)
	if (start < 1 || end < start) {
		throw new DocumentError("corrupt", `invalid page range "${spec}" — start ≥ 1 and end ≥ start`, "pdf")
	}
	const pages: number[] = []
	for (let p = start; p <= Math.min(end, total); p++) pages.push(p)
	if (pages.length === 0) {
		throw new DocumentError("corrupt", `page range "${spec}" is out of range — the document has ${total} pages`, "pdf")
	}
	return pages
}

function parseOrder(spec: string): number[] {
	if (!/^\d+(,\d+)*$/.test(spec)) {
		throw new DocumentError("corrupt", `invalid --order value "${spec}" — comma-separated page numbers`, "pdf")
	}
	return spec.split(",").map((s) => Number.parseInt(s, 10))
}

async function loadFontBytes(io: PdfCliIo): Promise<{ regular: Uint8Array; bold: Uint8Array; mono: Uint8Array }> {
	if (io.fonts) return io.fonts
	const fonts = findPdfFonts(pdfFontSearchDirs())
	if (!fonts) {
		throw new DocumentError(
			"tool-missing",
			"no usable Unicode font found for creating PDFs — install DejaVu, Noto Sans, or Liberation fonts, or set KIMCHI_PDF_FONT_DIR to a directory of .ttf/.otf files",
			"pdf",
		)
	}
	const readFile = io.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)))
	return {
		regular: readBytes(readFile, fonts.regular),
		bold: readBytes(readFile, fonts.bold),
		mono: readBytes(readFile, fonts.mono ?? fonts.regular),
	}
}

/** Re-parse output bytes before they land: a pdf-lib bug can't ship silently. */
async function verifyOutput(bytes: Uint8Array, path: string): Promise<void> {
	try {
		await PDFDocument.load(bytes, { ignoreEncryption: true })
	} catch (err) {
		throw new DocumentError(
			"package-validation",
			`produced an unreadable PDF for ${path}: ${(err as Error).message ?? err} — nothing was written`,
			"pdf",
		)
	}
}

export async function runPdfCli(argv: string[], io: PdfCliIo): Promise<number> {
	const readFile = io.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
	const writeFile = io.writeFile ?? atomicWrite
	const [command, ...rest] = argv
	try {
		switch (command) {
			case "read": {
				const [path, rangeArg] = rest
				if (!path) throw new DocumentError("corrupt", "read needs a file path: pdf.mjs read <file.pdf> [N-M]", "pdf")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const info = await pdfInfo(data)
				const wanted = rangeArg ? parsePageList(rangeArg, info.pageCount) : undefined
				const window =
					wanted && wanted.length > MAX_UNITS_PER_CALL ? wanted.slice(0, MAX_UNITS_PER_CALL) : (wanted ?? undefined)
				const extractWindow =
					!wanted && info.pageCount > MAX_UNITS_PER_CALL
						? Array.from({ length: MAX_UNITS_PER_CALL }, (_, i) => i + 1)
						: window
				const doc = await extractPdf(data, { pages: extractWindow })
				const rendered = renderDocument(doc, { toolName: "pdf.mjs read", path })
				io.stdout(rendered.text)
				if (wanted && wanted.length > MAX_UNITS_PER_CALL) {
					const remaining = wanted.slice(MAX_UNITS_PER_CALL)
					io.stderr(
						`showing pages ${window![0]}-${window![window!.length - 1]} of the requested range; continue with: read ${path} ${remaining[0]}-${remaining[remaining.length - 1]}`,
					)
				} else if (!wanted && info.pageCount > MAX_UNITS_PER_CALL) {
					io.stderr(`document has ${info.pageCount} pages, showing 1-20; continue with: read ${path} 21-40`)
				}
				return 0
			}
			case "info": {
				const [path] = rest
				if (!path) throw new DocumentError("corrupt", "info needs a file path: pdf.mjs info <file.pdf>", "pdf")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const info = await pdfInfo(data)
				io.stdout(JSON.stringify(info.encrypted ? { encrypted: true } : info))
				return 0
			}
			case "fields": {
				const [path] = rest
				if (!path) throw new DocumentError("corrupt", "fields needs a file path: pdf.mjs fields <file.pdf>", "pdf")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const fields = await listFields(data)
				for (const f of fields) io.stdout(JSON.stringify(f))
				if (fields.length === 0) io.stdout("[]")
				return 0
			}
			case "fill-form": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError(
						"corrupt",
						"fill-form needs an input: pdf.mjs fill-form <in.pdf> --out <out.pdf> --values <f.json>",
						"pdf",
					)
				const out = flagValue(flags, "--out")
				const valuesPath = flagValue(flags, "--values")
				if (!out)
					throw new DocumentError("corrupt", "fill-form needs --out <out.pdf> — edits never write in place", "pdf")
				if (!valuesPath) throw new DocumentError("corrupt", "fill-form needs --values <f.json>", "pdf")
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "pdf")
				}
				refuseNonPdf(out)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				let values: Record<string, unknown>
				try {
					values = JSON.parse(new TextDecoder().decode(readBytes(readFile, valuesPath))) as Record<string, unknown>
				} catch {
					throw new DocumentError("corrupt", `values file is not valid JSON: ${valuesPath}`, "pdf")
				}
				const result = await fillForm(data, values as Parameters<typeof fillForm>[1])
				await verifyOutput(result.bytes, out)
				writeFile(out, result.bytes)
				io.stdout(`filled ${result.filled.length} field${result.filled.length === 1 ? "" : "s"} -> ${out}`)
				for (const ig of result.ignored) io.stderr(`ignored ${JSON.stringify(ig.name)}: ${ig.reason}`)
				// Ignored entries are visible, not fatal — the common case is one
				// mismatched name among many, and all others landed.
				return result.ignored.length === 0 ? 0 : 1
			}
			case "create": {
				const [out, ...flags] = rest
				if (!out)
					throw new DocumentError(
						"corrupt",
						"create needs an output path: pdf.mjs create <out.pdf> --content <doc.md>",
						"pdf",
					)
				refuseNonPdf(out)
				const contentPath = flagValue(flags, "--content")
				if (!contentPath) throw new DocumentError("corrupt", "create needs --content <doc.md>", "pdf")
				const sizeFlag = flagValue(flags, "--page-size") ?? "a4"
				const pageSize = sizeFlag === "letter" ? PAGE_SIZES.letter : sizeFlag === "a4" ? PAGE_SIZES.a4 : undefined
				if (!pageSize) throw new DocumentError("corrupt", `--page-size must be a4 or letter, got "${sizeFlag}"`, "pdf")
				const content = new TextDecoder().decode(readBytes(readFile, contentPath))
				const blocks = parseMarkdownBlocks(content)
				const rendered = await renderBlocksToPdf(blocks, await loadFontBytes(io), {
					pageSize,
					loadImage: (href) => {
						if (/[.]pdf$/i.test(href)) throw new DocumentError("corrupt", `not an image path: ${href}`, "pdf")
						// Local images only, confined under the Markdown file's dir.
						if (isAbsolute(href) || href.split(/[\\/]/).includes("..")) {
							throw new DocumentError(
								"unsupported-format",
								`image path "${href}" must stay under the content file's directory`,
								"pdf",
							)
						}
						const data = readBytes(readFile, resolve(dirname(resolve(contentPath)), href))
						enforceSizeCap(href, data)
						return data
					},
				})
				await verifyOutput(rendered, out)
				writeFile(out, rendered)
				io.stdout(`created ${out}`)
				return 0
			}
			case "merge": {
				const [out, ...inputs] = rest
				if (!out)
					throw new DocumentError("corrupt", "merge needs: pdf.mjs merge <out.pdf> <in1.pdf> <in2.pdf> [...]", "pdf")
				refuseNonPdf(out)
				if (inputs.length < 2) throw new DocumentError("corrupt", "merge needs at least two input files", "pdf")
				for (const input of inputs) {
					if (sameFile(out, input)) {
						throw new DocumentError(
							"corrupt",
							"output must differ from every input — merge never writes in place",
							"pdf",
						)
					}
				}
				const datas = inputs.map((p) => {
					const d = readBytes(readFile, p)
					enforceSizeCap(p, d)
					return d
				})
				const merged = await mergePdfs(datas)
				await verifyOutput(merged, out)
				writeFile(out, merged)
				io.stdout(`merged ${inputs.length} files -> ${out}`)
				return 0
			}
			case "split": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError("corrupt", "split needs: pdf.mjs split <in.pdf> --pages N-M --out <out.pdf>", "pdf")
				const out = flagValue(flags, "--out")
				const pagesSpec = flagValue(flags, "--pages")
				if (!out) throw new DocumentError("corrupt", "split needs --out <out.pdf>", "pdf")
				if (!pagesSpec) throw new DocumentError("corrupt", "split needs --pages N-M (1-based)", "pdf")
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — split never writes in place", "pdf")
				}
				refuseNonPdf(out)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const info = await pdfInfo(data)
				const bytes = await splitPdf(data, parsePageList(pagesSpec, info.pageCount))
				await verifyOutput(bytes, out)
				writeFile(out, bytes)
				io.stdout(`extracted to ${out}`)
				return 0
			}
			case "reorder": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError(
						"corrupt",
						"reorder needs: pdf.mjs reorder <in.pdf> --order 3,1,2 --out <out.pdf>",
						"pdf",
					)
				const out = flagValue(flags, "--out")
				const orderSpec = flagValue(flags, "--order")
				if (!out) throw new DocumentError("corrupt", "reorder needs --out <out.pdf>", "pdf")
				if (!orderSpec)
					throw new DocumentError("corrupt", "reorder needs --order (comma-separated, a permutation)", "pdf")
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — reorder never writes in place", "pdf")
				}
				refuseNonPdf(out)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const bytes = await reorderPdf(data, parseOrder(orderSpec))
				await verifyOutput(bytes, out)
				writeFile(out, bytes)
				io.stdout(`reordered -> ${out}`)
				return 0
			}
			case "rotate": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError(
						"corrupt",
						"rotate needs: pdf.mjs rotate <in.pdf> --out <out.pdf> --angle 90|180|270 [--pages N-M]",
						"pdf",
					)
				const out = flagValue(flags, "--out")
				const angleSpec = flagValue(flags, "--angle")
				if (!out) throw new DocumentError("corrupt", "rotate needs --out <out.pdf>", "pdf")
				if (angleSpec !== "90" && angleSpec !== "180" && angleSpec !== "270") {
					throw new DocumentError("corrupt", `rotate needs --angle 90|180|270, got "${angleSpec ?? ""}"`, "pdf")
				}
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — rotate never writes in place", "pdf")
				}
				refuseNonPdf(out)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const pagesSpec = flagValue(flags, "--pages")
				let pages: number[] | undefined
				if (pagesSpec) {
					const info = await pdfInfo(data)
					pages = parsePageList(pagesSpec, info.pageCount)
				}
				const bytes = await rotatePdf(data, { pages, degrees: Number.parseInt(angleSpec, 10) as 90 | 180 | 270 })
				await verifyOutput(bytes, out)
				writeFile(out, bytes)
				io.stdout(`rotated -> ${out}`)
				return 0
			}
			case "dump-shapes": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError("corrupt", "dump-shapes needs: pdf.mjs dump-shapes <file.pdf> [--page N]", "pdf")
				refuseNonPdf(input)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const pageFilter = flagValue(flags, "--page")
				if (pageFilter !== undefined && !/^\d+$/.test(pageFilter)) {
					throw new DocumentError("corrupt", `--page must be a number, got "${pageFilter}"`, "pdf")
				}
				const dumpPath = join(tmpdir(), `pdf-lo-dump-${Date.now()}.json`)
				try {
					await runLoDraw("dump", resolve(input), dumpPath, io.loDraw)
					const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as {
						pages: number
						shapes: Array<{ page: number; shape: number; xywh: number[]; text: string }>
					}
					const shapes =
						pageFilter === undefined
							? dump.shapes
							: dump.shapes.filter((s) => s.page === Number.parseInt(pageFilter, 10))
					io.stdout(JSON.stringify({ pages: dump.pages, shapes }, null, 2))
				} finally {
					try {
						unlinkSync(dumpPath)
					} catch {
						// best-effort temp cleanup
					}
				}
				return 0
			}
			case "edit-draw": {
				const [input, ...flags] = rest
				if (!input)
					throw new DocumentError(
						"corrupt",
						"edit-draw needs: pdf.mjs edit-draw <in.pdf> --out <out.pdf> --map <map.json>",
						"pdf",
					)
				const out = flagValue(flags, "--out")
				const mapPath = flagValue(flags, "--map")
				if (!out) throw new DocumentError("corrupt", "edit-draw needs --out <out.pdf>", "pdf")
				if (!mapPath)
					throw new DocumentError(
						"corrupt",
						"edit-draw needs --map <map.json> — run dump-shapes first to find shape indices",
						"pdf",
					)
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "pdf")
				}
				refuseNonPdf(out)
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const edits = JSON.parse(new TextDecoder().decode(readFile(mapPath))) as Array<{
					page: number
					shape: number
					text: string
				}>
				if (!Array.isArray(edits) || edits.length === 0) {
					throw new DocumentError("corrupt", "--map must be a non-empty JSON array of {page, shape, text}", "pdf")
				}
				// Export lands in a temp file first: verify before anything exists at
				// --out, then land atomically like every other command.
				const stagedOut = join(tmpdir(), `pdf-lo-export-${Date.now()}.pdf`)
				try {
					const { status } = await runLoDraw("apply", resolve(input), stagedOut, io.loDraw, resolve(mapPath))
					const exported = readBytes(readFile, stagedOut)
					await verifyOutput(exported, out)
					writeFile(out, exported)
					for (const failure of status.errors ?? []) io.stderr(`ignored: ${failure}`)
					const applied = status.applied ?? 0
					io.stdout(
						`edited ${input} -> ${out} (${applied} edit${applied === 1 ? "" : "s"} applied of ${edits.length} mapped)`,
					)
				} finally {
					try {
						unlinkSync(stagedOut)
					} catch {
						// best-effort temp cleanup
					}
				}
				return 0
			}
			default:
				if (command === undefined || command === "--help" || command === "-h") {
					io.stdout(USAGE)
					return command === undefined ? 2 : 0
				}
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

function refuseNonPdf(out: string): void {
	if (!out.toLowerCase().endsWith(".pdf"))
		throw new DocumentError("corrupt", `output path must end in .pdf: ${out}`, "pdf")
}

function atomicWrite(path: string, data: Uint8Array): void {
	const temp = `${path}.pdf-mjs-tmp.${process.pid}.${++atomicWriteCounter}`
	try {
		writeFileSync(temp, data)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot write ${path}: ${(err as Error).message}`, "pdf")
	}
	try {
		renameSync(temp, path)
	} catch (err) {
		try {
			unlinkSync(temp)
		} catch {
			// temp cleanup is best-effort; the OS reclaims temp files
		}
		throw new DocumentError("corrupt", `Cannot move output into place at ${path}: ${(err as Error).message}`, "pdf")
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
	runPdfCli(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	})
		.then((code) => {
			process.exitCode = code
		})
		.catch((err) => {
			// Typed errors print via the CLI's own formatting; anything else still
			// exits nonzero instead of surfacing as an unhandled rejection.
			if (!isDocumentError(err)) console.error(String((err as Error)?.message ?? err))
			process.exitCode = 2
		})
}
