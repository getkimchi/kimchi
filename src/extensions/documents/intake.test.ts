import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InputEvent, InputEventResult, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { makeSimpleDocx } from "./fixtures/builders.js"
import documentIntakeExtension, {
	docSkillForPath,
	documentStubLine,
	readRedirectReason,
	stubDocumentFileBlocks,
} from "./intake.js"

// The real upstream @file processor, loaded by file URL because the deep
// path is outside the package's exports map (same pattern as
// export-template-fixes.test.ts). Inputs built with it cannot drift from
// the block format this extension rewrites.
const { processFileArguments } = (await import(
	fileURLToPath(
		new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli/file-processor.js", import.meta.url),
	)
)) as typeof import("@earendil-works/pi-coding-agent/dist/cli/file-processor.js")
// Fails fast if the module's layout or signature changes under the ambient
// declaration (the deep path has no type-level link to the real code).
expect(typeof processFileArguments).toBe("function")

let workDir: string

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "intake-"))
})

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true })
})

function write(name: string, bytes: Uint8Array | string): string {
	const p = join(workDir, name)
	mkdirSync(dirname(p), { recursive: true })
	writeFileSync(p, bytes)
	return p
}

/** Bytes that decode as lossy UTF-8 (the bug being guarded): %PDF- head plus
 *  invalid sequences, like a real (compressed) PDF body. */
function pdfBytes(): Buffer {
	return Buffer.concat([Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), Buffer.alloc(64, 0xff)])
}

function readCall(path: string): ToolCallEvent {
	return { type: "tool_call", toolName: "read", toolCallId: "t1", input: { path } } as ToolCallEvent
}

/** Minimal harness: registers the extension once and exposes typed handlers. */
function makeHarness() {
	const harness = createExtensionApi()
	documentIntakeExtension(harness.api)
	return {
		read: (path: string, cwd = workDir) =>
			harness.getHandler<ToolCallEvent, ToolCallEventResult | undefined>("tool_call")(
				readCall(path),
				createContext({ cwd }),
			),
		input: (text: string, source: InputEvent["source"] = "interactive") =>
			harness.getHandler<InputEvent, InputEventResult | undefined>("input")(
				{ type: "input", text, source } as InputEvent,
				createContext(),
			),
	}
}

describe("docSkillForPath", () => {
	it.each([
		["a.pdf", "pdf"],
		["dir/report.DOCX", "docx"],
		["C:\\x\\y.XLSX", "xlsx"],
		["deck.Pptx", "pptx"],
		["budget.xlsm", "xlsx"],
		["memo.docm", "docx"],
		["C:\\d\\deck.pptm", "pptx"],
	])("%s → %s", (path, skill) => {
		expect(docSkillForPath(path)).toBe(skill)
	})

	it.each(["a.txt", "data.csv", "memo.doc", "slides.ppt", "book.ods", "noext", ".pdf"])("%s → undefined", (path) => {
		expect(docSkillForPath(path)).toBeUndefined()
	})
})

describe("read guard (tool_call)", () => {
	it("blocks read on a binary pdf, naming the doc-cli command with the path as passed", async () => {
		write("contract.pdf", pdfBytes())
		const result = await makeHarness().read("contract.pdf")
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("kimchi doc-cli pdf read contract.pdf"),
		})
	})

	it("blocks read on an OOXML document (zip head) and an xlsx in a subdirectory", async () => {
		write("memo.docx", await makeSimpleDocx())
		write(join("sub", "budget.xlsx"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(16)]))
		const h = makeHarness()
		expect((await h.read("memo.docx"))?.block).toBe(true)
		expect((await h.read(join("sub", "budget.xlsx")))?.reason).toContain("kimchi doc-cli xlsx read")
	})

	it("routes macro-enabled OOXML variants to their sibling skill", async () => {
		write("budget.xlsm", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]))
		write("deck.pptm", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(8)]))
		const h = makeHarness()
		expect((await h.read("budget.xlsm"))?.reason).toContain("kimchi doc-cli xlsx read budget.xlsm")
		expect((await h.read("deck.pptm"))?.reason).toContain("kimchi doc-cli pptx read deck.pptm")
	})

	it("fails open on a file shorter than the magic (guard needs no minimum size)", async () => {
		write("tiny.pptx", Buffer.from("PK"))
		expect(await makeHarness().read("tiny.pptx")).toBeUndefined()
	})

	it.each([
		["plain text renamed .pdf stays readable by read", "notes.pdf", "just plain text\n"],
		["non-document extensions are untouched", "readme.txt", "hello\n"],
		["csv stays on the plain path", "data.csv", "a,b\n1,2\n"],
	])("%s", async (_name, file, content) => {
		write(file, content)
		expect(await makeHarness().read(file)).toBeUndefined()
	})

	it("fails open on a missing file so read reports the error itself", async () => {
		expect(await makeHarness().read("ghost.pdf")).toBeUndefined()
	})

	it("ignores input without a string path", async () => {
		const harness = createExtensionApi()
		documentIntakeExtension(harness.api)
		const handler = harness.getHandler<ToolCallEvent, ToolCallEventResult | undefined>("tool_call")
		expect(
			await handler(
				{ type: "tool_call", toolName: "read", toolCallId: "t", input: {} } as ToolCallEvent,
				createContext(),
			),
		).toBeUndefined()
	})
})

