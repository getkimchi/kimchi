import { describe, expect, it, vi } from "vitest"
import {
	buildTriggerRegistry,
	isModelInvocationDisabled,
	matchesExtension,
	matchesKeyword,
	matchPrompt,
	parseSkillCommand,
	parseSkillTriggers,
} from "./skill-triggers.js"

const docWith = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# body\n`

describe("parseSkillTriggers", () => {
	it("parses extensions and keywords from the map form", () => {
		const triggers = parseSkillTriggers(
			docWith("name: pptx\ntriggers:\n  prompt:\n    extensions: [pptx]\n    keywords: [powerpoint, slide deck]"),
		)
		expect(triggers).toEqual({ extensions: ["pptx"], keywords: ["powerpoint", "slide deck"] })
	})

	it("normalizes extensions and keywords", () => {
		const triggers = parseSkillTriggers(
			docWith("triggers:\n  prompt:\n    extensions: ['.PDF', pdf]\n    keywords: ['  Slide   Deck  ', PDF]"),
		)
		expect(triggers).toEqual({ extensions: ["pdf"], keywords: ["slide deck", "pdf"] })
	})

	it("tolerates the legacy prose-list form as no triggers", () => {
		expect(
			parseSkillTriggers(
				docWith("triggers:\n  - a test or build fails repeatedly and static reasoning stalls\n  - user asks to debug"),
			).keywords,
		).toEqual([])
	})

	it("warns and ignores the unreleased regex-array form", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const triggers = parseSkillTriggers(docWith("triggers:\n  prompt:\n    - '\\.pdf\\b'"))
			expect(triggers).toEqual({ extensions: [], keywords: [] })
			expect(warn).toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("returns empty when frontmatter or triggers are absent", () => {
		expect(parseSkillTriggers("# no frontmatter at all\n").extensions).toEqual([])
		expect(parseSkillTriggers(docWith("name: pdf\ndescription: nope")).keywords).toEqual([])
		expect(parseSkillTriggers(docWith("triggers: {}")).extensions).toEqual([])
		expect(parseSkillTriggers(docWith("triggers:\n  prompt: {}")).keywords).toEqual([])
	})

	it("drops invalid entries with a warning and keeps the valid ones", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const triggers = parseSkillTriggers(
				docWith(
					"triggers:\n  prompt:\n    extensions: [pdf, '.p d f', '.waytoolongextensionname', 42]\n    keywords: [excel, x, a-very-long-keyword-that-keeps-going-and-going-past-any-reasonable-bound-for-a-trigger-phrase]",
				),
			)
			expect(triggers).toEqual({ extensions: ["pdf"], keywords: ["excel"] })
			expect(warn).toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("truncates a list at 16 entries", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const many = Array.from({ length: 20 }, (_, i) => `kw${i}`)
			const triggers = parseSkillTriggers(docWith(`triggers:\n  prompt:\n    keywords: [${many.join(", ")}]`))
			expect(triggers.keywords).toHaveLength(16)
			expect(warn).toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("survives malformed frontmatter YAML without throwing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(parseSkillTriggers(docWith("triggers:\n  prompt: [unclosed yaml\n  - x")).extensions).toEqual([])
		} finally {
			warn.mockRestore()
		}
	})
})

describe("matchesExtension", () => {
	it.each([
		["read report.pdf", "pdf"],
		["read REPORT.PDF", "pdf"],
		["open `a.pdf` first", "pdf"],
		["see (a.pdf).", "pdf"],
		["download https://x.dev/guide.pdf now", "pdf"],
		["~/q4-mail-migration/mail-migration-runbook-q4-hard.pdf", "pdf"],
		["data.XLSX and book.xlsm", "xlsx"],
		["book.xlsm", "xlsm"],
	])("matches %s", (text, ext) => {
		expect(matchesExtension(text, ext)).toBe(true)
	})

	it.each([
		["a.pdfx", "pdf"], // longer extension
		["make it a docx", "docx"], // bare word, no dot
		["pdftk extract", "pdf"],
		["the pdfid file", "pdf"],
		["notes.docx", "pdf"],
	])("does not match %s", (text, ext) => {
		expect(matchesExtension(text, ext)).toBe(false)
	})
})

describe("matchesKeyword", () => {
	it.each([
		["update the spreadsheet", "spreadsheet"],
		["update the spreadsheets", "spreadsheet"], // optional plural
		["Spreadsheets, tables, etc", "spreadsheet"],
		["open the Excel file", "excel"],
		["excel,", "excel"],
		["make a slide deck", "slide deck"], // multi-word
		["make   a   slide\t\ndeck", "slide deck"], // whitespace collapsed
		["powerpoint please", "powerpoint"],
		["PowerPoint", "powerpoint"],
		["x word document y", "word document"],
	])("matches %s", (text, keyword) => {
		expect(matchesKeyword(text, keyword)).toBe(true)
	})

	it.each([
		["spreadsheeting", "spreadsheet"], // plural "s" then more letters
		["xcel file", "excel"], // partial word
		["slide decker", "slide deck"], // partial phrase tail
		["preslidewide", "slide"],
	])("does not match %s", (text, keyword) => {
		expect(matchesKeyword(text, keyword)).toBe(false)
	})
})

describe("buildTriggerRegistry", () => {
	it("omits skills with empty trigger sets and keeps first occurrence per name", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    keywords: [harness-wins]"), origin: "harness" },
			{ name: "quiet", content: docWith("name: quiet"), origin: "harness" },
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    keywords: [bundled-loses]"), origin: "bundled" },
		])
		expect([...registry.keys()]).toEqual(["pdf"])
		expect(registry.get("pdf")?.triggers.keywords).toEqual(["harness-wins"])
		expect(registry.get("pdf")?.origin).toBe("harness")
	})

	it("carries the origin and provenance label through", () => {
		const registry = buildTriggerRegistry([
			{
				name: "vendor",
				content: docWith("triggers:\n  prompt:\n    keywords: [deploy]"),
				origin: "discovered",
				label: "a project skill",
			},
		])
		expect(registry.get("vendor")).toMatchObject({ origin: "discovered", label: "a project skill" })
	})
})

