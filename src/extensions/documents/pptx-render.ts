/**
 * `pptx.mjs render` — optional visual QA for decks: LibreOffice converts the
 * PPTX to PDF, then a PDF rasterizer (pdftoppm, ghostscript, or python3 with
 * pymupdf) writes per-slide PNGs the agent can Read to see its own output.
 *
 * These external tools are never required for read/create/edit/check — only
 * for `render`. Every failure is a typed DocumentError naming the install
 * command, so the skill degrades to static `check` instead of stalling.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DocumentError } from "./model.js"

export interface ProcessResult {
	code: number
	stdout: string
	stderr: string
	signal?: NodeJS.Signals
}

export type Runner = (cmd: string, args: string[]) => ProcessResult

/** Injectable process/filesystem seams — tests substitute fakes, production uses node defaults. */
export interface RenderDeps {
	which?: (cmd: string) => string | undefined
	run?: Runner
	fileExists?: (path: string) => boolean
	listdir?: (dir: string) => string[]
	mkdtemp?: (prefix: string) => string
}

export interface RenderOptions {
	outDir: string
	/** 1-based, inclusive; PNGs outside the range are dropped. */
	slides?: { start: number; end: number }
	deps?: RenderDeps
}

export interface RenderResult {
	/** The intermediate PDF — kept because it is usable even when rasterizing fails. */
	pdf: string
	/** Per-slide PNG paths, ordered by slide number. */
	images: string[]
}

const SOFFICE_TIMEOUT_MS = 120_000

const SOFFICE_CANDIDATES = [
	"/Applications/LibreOffice.app/Contents/MacOS/soffice",
	"/usr/bin/soffice",
	"/usr/local/bin/soffice",
	"C:\\Program Files\\LibreOffice\\program\\soffice.exe",
]

const PDF_TO_PNG: Array<{ cmd: string; label: string; args: (pdf: string, prefix: string) => string[] }> = [
	{ cmd: "pdftoppm", label: "pdftoppm (poppler)", args: (pdf, prefix) => ["-png", "-r", "110", pdf, prefix] },
	{
		cmd: "gs",
		label: "ghostscript",
		args: (pdf, prefix) => [
			"-dNOPAUSE",
			"-dBATCH",
			"-dQUIET",
			"-sDEVICE=png16m",
			"-r110",
			`-sOutputFile=${prefix}-%02d.png`,
			pdf,
		],
	},
	{
		cmd: "python3",
		label: "python3 with pymupdf",
		args: (pdf, prefix) => [
			"-c",
			[
				"import pymupdf, sys",
				"doc = pymupdf.open(sys.argv[1])",
				"out = sys.argv[2]",
				"for i, page in enumerate(doc):",
				'    page.get_pixmap(dpi=110).save(f"{out}-{i + 1:02d}.png")',
			].join("\n"),
			pdf,
			prefix,
		],
	},
]

function defaultWhich(cmd: string): string | undefined {
	const result = spawnSync("which", [cmd], { encoding: "utf8" })
	const path = result.status === 0 ? (result.stdout ?? "").trim() : ""
	return path !== "" && existsSync(path) ? path : undefined
}

function defaultRun(cmd: string, args: string[]): ProcessResult {
	const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20, timeout: SOFFICE_TIMEOUT_MS })
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
		signal: result.signal ?? undefined,
	}
}

function findSoffice(deps: Required<RenderDeps>): string {
	const onPath = deps.which("soffice")
	if (onPath) return onPath
	for (const candidate of SOFFICE_CANDIDATES) {
		if (deps.fileExists(candidate)) return candidate
	}
	throw new DocumentError(
		"tool-missing",
		"render needs LibreOffice (soffice). Install it with `brew install --cask libreoffice` (macOS) or `apt install libreoffice` (Debian/Ubuntu); on Windows use the LibreOffice installer. read/create/edit/check never need it.",
		"pptx",
	)
}

/** First few lines of tool stderr — enough to diagnose, small enough to read. */
function excerpt(stderr: string): string {
	const lines = stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "")
		.slice(0, 3)
	const text = lines.join("; ")
	return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

