/**
 * `pptx.mjs` — the command-line entry the bundled pptx skill drives. It runs
 * under the kimchi binary's embedded Bun runtime (`BUN_BE_BUN=1 kimchi
 * pptx.mjs ...`) and under plain node, with no Python and no LibreOffice.
 *
 *   pptx.mjs read <deck> [start-end]   Slides as Markdown (≤20 per call) with
 *                                      [shape "..."]/[table N] locators; a
 *                                      continuation hint when capped.
 *   pptx.mjs inspect <deck>            Layouts, placeholders and exact shape
 *                                      names — the vocabulary `edit` accepts.
 *   pptx.mjs check <deck>              Static defects (see pptx-check.ts):
 *                                      exit 0 when clean, 1 with findings.
 *
 *   pptx.mjs create <out> --content <file.md> [--theme f.json] [--template deck]
 *                                      Build a deck from deck Markdown (see
 *                                      deck-markdown.md for the format).
 *
 *
 *   pptx.mjs edit <in> --out <out> --ops f.json   Apply ops (never in place),
 *                                      revalidate the package, write atomically.
 */

import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyPptxOps, parsePptxOps } from "./editors/pptx.js"
import { extractPptx } from "./extractors/pptx.js"
import { MAX_UNITS_PER_CALL, maxFileBytes } from "./limits.js"
import { DocumentError, isDocumentError } from "./model.js"
import { openOoxml } from "./ooxml/package.js"
import { validateContentTypes, validatePresentationChildOrder } from "./ooxml/validate.js"
import { sameFile } from "./paths.js"
import { checkPptx, renderFindings } from "./pptx-check.js"
import { inspectPptx, renderInspection } from "./pptx-inspect.js"
import { type RenderDeps, renderPptx } from "./pptx-render.js"
import { renderDocument } from "./render.js"
import { parseDeckMarkdown, writePptx } from "./writers/pptx.js"
import type { DeckTheme } from "./writers/pptx-model.js"
import { createFromTemplate } from "./writers/template.js"

export interface CliIo {
	stdout: (line: string) => void
	stderr: (line: string) => void
	readFile?: (path: string) => Uint8Array
	/** Write overrides let tests intercept outputs; default is atomic temp+rename. */
	writeFile?: (path: string, data: Uint8Array) => void
	/** Injectable seams for `render`'s external tools (tests substitute fakes). */
	renderDeps?: RenderDeps
}

const USAGE = `usage: pptx.mjs <command> [args]

commands:
  read <deck.pptx> [start-end]                    slides as Markdown (20 per call)
  inspect <deck.pptx>                             layouts, placeholders, shape names
  check <deck.pptx>                               likely defects (overflow, overlap,
                                                  contrast, alt text, off-slide)
  create <out.pptx> --content <file.md> [--theme <f.json>] [--template <deck.pptx>]
  edit <in.pptx> --out <out.pptx> --ops <ops.json>  apply ops, never in place
  render <deck.pptx> --out <dir> [--slides N-M]   PDF + per-slide PNGs for visual QA
                                                  (needs LibreOffice; optional)`

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
			"pptx",
		)
	}
}

/** Value of a `--name value` flag, or undefined when absent. */
function flagValue(flags: string[], name: string): string | undefined {
	const i = flags.indexOf(name)
	return i >= 0 ? flags[i + 1] : undefined
}

function parseSlideRange(arg: string | undefined): { start: number; end: number } | undefined {
	if (!arg) return undefined
	const match = /^(\d+)-(\d+)$/.exec(arg) ?? /^(\d+)$/.exec(arg)
	if (!match) throw new DocumentError("corrupt", `Invalid slide range "${arg}" — use N or N-M (1-based).`)
	const start = Number(match[1])
	const end = match[2] !== undefined ? Number(match[2]) : start
	if (start < 1 || end < start)
		throw new DocumentError("corrupt", `Invalid slide range "${arg}" — start must be ≥1 and end ≥ start.`)
	return { start, end }
}