describe("@file stub (input transform)", () => {
	it("replaces a real upstream @file block with a stub, keeping the trailing prompt", async () => {
		const p = write("contract.pdf", pdfBytes())
		// Built by upstream itself, so the block format cannot drift in the test.
		const { text } = await processFileArguments([p])
		expect(text).toContain("<file name=")
		expect(text).toContain("\uFFFD") // precondition: upstream inlined garbage

		const h = makeHarness()
		const result = await h.input(`${text}Summarize the terms.`)
		expect(result).toEqual({ action: "transform", text: expect.any(String) })
		const stubbed = (result as { text: string }).text
		expect(stubbed).not.toContain("\uFFFD")
		expect(stubbed).toContain(`<file name="${p}">`)
		expect(stubbed).toMatch(/\[binary PDF file, \d+ B, not inlined\. Read it with: /)
		// The command quotes the path when the platform's separators fall
		// outside the bare-token charset (Windows backslashes), so accept the
		// bare and the single-quoted form.
		expect(stubbed.includes(`kimchi doc-cli pdf read ${p}`) || stubbed.includes(`kimchi doc-cli pdf read '${p}'`)).toBe(
			true,
		)
		expect(stubbed.endsWith("Summarize the terms.")).toBe(true)
	})

	it("stubs only the document block when a text file is attached too", async () => {
		const pdf = write("a.pdf", pdfBytes())
		const md = write("notes.md", "# Notes\nplain text\n")
		const { text } = await processFileArguments([pdf, md])
		const result = await makeHarness().input(text)
		const stubbed = (result as { text: string }).text
		expect(stubbed).toContain("[binary PDF file,")
		expect(stubbed).toContain("# Notes\nplain text")
	})

	it("stubs every document block when two are attached, preserving the trailing text", async () => {
		const pdf = write("one.pdf", pdfBytes())
		const pptx = write("two.pptx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0x41)]))
		const { text } = await processFileArguments([pdf, pptx])
		const result = await makeHarness().input(`${text}and that is all.`)
		const stubbed = (result as { text: string }).text
		expect(stubbed).toContain(`<file name="${pdf}">`)
		expect(stubbed).toContain(`<file name="${pptx}">`)
		expect(stubbed).toContain("[binary PDF file,")
		expect(stubbed).toContain("[binary PPTX file,")
		expect(stubbed).not.toContain("\uFFFD")
		expect(stubbed.endsWith("and that is all.")).toBe(true)
	})

	it("stubs identical duplicate blocks (the same @file attached twice)", async () => {
		const p = write("twice.pdf", pdfBytes())
		const { text } = await processFileArguments([p, p])
		const result = await makeHarness().input(text)
		const stubbed = (result as { text: string }).text
		const occurrences = stubbed.split("[binary PDF file,").length - 1
		expect(occurrences).toBe(2)
		expect(stubbed).not.toContain("\uFFFD")
	})

	it("stubs an over-cap document on magic + length without byte-matching", async () => {
		// Cap pinned to 1 MB so a 4 MB fixture crosses it: the block body is
		// NOT the file's decode (wrong content, but long enough to pass the
		// length precheck), and the stub is still applied — over the cap, the
		// magic + length checks alone justify it.
		const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(4 * 1024 * 1024, 0x41)])
		const p = write("huge.pdf", bytes)
		// Longer than the file, so the length precheck passes; NOT the file's
		// decode, so the byte-match would fail — over the cap it is never run.
		const body = "x".repeat(4 * 1024 * 1024 + 64)
		const block = `<file name="${p}">\n${body}\n</file>\n`
		process.env.KIMCHI_DOCUMENT_MAX_MB = "1"
		try {
			const result = await makeHarness().input(block)
			const stubbed = (result as { text: string }).text
			expect(stubbed).toContain("[binary PDF file, 4.0 MB, not inlined.")
			expect(stubbed).not.toContain(body)
		} finally {
			delete process.env.KIMCHI_DOCUMENT_MAX_MB
		}
	})

	it("leaves text attachments and plain input untouched", async () => {
		const md = write("notes.md", "# Notes\n")
		const { text } = await processFileArguments([md])
		expect(await makeHarness().input(text)).toBeUndefined()
		expect(await makeHarness().input("no attachments here")).toBeUndefined()
	})

	it("leaves a look-alike block alone (content does not byte-match the file)", async () => {
		const p = write("contract.pdf", pdfBytes())
		const lookalike = `<file name="${p}">\nuser typed this, not the pipeline\n</file>\n`
		expect(await makeHarness().input(lookalike)).toBeUndefined()
	})

	it("leaves a block alone whose windows-style name matches no file on this platform", async () => {
		const lookalike = `<file name="C:\\Users\\me\\deck.pptx">\nnot on this disk\n</file>\n`
		expect(await makeHarness().input(lookalike)).toBeUndefined()
	})

	it("leaves extension-sourced input alone", async () => {
		const p = write("contract.pdf", pdfBytes())
		const { text } = await processFileArguments([p])
		expect(await makeHarness().input(text, "extension")).toBeUndefined()
	})
})

