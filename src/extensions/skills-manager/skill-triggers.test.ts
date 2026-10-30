import { describe, expect, it, vi } from "vitest"
import {
	buildTriggerRegistry,
	isModelInvocationDisabled,
	matchPrompt,
	parseSkillCommand,
	parseSkillTriggers,
} from "./skill-triggers.js"

const docWith = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# body\n`

describe("parseSkillTriggers", () => {
	it("parses the map form into case-insensitive regexes", () => {
		const { prompt } = parseSkillTriggers(docWith("name: pdf\ntriggers:\n  prompt:\n    - '\\.pdf\\b'"))
		expect(prompt).toHaveLength(1)
		expect(prompt[0].test("open report.pdf")).toBe(true)
		expect(prompt[0].test("open REPORT.PDF")).toBe(true)
		expect(prompt[0].test("pdftk extract")).toBe(false)
	})

	it("parses multiple patterns", () => {
		const { prompt } = parseSkillTriggers(docWith("triggers:\n  prompt:\n    - '\\.xlsx\\b'\n    - '\\.xlsm\\b'"))
		expect(prompt).toHaveLength(2)
		expect(prompt.some((re) => re.test("data.xlsm"))).toBe(true)
	})

	it("tolerates the legacy prose-list form as no triggers", () => {
		expect(
			parseSkillTriggers(
				docWith("triggers:\n  - a test or build fails repeatedly and static reasoning stalls\n  - user asks to debug"),
			).prompt,
		).toEqual([])
	})

	it("returns empty when frontmatter or triggers are absent", () => {
		expect(parseSkillTriggers("# no frontmatter at all\n").prompt).toEqual([])
		expect(parseSkillTriggers(docWith("name: pdf\ndescription: nope")).prompt).toEqual([])
		expect(parseSkillTriggers(docWith("triggers: {}")).prompt).toEqual([])
	})

	it("drops an invalid regex with a warning and keeps the valid ones", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { prompt } = parseSkillTriggers(docWith("triggers:\n  prompt:\n    - '[unclosed'\n    - '\\.pdf\\b'"))
			expect(prompt).toHaveLength(1)
			expect(prompt[0].source).toBe("\\.pdf\\b")
			expect(warn).toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("drops non-string entries with a warning", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const { prompt } = parseSkillTriggers(docWith("triggers:\n  prompt:\n    - 42\n    - '\\.pdf\\b'"))
			expect(prompt).toHaveLength(1)
			expect(warn).toHaveBeenCalled()
		} finally {
			warn.mockRestore()
		}
	})

	it("survives malformed frontmatter YAML without throwing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(parseSkillTriggers(docWith("triggers:\n  prompt: [unclosed yaml\n  - x")).prompt).toEqual([])
		} finally {
			warn.mockRestore()
		}
	})
})

describe("buildTriggerRegistry", () => {
	it("omits skills with empty trigger sets and keeps first occurrence per name", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    - 'harness-wins'") },
			{ name: "quiet", content: docWith("name: quiet") },
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    - 'bundled-loses'") },
		])
		expect([...registry.keys()]).toEqual(["pdf"])
		expect(registry.get("pdf")?.map((re) => re.source)).toEqual(["harness-wins"])
	})
})

describe("matchPrompt", () => {
	it("reports each matching skill with the winning pattern", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    - '\\.pdf\\b'") },
			{ name: "docx", content: docWith("triggers:\n  prompt:\n    - '\\.docx\\b'") },
		])
		expect(matchPrompt(registry, "read runbook.pdf then notes.docx")).toEqual([
			{ name: "pdf", pattern: "\\.pdf\\b" },
			{ name: "docx", pattern: "\\.docx\\b" },
		])
		expect(matchPrompt(registry, "nothing here")).toEqual([])
	})

	it("matches the failing session's literal prompt", () => {
		const registry = buildTriggerRegistry([
			{ name: "pdf", content: docWith("triggers:\n  prompt:\n    - '\\.pdf\\b'") },
		])
		const prompt =
			"Autopilot morning: I got the mail migration runbook — ~/q4-mail-migration/mail-migration-runbook-q4-hard.pdf.\nRead it and execute whatever it requires, end to end."
		expect(matchPrompt(registry, prompt)).toEqual([{ name: "pdf", pattern: "\\.pdf\\b" }])
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
