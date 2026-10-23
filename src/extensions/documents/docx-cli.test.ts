import { describe, expect, it } from "vitest"
import { runDocxCli } from "./docx-cli.js"
import { makeCustomDocx, makeSimpleDocx } from "./fixtures/builders.js"

function ioCapture(files: Record<string, Uint8Array> = {}) {
	const out: string[] = []
	const err: string[] = []
	const writes: Record<string, Uint8Array> = {}
	const io = {
		stdout: (line: string) => out.push(line),
		stderr: (line: string) => err.push(line),
		readFile: (path: string) => {
			const hit = files[path]
			if (!hit) throw new Error(`ENOENT: ${path}`)
			return hit
		},
		writeFile: (path: string, data: Uint8Array) => {
			writes[path] = data
		},
	}
	return { io, out, err, writes }
}

async function withEnvCap<T>(mb: number | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.KIMCHI_DOCUMENT_MAX_MB
	if (mb === undefined) delete process.env.KIMCHI_DOCUMENT_MAX_MB
	else process.env.KIMCHI_DOCUMENT_MAX_MB = String(mb)
	try {
		return await fn()
	} finally {
		if (prev === undefined) delete process.env.KIMCHI_DOCUMENT_MAX_MB
		else process.env.KIMCHI_DOCUMENT_MAX_MB = prev
	}
}

describe("docx-cli read", () => {
	it("reports malformed XML as a typed corrupt error (exit 2, no stack trace)", async () => {
		const bad = await makeCustomDocx("<w:p><w:r><w:t>oops")
		const { io, err } = ioCapture({ "bad.docx": bad })
		const code = await runDocxCli(["read", "bad.docx"], io)
		expect(code).toBe(2)
		expect(err[0]).toContain("error [corrupt]:")
		expect(err[0]).not.toContain("Error:")
	})

	it("renders a window with the file header and locators", async () => {
		const { io, out, err } = ioCapture({ "in.docx": await makeSimpleDocx() })
		const code = await runDocxCli(["read", "in.docx"], io)
		expect(code).toBe(0)
		expect(out[0]).toContain("in.docx (docx — blocks 1-9 of 9)")
		expect(out[0]).toContain("p1: # Quarterly Report")
		expect(out[0]).toContain("[table 1]")
		expect(err).toHaveLength(0)
	})

	it("emits a continuation hint beyond the window", async () => {
		const paras = Array.from({ length: 700 }, (_, i) => `<w:p><w:r><w:t>line ${i}</w:t></w:r></w:p>`).join("")
		const { io, err, out } = ioCapture({ "big.docx": await makeCustomDocx(paras) })
		expect(await runDocxCli(["read", "big.docx", "1-500"], io)).toBe(0)
		expect(err[0]).toContain("continue with: read big.docx 501-700")
		expect(out[0]).toContain("blocks 1-500 of 700")
	})

	it("rejects windows over 500 blocks", async () => {
		const { io, err } = ioCapture({ "in.docx": await makeSimpleDocx() })
		expect(await runDocxCli(["read", "in.docx", "1-600"], io)).toBe(2)
		expect(err[0]).toContain("capped at 500 blocks")
	})

	it("enforces the size cap with a typed too-large error", async () => {
		// KIMCHI_DOCUMENT_MAX_MB is integer MB; build >1 MB of random text so
		// the compressed package still clears a 1 MB cap.
		const { randomBytes } = await import("node:crypto")
		const big = randomBytes(1_200_000).toString("base64")
		const { io, err } = ioCapture({ "in.docx": await makeCustomDocx(`<w:p><w:r><w:t>${big}</w:t></w:r></w:p>`) })
		const code = await withEnvCap(1, () => runDocxCli(["read", "in.docx"], io))
		expect(code).toBe(2)
		expect(err[0]).toContain("error [too-large]")
	})
})

describe("docx-cli info", () => {
	it("prints counts, core properties and the outline", async () => {
		const { io, out } = ioCapture({ "in.docx": await makeSimpleDocx() })
		expect(await runDocxCli(["info", "in.docx"], io)).toBe(0)
		const text = out[0]
		expect(text).toContain("blocks: 9 (1 table), images: 0")
		expect(text).toContain("title: Simple fixture")
		expect(text).toContain("creator: kimchi-tests")
		expect(text).toContain("tracked changes: yes")
		expect(text).toContain("comments: 1")
		expect(text).toContain("footnotes: 1")
		expect(text).toContain("b1: # Quarterly Report")
	})
})

