import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractPptx } from "./extractors/pptx.js"
import { makeDefectivePptx, makeSimplePptx } from "./fixtures/builders.js"
import { runPptxCli } from "./pptx-cli.js"
import type { RenderDeps } from "./pptx-render.js"

function io() {
	const out: string[] = []
	const err: string[] = []
	const files = new Map<string, Uint8Array>()
	return {
		out,
		err,
		files,
		io: {
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
			readFile: (path: string) => {
				const data = files.get(path)
				if (!data) throw new Error(`ENOENT: ${path}`)
				return data
			},
		},
	}
}

describe("pptx.mjs read", () => {
	it("renders the extractor's markdown through the shared renderer (one renderer, two callers)", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		expect(await runPptxCli(["read", "deck.pptx"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain("## Slide 1")
		expect(t.out.join("\n")).toContain('[shape "Title 1"]')
		expect(t.out.join("\n")).toContain("| H1 | H2 |")
		expect(t.out.join("\n")).toContain("Remember to thank sponsors")
		expect(t.out.join("\n")).toContain("*hidden slide*")
	})

	it("honors explicit slide ranges", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		expect(await runPptxCli(["read", "deck.pptx", "2-2"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain("## Slide 2")
		expect(t.out.join("\n")).toContain("Closing remarks")
		expect(t.out.join("\n")).not.toContain("## Slide 1")
	})

	it("rejects a missing file with a typed error and exit 2", async () => {
		const t = io()
		expect(await runPptxCli(["read", "missing.pptx"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("error [corrupt]: Cannot read missing.pptx")
	})

	it("rejects an over-cap file with typed error too-large", async () => {
		const t = io()
		process.env.KIMCHI_DOCUMENT_MAX_MB = "1"
		try {
			t.files.set("big.pptx", new Uint8Array(1_500_000).fill(0x50))
			expect(await runPptxCli(["read", "big.pptx"], t.io)).toBe(2)
			expect(t.err.join("\n")).toContain("error [too-large]")
		} finally {
			delete process.env.KIMCHI_DOCUMENT_MAX_MB
		}
	})

	it("rejects a corrupt package", async () => {
		const t = io()
		t.files.set("junk.pptx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
		expect(await runPptxCli(["check", "junk.pptx"], t.io)).toBe(2)
		expect(t.err.join("\n")).toMatch(/error \[(corrupt|safety-limit)\]/)
	})
})

describe("pptx.mjs create", () => {
	it("creates a deck that reads back with matching content", async () => {
		const t = io()
		t.files.set(
			"deck.md",
			new TextEncoder().encode(
				"# Kickoff\n\n- one\n- two\n\nNotes: planner only\n\n---\n\n## Wrap\n\n| A | B |\n| - | - |\n| 1 | 2 |\n",
			),
		)
		const written = new Map<string, Uint8Array>()
		const code = await runPptxCli(["create", "out.pptx", "--content", "deck.md"], {
			...t.io,
			writeFile: (path, data) => written.set(path, data),
		})
		expect(code).toBe(0)
		expect(t.out.join("\n")).toContain("created out.pptx (2 slides)")
		const doc = await extractPptx(written.get("out.pptx") ?? new Uint8Array())
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].markdown).toContain("one")
		expect(doc.units[0].markdown).toContain("planner only")
		expect(doc.units[1].markdown).toContain("| A | B |")
	})

	it("errors on missing --content and on non-pptx output", async () => {
		const t = io()
		expect(await runPptxCli(["create", "out.pptx"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("create needs --content")
		const t2 = io()
		t2.files.set("deck.md", new TextEncoder().encode("# A\n\n- b\n"))
		expect(await runPptxCli(["create", "out.docx", "--content", "deck.md"], t2.io)).toBe(2)
		expect(t2.err.join("\n")).toContain("must end in .pptx")
	})
})

describe("pptx.mjs render", () => {
	const renderDeps: RenderDeps = {
		which: (cmd) => (cmd === "soffice" || cmd === "pdftoppm" ? `/usr/bin/${cmd}` : undefined),
		run: () => ({ code: 0, stdout: "", stderr: "" }),
		fileExists: (p) => p.endsWith("deck.pdf"),
		// Like readdirSync: bare entry names, not paths.
		listdir: () => ["deck-1.png", "deck-2.png"],
		mkdtemp: (prefix) => `${prefix}t1`,
	}

	it("prints one PNG path per line and exits 0", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		const code = await runPptxCli(["render", "deck.pptx", "--out", "pngs"], { ...t.io, renderDeps })
		expect(code).toBe(0)
		expect(t.out).toEqual([join("pngs", "deck-1.png"), join("pngs", "deck-2.png")])
	})

	it("passes the --slides window through to the renderer", async () => {
		const t = io()
		t.files.set("deck.pptx", await makeSimplePptx())
		const code = await runPptxCli(["render", "deck.pptx", "--out", "pngs", "--slides", "2-2"], {
			...t.io,
			renderDeps: {
				...renderDeps,
				listdir: () => ["deck-1.png", "deck-2.png", "deck-3.png"],
			},
		})
		expect(code).toBe(0)
		expect(t.out).toEqual([join("pngs", "deck-2.png")])
	})

	it("errors without --out and without a deck", async () => {
		const t = io()
		expect(await runPptxCli(["render", "deck.pptx"], { ...t.io, renderDeps })).toBe(2)
		expect(t.err.join("\n")).toContain("render needs --out")
		expect(await runPptxCli(["render"], { ...t.io, renderDeps })).toBe(2)
		expect(t.err.join("\n")).toContain("render needs a deck path")
	})
})

describe("pptx.mjs check / inspect", () => {
	it("check prints locator-carrying findings", async () => {
		const t = io()
		t.files.set("defect.pptx", await makeDefectivePptx())
		expect(await runPptxCli(["check", "defect.pptx"], t.io)).toBe(1)
		expect(t.out.join("\n")).toContain('slide 1 [shape "Body Overflow"] text-overflow: likely text overflow')
	})

	it("unknown command prints usage to stderr, exit 2", async () => {
		const t = io()
		expect(await runPptxCli(["frobnicate"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain('unknown command "frobnicate"')
	})
})
