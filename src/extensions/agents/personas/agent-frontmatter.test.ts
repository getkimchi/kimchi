import { describe, expect, it } from "vitest"
import { parseAgentFrontmatter } from "./agent-frontmatter.js"

function doc(frontmatter: string, body = "System prompt."): string {
	return `---\n${frontmatter}\n---\n\n${body}`
}

// Unquoted prose with ": " inside — common in agent files written for other
// tools, and rejected by strict YAML.
const PROSE =
	'Use this agent to tidy imports. <example>Context: a file was edited. user: "clean it up" assistant: "On it."</example>'

describe("parseAgentFrontmatter", () => {
	it("returns valid frontmatter unchanged", () => {
		const { frontmatter, body } = parseAgentFrontmatter(
			doc('description: "Quoted: with a colon"\ndisplay_name: Tidy\ntools: read, bash\nmax_turns: 5'),
		)

		expect(frontmatter).toEqual({
			description: "Quoted: with a colon",
			display_name: "Tidy",
			tools: "read, bash",
			max_turns: 5,
		})
		expect(body).toBe("System prompt.")
	})

	it("leaves a block-scalar description to the YAML parser", () => {
		const { frontmatter } = parseAgentFrontmatter(doc("description: >\n  Context: folded\n  text\nname: tidy"))

		expect(frontmatter.description).toBe("Context: folded text\n")
	})

	it("returns an empty frontmatter when the file has none", () => {
		expect(parseAgentFrontmatter("Just a prompt.")).toEqual({ frontmatter: {}, body: "Just a prompt." })
	})

	it("loads an unquoted description that strict YAML rejects, text intact", () => {
		const { frontmatter, body } = parseAgentFrontmatter(doc(`name: tidy\ndescription: ${PROSE}`))

		expect(frontmatter).toEqual({ name: "tidy", description: PROSE })
		expect(body).toBe("System prompt.")
	})

	it("repairs display_name the same way", () => {
		const { frontmatter } = parseAgentFrontmatter(doc("display_name: Tidy: the import fixer\ndescription: tidy"))

		expect(frontmatter.display_name).toBe("Tidy: the import fixer")
	})

	it("keeps the YAML types of the other fields after a repair", () => {
		const { frontmatter } = parseAgentFrontmatter(
			doc(`description: ${PROSE}\nmax_turns: 5\nenabled: false\nmodels:\n  - model-a\n  - model-b`),
		)

		expect(frontmatter).toEqual({
			description: PROSE,
			max_turns: 5,
			enabled: false,
			models: ["model-a", "model-b"],
		})
	})

	it("repairs files with CRLF line endings", () => {
		const { frontmatter, body } = parseAgentFrontmatter(`---\r\ndescription: ${PROSE}\r\n---\r\n\r\nSystem prompt.`)

		expect(frontmatter.description).toBe(PROSE)
		expect(body).toBe("System prompt.")
	})

	it("does not repair a structured field", () => {
		expect(() => parseAgentFrontmatter(doc("description: tidy\ntools: [read, bash"))).toThrow(/flow sequence/i)
	})

	it("throws the original error when a repair is not enough", () => {
		const content = doc(`description: ${PROSE}\ntools: [read, bash`)

		expect(() => parseAgentFrontmatter(content)).toThrow(/Nested mappings are not allowed/)
	})
})
