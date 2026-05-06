import { parseFrontmatter } from "@mariozechner/pi-coding-agent"

export interface BehaviourFrontmatter {
	name: string
	description: string
}

export interface ParsedBehaviourBody {
	frontmatter: BehaviourFrontmatter
	content: string
}

export function parseBehaviourBody(raw: string): ParsedBehaviourBody {
	const { frontmatter, body } = parseFrontmatter<Partial<BehaviourFrontmatter>>(raw)
	if (!raw.trimStart().startsWith("---")) {
		throw new Error("behaviour body is missing frontmatter delimited by '---' lines")
	}
	const { name, description } = frontmatter
	if (!name) throw new Error("behaviour frontmatter is missing required field: name")
	if (!description) throw new Error(`behaviour ${name} frontmatter is missing required field: description`)
	return { frontmatter: { name, description }, content: body.trim() }
}