/** Window indices honoring the 20-slides-per-call cap (1-based, inclusive). */
function windowIndices(totalSlides: number, range?: { start: number; end: number }): number[] {
	const start = range?.start ?? 1
	const end = Math.min(range?.end ?? totalSlides, start + MAX_UNITS_PER_CALL - 1, totalSlides)
	const indices: number[] = []
	for (let i = start; i <= end; i++) indices.push(i)
	return indices
}

export async function runPptxCli(argv: string[], io: CliIo): Promise<number> {
	const readFile = io.readFile ?? ((path: string) => new Uint8Array(readFileSync(path)))
	const [command, ...args] = argv
	try {
		switch (command) {
			case "read": {
				const [path, rangeArg] = args
				if (!path) throw new DocumentError("corrupt", "read needs a deck path: pptx.mjs read <deck.pptx> [start-end]")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const doc = await extractPptx(data)
				const indices = windowIndices(doc.units.length, parseSlideRange(rangeArg))
				const rendered = renderDocument(doc, { unitIndices: indices, toolName: "pptx.mjs read", path })
				io.stdout(rendered.text)
				if (rendered.selectedUnits < rendered.totalUnits) {
					const nextStart = indices[indices.length - 1] + 1
					io.stderr(
						`showing slides ${indices[0]}-${indices[indices.length - 1]} of ${rendered.totalUnits}; continue with: read ${path} ${nextStart}-${rendered.totalUnits}`,
					)
				}
				return 0
			}
			case "inspect": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "inspect needs a deck path: pptx.mjs inspect <deck.pptx>")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				io.stdout(renderInspection(await inspectPptx(data)))
				return 0
			}
			case "check": {
				const [path] = args
				if (!path) throw new DocumentError("corrupt", "check needs a deck path: pptx.mjs check <deck.pptx>")
				const data = readBytes(readFile, path)
				enforceSizeCap(path, data)
				const findings = await checkPptx(data)
				io.stdout(renderFindings(findings))
				return findings.length === 0 ? 0 : 1
			}
			case "create": {
				const [out, ...flags] = args
				if (!out)
					throw new DocumentError(
						"corrupt",
						"create needs an output path: pptx.mjs create <out.pptx> --content <file.md>",
					)
				if (!out.toLowerCase().endsWith(".pptx"))
					throw new DocumentError("corrupt", `output path must end in .pptx: ${out}`)
				const contentPath = flagValue(flags, "--content")
				if (!contentPath)
					throw new DocumentError("corrupt", "create needs --content <file.md> (deck Markdown, see deck-markdown.md)")
				const content = new TextDecoder().decode(readBytes(readFile, contentPath))
				const themePath = flagValue(flags, "--theme")
				let theme: DeckTheme = {}
				if (themePath) {
					const raw = new TextDecoder().decode(readBytes(readFile, themePath))
					let parsed: Record<string, unknown>
					try {
						parsed = JSON.parse(raw) as Record<string, unknown>
					} catch {
						throw new DocumentError("corrupt", `theme file is not valid JSON: ${themePath}`)
					}
					const str = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined)
					const num = (key: string) => (typeof parsed[key] === "number" ? (parsed[key] as number) : undefined)
					theme = {
						font: str("font"),
						headingFont: str("headingFont"),
						monoFont: str("monoFont"),
						accent: str("accent"),
						background: str("background"),
						surface: str("surface"),
						surface2: str("surface2"),
						line: str("line"),
						text: str("text"),
						muted: str("muted"),
						footer: str("footer"),
						slideWidth: num("slideWidth"),
						slideHeight: num("slideHeight"),
					}
				}
				const spec = parseDeckMarkdown(content, theme)
				const templatePath = flagValue(flags, "--template")
				let bytes: Uint8Array
				if (templatePath) {
					if (Object.values(theme).some((v) => v !== undefined)) {
						io.stderr("note: --theme fields are ignored in --template mode; the template's theme wins.")
					}
					const templateData = readBytes(readFile, templatePath)
					enforceSizeCap(templatePath, templateData)
					bytes = await createFromTemplate(spec, templateData)
				} else {
					bytes = await writePptx(spec, { baseDir: dirname(resolve(contentPath)) })
				}
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				io.stdout(`created ${out} (${spec.slides.length} slide${spec.slides.length === 1 ? "" : "s"})`)
				return 0
			}
			case "edit": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError(
						"corrupt",
						"edit needs an input: pptx.mjs edit <in.pptx> --out <out.pptx> --ops <ops.json>",
					)
				const out = flagValue(flags, "--out")
				const opsPath = flagValue(flags, "--ops")
				if (!out) throw new DocumentError("corrupt", "edit needs --out <out.pptx> — edits never write in place")
				if (!opsPath) throw new DocumentError("corrupt", "edit needs --ops <ops.json> (a JSON array of ops)")
				if (!out.toLowerCase().endsWith(".pptx"))
					throw new DocumentError("corrupt", `output path must end in .pptx: ${out}`)
				if (sameFile(out, input)) {
					throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "pptx")
				}
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const opsJson = new TextDecoder().decode(readBytes(readFile, opsPath))
				let raw: unknown
				try {
					raw = JSON.parse(opsJson)
				} catch {
					throw new DocumentError("corrupt", `ops file is not valid JSON: ${opsPath}`)
				}
				const ops = parsePptxOps(raw)
				const pkg = await openOoxml(data)
				const inputProblems = [
					...validateContentTypes(pkg, pkg.getXml("[Content_Types].xml")),
					...validatePresentationChildOrder(pkg.getXml("ppt/presentation.xml")),
				]
				applyPptxOps(pkg, ops)
				// Fail only on defects WE introduced — decks produced by third-party
				// writers routinely violate strict schema order yet open fine in
				// PowerPoint, and edits must preserve, not "fix", their packaging.
				const outputProblems = [
					...validateContentTypes(pkg, pkg.getXml("[Content_Types].xml")),
					...validatePresentationChildOrder(pkg.getXml("ppt/presentation.xml")),
				].filter((p) => !inputProblems.includes(p))
				if (outputProblems.length > 0) {
					throw new DocumentError(
						"package-validation",
						`post-edit package validation for ${input}: ${outputProblems.join("; ")} — fix the op and retry; the input is unchanged`,
						"pptx",
					)
				}
				const bytes = await pkg.save()
				const writeFile = io.writeFile ?? atomicWrite
				writeFile(out, bytes)
				io.stdout(`edited ${input} -> ${out} (${ops.length} op${ops.length === 1 ? "" : "s"} applied)`)
				return 0
			}
			case "render": {
				const [input, ...flags] = args
				if (!input)
					throw new DocumentError("corrupt", "render needs a deck path: pptx.mjs render <deck.pptx> --out <dir>")
				const outDir = flagValue(flags, "--out")
				if (!outDir)
					throw new DocumentError("corrupt", "render needs --out <dir> — the PDF and per-slide PNGs land there")
				const data = readBytes(readFile, input)
				enforceSizeCap(input, data)
				const rendered = await renderPptx(input, {
					outDir,
					slides: parseSlideRange(flagValue(flags, "--slides")),
					deps: io.renderDeps,
				})
				for (const image of rendered.images) io.stdout(image)
				if (rendered.images.length === 0) io.stderr(`no PNGs; PDF only: ${rendered.pdf}`)
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
	// pid + counter: two concurrent edits to the same --out path must not
	// clobber each other's temp. Same-dir keeps renameSync on one filesystem.
	const temp = `${path}.pptx-mjs-tmp.${process.pid}.${++atomicWriteCounter}`
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
	runPptxCli(process.argv.slice(2), {
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	}).then((code) => {
		process.exitCode = code
	})
}
