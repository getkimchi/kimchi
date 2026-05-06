/**
 * Minimal frontmatter parser for bundled behaviour bodies.
 *
 * Bodies look like:
 *
 *     ---
 *     name: git-hygiene
 *     description: ...
 *     ---
 *
 *     <markdown content>
 *
 * The parser is deliberately strict — both `name` and `description` must be
 * present, and the frontmatter delimiters must match the canonical form. Any
 * deviation throws so the build fails fast at registry load.
 */

export interface BehaviourFrontmatter {
	name: string
	description: string
}

export interface ParsedBehaviourBody {
	frontmatter: BehaviourFrontmatter
	content: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const FIELD_RE = /^([a-zA-Z][\w-]*)\s*:\s*(.*)$/

export function parseBehaviourBody(raw: string): ParsedBehaviourBody {
	const match = FRONTMATTER_RE.exec(raw)
	if (!match) {
		throw new Error("behaviour body is missing frontmatter delimited by '---' lines")
	}
	const [, block, rest] = match
	const fields: Record<string, string> = {}
	for (const line of block.split(/\r?\n/)) {
		if (line.trim() === "") continue
		const m = FIELD_RE.exec(line)
		if (!m) throw new Error(`malformed frontmatter line: ${JSON.stringify(line)}`)
		const value = m[2].trim().replace(/^(["'])(.*)\1$/, "$2")
		fields[m[1]] = value
	}
	const name = fields.name
	const description = fields.description
	if (!name) throw new Error("behaviour frontmatter is missing required field: name")
	if (!description) throw new Error(`behaviour ${name} frontmatter is missing required field: description`)
	return {
		frontmatter: { name, description },
		content: rest.trim(),
	}
}