describe("reason and stub text", () => {
	it("readRedirectReason names the skill, the format, and a shell-quoted path", () => {
		expect(readRedirectReason("docs/spec v2.pdf", "pdf")).toBe(
			"docs/spec v2.pdf is a binary PDF file — the read tool would return raw bytes, not readable text. Read it with the bundled pdf skill instead: kimchi doc-cli pdf read 'docs/spec v2.pdf'",
		)
	})

	it("keeps plain paths unquoted, anchors dash-prefixed names, and strips control characters", () => {
		const reason = readRedirectReason("a\nb.pdf", "pdf")
		expect(reason).not.toContain("\n")
		expect(reason).toContain("a b.pdf is a binary PDF file")
		expect(reason).toContain("kimchi doc-cli pdf read 'a b.pdf'")
		expect(readRedirectReason("contract.pdf", "pdf")).toContain("kimchi doc-cli pdf read contract.pdf")
		// Dash-prefixed names are ./-anchored: quoting alone cannot keep them out
		// of the CLI's flag parsing (the shell strips quotes before argv). A
		// foreign leading tilde (~user/…) is anchored the same way — the shell
		// would expand it — while the user's own ~/… stays bare (the guard's
		// path resolution expands it identically).
		expect(readRedirectReason("--weird.pdf", "pdf")).toContain("kimchi doc-cli pdf read ./--weird.pdf")
		expect(readRedirectReason("-dash report.pdf", "pdf")).toContain("kimchi doc-cli pdf read './-dash report.pdf'")
		// The single-quote escape branch: a path containing ' must stay one
		// shell argument when the suggested command is copy-pasted.
		expect(readRedirectReason("it's a draft.pdf", "pdf")).toContain("kimchi doc-cli pdf read 'it'\\''s a draft.pdf'")
		expect(documentStubLine("/a/it's a draft.pdf", "pdf", 512)).toContain(
			"kimchi doc-cli pdf read '/a/it'\\''s a draft.pdf'",
		)
		expect(readRedirectReason("~root/secret.pdf", "pdf")).toContain("kimchi doc-cli pdf read ./~root/secret.pdf")
		expect(readRedirectReason("~/notes.pdf", "pdf")).toContain("kimchi doc-cli pdf read ~/notes.pdf")
	})

	it("documentStubLine formats sizes", () => {
		expect(documentStubLine("/a/b.pdf", "pdf", 512)).toContain("512 B")
		expect(documentStubLine("/a/b.pdf", "pdf", 923_997)).toContain("902 KB")
		expect(documentStubLine("/a/b.xlsx", "xlsx", 3 * 1024 * 1024)).toContain("3.0 MB")
		expect(documentStubLine("/a/b.xlsx", "xlsx", 3 * 1024 * 1024)).toContain("XLSX")
	})
})

describe("stubDocumentFileBlocks (unit)", () => {
	it("returns undefined for text without file blocks", async () => {
		expect(await stubDocumentFileBlocks("just a prompt", workDir)).toBeUndefined()
	})

	it("returns undefined when the document file no longer exists", async () => {
		const gone = join(workDir, "gone.pdf")
		const block = `<file name="${gone}">\n${pdfBytes().toString("utf-8")}\n</file>\n`
		expect(await stubDocumentFileBlocks(block, workDir)).toBeUndefined()
	})

	it("finds the true span when the document's own decode contains a terminator", async () => {
		// A PDF whose bytes include the literal ASCII `\n</file>\n`: the first
		// terminator truncates the block body and the byte-match fails, so the
		// scan retries the next terminator and finds the genuine span.
		const bytes = Buffer.concat([Buffer.from("%PDF-1.4\nbefore\n</file>\nafter\n"), Buffer.alloc(32, 0x41)])
		const p = write("embedded.pdf", bytes)
		const text = `<file name="${p}">\n${bytes.toString("utf-8")}\n</file>\nSummarize.`
		const result = await stubDocumentFileBlocks(text, workDir)
		expect(result).toBeDefined()
		expect(result).toContain("[binary PDF file,")
		expect(result).not.toContain("\uFFFD")
		expect(result?.endsWith("Summarize.")).toBe(true)
	})

	it("resolves relative block names against the given cwd", async () => {
		write("relative.pdf", pdfBytes())
		// A hand-typed relative name that byte-matches the file it names — the
		// stub applies only when the name resolves against the given cwd.
		const text = `<file name="relative.pdf">\n${pdfBytes().toString("utf-8")}\n</file>\n`
		expect(await stubDocumentFileBlocks(text, workDir)).toContain("[binary PDF file,")
		expect(await stubDocumentFileBlocks(text, "/nonexistent-cwd")).toBeUndefined()
	})
})