describe("docx-cli create", () => {
	it("creates a docx that reads back with the same text", async () => {
		const md = "# Demo\n\nHello **world**.\n\n- one\n- two\n"
		const { io, out, writes, err } = ioCapture({ "c.md": new TextEncoder().encode(md) })
		expect(await runDocxCli(["create", "demo.docx", "--content", "c.md"], io)).toBe(0)
		expect(out[0]).toContain("created demo.docx")
		const created = writes["demo.docx"]
		expect(created).toBeDefined()
		// Read the created file back through read.
		const read = ioCapture({ "demo.docx": created })
		expect(await runDocxCli(["read", "demo.docx"], read.io)).toBe(0)
		expect(read.out[0]).toContain("p1: # Demo")
		expect(read.out[0]).toContain("Hello world.")
		expect(read.out[0]).toContain("p3: - one")
		expect(err).toHaveLength(0)
	})

	it("requires .docx output and --content", async () => {
		const { io, err } = ioCapture()
		expect(await runDocxCli(["create", "out.pptx", "--content", "c.md"], io)).toBe(2)
		expect(err[0]).toContain("must end in .docx")
		expect(await runDocxCli(["create", "out.docx"], io)).toBe(2)
		expect(err[1]).toContain("needs --content")
	})

	it("rejects --out identical to --content", async () => {
		const { io, err } = ioCapture({ "c.docx": new TextEncoder().encode("# x") })
		expect(await runDocxCli(["create", "c.docx", "--content", "c.docx"], io)).toBe(2)
		expect(err[0]).toContain("must differ")
	})

	it("applies a style template's styles.xml over the generated package", async () => {
		const template = await makeCustomDocx("<w:p><w:r><w:t>template</w:t></w:r></w:p>", {
			"word/styles.xml": `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style></w:styles>`,
		})
		const { io, writes } = ioCapture({ "c.md": new TextEncoder().encode("# T"), "tpl.dotx": template })
		expect(await runDocxCli(["create", "t.docx", "--content", "c.md", "--template", "tpl.dotx"], io)).toBe(0)
		const { openOoxml } = await import("./ooxml/package.js")
		const pkg = await openOoxml(writes["t.docx"])
		expect(new TextDecoder().decode(pkg.getBytes("word/styles.xml"))).toContain("FF0000")
	})

	it("rejects a non-docx template path", async () => {
		const { io, err } = ioCapture({ "c.md": new TextEncoder().encode("# T") })
		expect(await runDocxCli(["create", "t.docx", "--content", "c.md", "--template", "tpl.pptx"], io)).toBe(2)
		expect(err[0]).toContain("template must be a .docx or .dotx")
	})
})

describe("docx-cli usage", () => {
	it("prints usage on no command and errors on unknown", async () => {
		const a = ioCapture()
		expect(await runDocxCli([], a.io)).toBe(2)
		expect(a.out[0]).toContain("usage: docx.mjs")
		const b = ioCapture()
		expect(await runDocxCli(["frobnicate"], b.io)).toBe(2)
		expect(b.err[0]).toContain('unknown command "frobnicate"')
	})
})

describe("typed errors and render", () => {
	it("rejects .doc and OLE2 containers with unsupported-format and a hint", async () => {
		const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4])
		const { io, err } = ioCapture({ "old.doc": ole })
		expect(await runDocxCli(["read", "old.doc"], io)).toBe(2)
		expect(err[0]).toContain("error [unsupported-format]")
		expect(err[0]).toContain("soffice --convert-to docx")
	})

	it("render degrades to tool-missing without LibreOffice", async () => {
		const { io, err } = ioCapture({ "a.docx": await makeSimpleDocx() })
		const prev = process.env.KIMCHI_SOFFICE
		try {
			process.env.KIMCHI_SOFFICE = "/nonexistent/soffice"
			expect(await runDocxCli(["render", "a.docx", "--out", "a.pdf"], io)).toBe(2)
			expect(err[0]).toContain("error [tool-missing]")
		} finally {
			if (prev === undefined) delete process.env.KIMCHI_SOFFICE
			else process.env.KIMCHI_SOFFICE = prev
		}
	})
})
