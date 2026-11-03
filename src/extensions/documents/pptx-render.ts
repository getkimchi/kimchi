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
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { DocumentError, type DocumentFormat } from "./model.js"
import { defaultWhich, findSoffice } from "./soffice.js"

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

const PDF_TO_PNG: Array<{ cmd: string; label: string; args: (pdf: string, prefix: string) => string[] }> = [
	{ cmd: "pdftoppm", label: "pdftoppm (poppler)", args: (pdf, prefix) => ["-png", "-r", "110", pdf, prefix] },
	{
		cmd: "gs",
		label: "ghostscript",
		args: (pdf, prefix) => [
			"-dNOPAUSE",
			"-dBATCH",
			"-dQUIET",
			"-dSAFER",
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

function defaultRun(cmd: string, args: string[]): ProcessResult {
	const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20, timeout: SOFFICE_TIMEOUT_MS })
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
		signal: result.signal ?? undefined,
	}
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

/** Deps for the shared PDF→PNG rasterizer chain (pdftoppm → ghostscript → python3+pymupdf). */
export interface RasterizeDeps {
	which: (cmd: string) => string | undefined
	run: Runner
	listdir: (dir: string) => string[]
}

export interface RasterizeOptions {
	outDir: string
	/** 1-based, inclusive page filter; undefined renders all. */
	pages?: { start: number; end: number }
	/** Errors name this format. */
	format: DocumentFormat
}

export interface RasterizeResult {
	/** PNG paths in page order. */
	images: string[]
	/** Label of the rasterizer that produced them (results are labelled per route). */
	rasterizer: string
}

/**
 * Rasterize an existing PDF to `<stem>-<n>.png` files in outDir, first
 * rasterizer that works wins. outDir should not already contain PNGs of
 * the same stem from an earlier run — they are swept first so they can't
 * pose as this run's output.
 */
export function rasterizePdf(deps: RasterizeDeps, pdf: string, opts: RasterizeOptions): RasterizeResult {
	const stem = basename(pdf).replace(/\.pdf$/i, "")
	for (const entry of safeListdir(deps.listdir, opts.outDir)) {
		if (stemPngPattern(stem).test(entry)) {
			try {
				unlinkSync(join(opts.outDir, entry))
			} catch {
				// best-effort — a locked file just leaves a stale PNG
			}
		}
	}
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
		if (opts.pages) {
			const { start, end } = opts.pages
			const images = all.filter((img) => img.n >= start && img.n <= end).map((img) => img.path)
			if (images.length === 0) {
				throw new DocumentError(
					"corrupt",
					`--pages ${start}-${end} selected none of the ${all.length} rendered page(s). The PDF is at ${pdf}.`,
					opts.format,
				)
			}
			return { images, rasterizer: candidate.label }
		}
		return { images: all.map((img) => img.path), rasterizer: candidate.label }
	}
	throw new DocumentError(
		"tool-missing",
		`could not rasterize ${pdf} to PNGs — the PDF is usable as-is. Install one of: pdftoppm (poppler-utils), ghostscript, or python3 with pymupdf. Tried: ${failures.join("; ")}`,
		opts.format,
	)
}

function stemPngPattern(stem: string): RegExp {
	return new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.png$`)
}

/** Production defaults for rasterizePdf: real which/run/readdirSync. */
export function defaultRasterizeDeps(): RasterizeDeps {
	return {
		which: defaultWhich,
		run: defaultRun,
		listdir: (dir) => readdirSync(dir),
	}
}

function safeListdir(listdir: (dir: string) => string[], dir: string): string[] {
	try {
		return listdir(dir)
	} catch {
		return []
	}
}

function collectImages(
	listdir: (dir: string) => string[],
	outDir: string,
	stem: string,
): Array<{ path: string; n: number }> {
	const images: Array<{ path: string; n: number }> = []
	for (const entry of listdir(outDir)) {
		const match = stemPngPattern(stem).exec(entry)
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

	const soffice = findSoffice(deps, { format: "pptx", commands: "render", core: "read/create/edit/check" })
	// Isolated profile: a running LibreOffice instance holding the default
	// profile makes a second soffice hang forever — this is the classic
	// headless-conversion stall, and the profile flag sidesteps it.
	const profileDir = deps.mkdtemp(join(tmpdir(), "pptx-render-profile-"))
	try {
		return await convertAndRasterize(deps, soffice, profileDir, inputPath, opts)
	} finally {
		// Isolated profile dirs must not accumulate across renders.
		try {
			rmSync(profileDir, { recursive: true, force: true })
		} catch {
			// best-effort — the OS reclaims temp dirs
		}
	}
}

async function convertAndRasterize(
	deps: Required<RenderDeps>,
	soffice: string,
	profileDir: string,
	inputPath: string,
	opts: RenderOptions,
): Promise<RenderResult> {
	// Sweep stale artifacts of an earlier render of the same deck name from
	// outDir BEFORE converting — running it after would delete this run's own
	// PDF (the name matches), and collectImages matches <stem>-<n>.png, so
	// leftovers would otherwise be picked up as this run's output.
	const stem0 = basename(inputPath).replace(/\.pptx$/i, "")
	// outDir may not exist yet on a fresh render — soffice creates it; nothing to sweep.
	if (deps.fileExists(opts.outDir)) {
		for (const entry of deps.listdir(opts.outDir)) {
			if (entry === `${stem0}.pdf` || /^Q${stem0}E-\d+\.png$/.test(entry)) {
				try {
					unlinkSync(join(opts.outDir, entry))
				} catch {
					// best-effort — a locked file just leaves a stale PNG
				}
			}
		}
	}
	const conversion = deps.run(soffice, [
		"--headless",
		"--norestore",
		"--nolockcheck",
		`-env:UserInstallation=${pathToFileURL(profileDir).href}`,
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

	const { images } = rasterizePdf(deps, pdf, { outDir: opts.outDir, pages: opts.slides, format: "pptx" })
	return { pdf, images }
}