function collectImages(
	listdir: (dir: string) => string[],
	outDir: string,
	stem: string,
): Array<{ path: string; n: number }> {
	const stemPattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.png$`)
	const images: Array<{ path: string; n: number }> = []
	for (const entry of listdir(outDir)) {
		const match = stemPattern.exec(entry)
		if (match) images.push({ path: join(outDir, entry), n: Number(match[1]) })
	}
	images.sort((a, b) => a.n - b.n)
	return images
}

/**
 * Convert `inputPath` (a .pptx) to PDF via LibreOffice, then rasterize each
 * slide to PNG. `outDir` should be fresh — image collection matches
 * `<stem>-<n>.png`, so stale files from an earlier render of the same deck
 * name would be picked up.
 */
export async function renderPptx(inputPath: string, opts: RenderOptions): Promise<RenderResult> {
	const deps: Required<RenderDeps> = {
		which: opts.deps?.which ?? defaultWhich,
		run: opts.deps?.run ?? defaultRun,
		fileExists: opts.deps?.fileExists ?? existsSync,
		listdir: opts.deps?.listdir ?? ((dir) => readdirSync(dir)),
		mkdtemp: opts.deps?.mkdtemp ?? ((prefix) => mkdtempSync(prefix)),
	}

	const soffice = findSoffice(deps)
	// Isolated profile: a running LibreOffice instance holding the default
	// profile makes a second soffice hang forever — this is the classic
	// headless-conversion stall, and the profile flag sidesteps it.
	const profileDir = deps.mkdtemp(join(tmpdir(), "pptx-render-profile-"))
	const conversion = deps.run(soffice, [
		"--headless",
		"--norestore",
		"--nolockcheck",
		`-env:UserInstallation=file://${profileDir}`,
		"--convert-to",
		"pdf",
		"--outdir",
		opts.outDir,
		inputPath,
	])
	if (conversion.signal) {
		throw new DocumentError(
			"timeout",
			`LibreOffice did not finish converting ${inputPath} within ${SOFFICE_TIMEOUT_MS / 1000}s. Retry once; if it stalls again, inspect the deck with read/check instead.`,
			"pptx",
		)
	}
	const pdf = join(opts.outDir, `${basename(inputPath).replace(/\.pptx$/i, "")}.pdf`)
	if (conversion.code !== 0) {
		throw new DocumentError(
			"corrupt",
			`LibreOffice failed to convert ${inputPath}: ${excerpt(conversion.stderr) || "(no stderr)"}`,
			"pptx",
		)
	}
	if (!deps.fileExists(pdf)) {
		throw new DocumentError("corrupt", `LibreOffice reported success but produced no PDF at ${pdf}`, "pptx")
	}

	const stem = basename(pdf).replace(/\.pdf$/i, "")
	const prefix = join(opts.outDir, stem)
	const failures: string[] = []
	for (const candidate of PDF_TO_PNG) {
		const cmd = deps.which(candidate.cmd)
		if (!cmd) {
			failures.push(`${candidate.label}: not installed`)
			continue
		}
		const raster = deps.run(cmd, candidate.args(pdf, prefix))
		if (raster.code !== 0) {
			failures.push(`${candidate.label}: ${excerpt(raster.stderr) || `exit ${raster.code}`}`)
			continue
		}
		const all = collectImages(deps.listdir, opts.outDir, stem)
		if (all.length === 0) {
			failures.push(`${candidate.label}: exited 0 but no <stem>-<n>.png files appeared in ${opts.outDir}`)
			continue
		}
		if (opts.slides) {
			const { start, end } = opts.slides
			const images = all.filter((img) => img.n >= start && img.n <= end).map((img) => img.path)
			if (images.length === 0) {
				throw new DocumentError(
					"corrupt",
					`--slides ${start}-${end} selected none of the ${all.length} rendered slide(s). The PDF is at ${pdf}.`,
					"pptx",
				)
			}
			return { pdf, images }
		}
		return { pdf, images: all.map((img) => img.path) }
	}
	throw new DocumentError(
		"tool-missing",
		`rendered ${pdf}, but could not rasterize it to PNGs — the PDF is usable as-is. Install one of: pdftoppm (poppler-utils), ghostscript, or python3 with pymupdf. Tried: ${failures.join("; ")}`,
		"pptx",
	)
}
