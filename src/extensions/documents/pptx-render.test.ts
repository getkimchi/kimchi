import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DocumentError } from "./model.js"
import { type RenderDeps, renderPptx } from "./pptx-render.js"

const OUT = join(tmpdir(), "kimchi-render-test-fake-out")
const INPUT = join(tmpdir(), "decks", "kimchi.pptx")
const PDF = join(OUT, "kimchi.pdf")
const PREFIX = join(OUT, "kimchi")

interface RunResult {
	code: number
	stdout?: string
	stderr?: string
	signal?: NodeJS.Signals
}

function harness(opts: {
	which: Record<string, string | undefined>
	run?: (cmd: string, args: string[]) => RunResult
	listdir?: string[]
	fileExists?: (p: string) => boolean
}) {
	const calls: Array<{ cmd: string; args: string[] }> = []
	const deps: RenderDeps = {
		which: (cmd) => opts.which[cmd],
		run: (cmd, args) => {
			calls.push({ cmd, args })
			const r = opts.run ? opts.run(cmd, args) : { code: 0 }
			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", signal: r.signal }
		},
		fileExists: opts.fileExists ?? ((p) => p === PDF),
		listdir: () => opts.listdir ?? ["kimchi-1.png", "kimchi-2.png", "notes.txt"],
		mkdtemp: (prefix) => `${prefix}t1`,
	}
	return { calls, deps }
}

describe("renderPptx", () => {
	it("converts with soffice under an isolated profile, then rasterizes with pdftoppm", async () => {
		const { calls, deps } = harness({ which: { soffice: "/usr/bin/soffice", pdftoppm: "/usr/bin/pdftoppm" } })
		const result = await renderPptx(INPUT, { outDir: OUT, deps })
		expect(result.pdf).toBe(PDF)
		expect(result.images).toEqual([`${PREFIX}-1.png`, `${PREFIX}-2.png`])
		expect(calls[0].cmd).toBe("/usr/bin/soffice")
		expect(calls[0].args).toContain("--headless")
		expect(calls[0].args).toContain("--convert-to")
		expect(calls[0].args.some((a) => a.startsWith("-env:UserInstallation=file://"))).toBe(true)
		expect(calls[1]).toEqual({ cmd: "/usr/bin/pdftoppm", args: ["-png", "-r", "110", PDF, PREFIX] })
	})

	it("falls back to ghostscript when poppler is absent", async () => {
		const { calls, deps } = harness({ which: { soffice: "soffice", gs: "gs" } })
		const result = await renderPptx(INPUT, { outDir: OUT, deps })
		expect(result.images).toHaveLength(2)
		expect(calls[1].cmd).toBe("gs")
		expect(calls[1].args).toContain(`-sOutputFile=${PREFIX}-%02d.png`)
	})

	it("falls back to python3+pymupdf when poppler and ghostscript are absent", async () => {
		const { calls, deps } = harness({ which: { soffice: "soffice", python3: "python3" } })
		await renderPptx(INPUT, { outDir: OUT, deps })
		expect(calls[1].cmd).toBe("python3")
		expect(calls[1].args[0]).toBe("-c")
		expect(calls[1].args[1]).toContain("import pymupdf")
	})

	it("throws tool-missing when soffice is nowhere on the machine", async () => {
		const { deps } = harness({ which: {} })
		await expect(renderPptx(INPUT, { outDir: OUT, deps })).rejects.toMatchObject({
			code: "tool-missing",
			message: expect.stringContaining("brew install --cask libreoffice"),
		} satisfies Partial<DocumentError>)
	})

	it("surfaces LibreOffice stderr when conversion fails", async () => {
		const { deps } = harness({
			which: { soffice: "soffice" },
			run: (cmd) => (cmd === "soffice" ? { code: 1, stderr: "Error: source file could not be loaded\n" } : { code: 0 }),
		})
		await expect(renderPptx(INPUT, { outDir: OUT, deps })).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("source file could not be loaded"),
		} satisfies Partial<DocumentError>)
	})

	it("catches soffice reporting success without producing a PDF", async () => {
		const { deps } = harness({ which: { soffice: "soffice" }, fileExists: () => false })
		await expect(renderPptx(INPUT, { outDir: OUT, deps })).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("produced no PDF"),
		} satisfies Partial<DocumentError>)
	})

	it("keeps the PDF and reports each tried rasterizer when none can run", async () => {
		const { deps } = harness({
			which: { soffice: "soffice", pdftoppm: "pdftoppm" },
			run: (cmd) => (cmd === "pdftoppm" ? { code: 1, stderr: "pdftoppm crashed" } : { code: 0 }),
		})
		await expect(renderPptx(INPUT, { outDir: OUT, deps })).rejects.toMatchObject({
			code: "tool-missing",
			message: expect.stringMatching(
				/usable as-is.*pdftoppm \(poppler\): pdftoppm crashed.*ghostscript: not installed/s,
			),
		} satisfies Partial<DocumentError>)
	})

	it("maps a signal-killed soffice run to a timeout error", async () => {
		const { deps } = harness({
			which: { soffice: "soffice" },
			run: () => ({ code: 1, signal: "SIGTERM" }),
		})
		await expect(renderPptx(INPUT, { outDir: OUT, deps })).rejects.toMatchObject({
			code: "timeout",
		} satisfies Partial<DocumentError>)
	})

	it("honors the --slides window and rejects selections that match nothing", async () => {
		const { deps } = harness({
			which: { soffice: "soffice", pdftoppm: "pdftoppm" },
			listdir: ["kimchi-1.png", "kimchi-2.png", "kimchi-3.png"],
		})
		const sliced = await renderPptx(INPUT, { outDir: OUT, slides: { start: 2, end: 3 }, deps })
		expect(sliced.images).toEqual([`${PREFIX}-2.png`, `${PREFIX}-3.png`])
		await expect(renderPptx(INPUT, { outDir: OUT, slides: { start: 9, end: 9 }, deps })).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("selected none of the 3"),
		} satisfies Partial<DocumentError>)
	})
})