describe("matchPrompt", () => {
	it("reports each matching skill with the winning trigger, in registry order", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    extensions: [pdf]"), origin: "bundled" },
			{ name: "docx", content: docWith("triggers:\n  prompt:\n    keywords: [word document]"), origin: "bundled" },
		])
		expect(matchPrompt(registry, "read runbook.pdf then the word document")).toEqual([
			{ name: "pdf", matched: "ext:.pdf" },
			{ name: "docx", matched: "kw:word document" },
		])
		expect(matchPrompt(registry, "nothing here")).toEqual([])
	})

	it("prefers the extension match over keywords and reports the matched keyword", () => {
		const registry = buildTriggerRegistry([
			{
				name: "pdf",
				content: docWith("triggers:\n  prompt:\n    extensions: [pdf]\n    keywords: [pdf]"),
				origin: "bundled",
			},
		])
		expect(matchPrompt(registry, "read a.pdf")[0].matched).toBe("ext:.pdf")
		expect(matchPrompt(registry, "convert it to pdf")[0].matched).toBe("kw:pdf")
	})

	it("matches the failing session's literal prompt", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    extensions: [pdf]"), origin: "bundled" },
		])
		const prompt =
			"Autopilot morning: I got the mail migration runbook — ~/q4-mail-migration/mail-migration-runbook-q4-hard.pdf.\nRead it and execute whatever it requires, end to end."
		expect(matchPrompt(registry, prompt)).toEqual([{ name: "pdf", matched: "ext:.pdf" }])
	})

	it("stays fast on hostile prompts (no regex from skill content)", () => {
		const registry = buildTriggerRegistry([
			{
				name: "pdf",
				content: docWith(
					"triggers:\n  prompt:\n    extensions: [pdf]\n    keywords: [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]",
				),
				origin: "bundled",
			},
		])
		const hostile = `${"a.".repeat(500_000)}report.pdf ${"aaaa".repeat(250_000)}`
		const started = Date.now()
		expect(matchPrompt(registry, hostile)).toEqual([{ name: "pdf", matched: "ext:.pdf" }])
		expect(Date.now() - started).toBeLessThan(5_000)
	})
})

describe("isModelInvocationDisabled", () => {
	const doc = (fm: string) => `---\n${fm}\n---\n\nbody\n`

	it("is true only for disable-model-invocation: true", () => {
		expect(isModelInvocationDisabled(doc("name: x\ndisable-model-invocation: true"))).toBe(true)
		expect(isModelInvocationDisabled(doc("name: x\ndisable-model-invocation: false"))).toBe(false)
		expect(isModelInvocationDisabled(doc("name: x"))).toBe(false)
	})

	it("never throws on malformed frontmatter", () => {
		expect(isModelInvocationDisabled("---\n:\nbroken")).toBe(false)
		expect(isModelInvocationDisabled("no frontmatter at all")).toBe(false)
	})
})

describe("parseSkillCommand", () => {
	it("parses pi's raw /skill:<name> command form with its args as match text", () => {
		expect(parseSkillCommand("/skill:pdf summarize this")).toEqual({ name: "pdf", matchText: " summarize this" })
		expect(parseSkillCommand("/skill:pdf")).toEqual({ name: "pdf", matchText: "" })
	})

	it("parses the ACP rewrite header form with no match text", () => {
		expect(parseSkillCommand("Invoking skill: docx\n\nbody with .pdf mentions")).toEqual({ name: "docx" })
	})

	it("returns undefined for plain prompts and other slash commands", () => {
		expect(parseSkillCommand("read runbook.pdf")).toBeUndefined()
		expect(parseSkillCommand("/plan do things")).toBeUndefined()
		expect(parseSkillCommand("see /skill:pdf in docs")).toBeUndefined()
	})
})
