import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { memoryFrontmatterSchema } from "./types.js"
import type { MemoryEntry, MemoryStore } from "./types.js"

function sanitizeKey(key: string): void {
	if (key.includes("..") || key.includes("/")) {
		throw new Error(`Invalid key: ${key}`)
	}
}

function getScopeDir(
	opts: { userRoot: string; projectRoot: string; localRoot: string },
	scope: "user" | "project" | "local",
): string {
	switch (scope) {
		case "user":
			return opts.userRoot
		case "project":
			return opts.projectRoot
		case "local":
			return opts.localRoot
	}
}

function parseMarkdown(content: string, key: string, scope: "user" | "project" | "local"): MemoryEntry | null {
	const trimmed = content.trimStart()
	if (!trimmed.startsWith("---")) {
		return null
	}

	const endIndex = trimmed.indexOf("---", 3)
	if (endIndex === -1) {
		return null
	}

	const frontmatterText = trimmed.slice(3, endIndex).trim()
	const body = trimmed.slice(endIndex + 3).trimStart()

	let parsed: unknown
	try {
		parsed = parseYaml(frontmatterText)
	} catch {
		return null
	}

	const result = memoryFrontmatterSchema.safeParse(parsed)
	if (!result.success) {
		return null
	}

	return {
		key,
		scope,
		body,
		metadata: result.data,
	}
}

export type MarkdownFsMemoryStoreOptions = { userRoot: string; projectRoot: string; localRoot: string }

export class MarkdownFsMemoryStore implements MemoryStore {
	readonly userRoot: string
	readonly projectRoot: string
	readonly localRoot: string

	constructor(opts: { userRoot: string; projectRoot: string; localRoot: string }) {
		this.userRoot = opts.userRoot
		this.projectRoot = opts.projectRoot
		this.localRoot = opts.localRoot
	}

	async read(scope: "user" | "project" | "local", key: string): Promise<MemoryEntry | null> {
		sanitizeKey(key)
		const scopeDir = getScopeDir(this, scope)
		const filePath = join(scopeDir, `${key}.md`)

		if (!existsSync(filePath)) {
			return null
		}

		const content = readFileSync(filePath, "utf-8")
		return parseMarkdown(content, key, scope)
	}

	async write(entry: MemoryEntry): Promise<void> {
		sanitizeKey(entry.key)
		const scopeDir = getScopeDir(this, entry.scope)
		const filePath = join(scopeDir, `${entry.key}.md`)
		const tmpPath = join(scopeDir, `.${entry.key}.md.tmp`)

		mkdirSync(scopeDir, { recursive: true })

		const frontmatter = stringifyYaml(
			{
				schema_version: entry.metadata.schema_version,
				scope: entry.metadata.scope,
				...(entry.metadata.agent !== undefined ? { agent: entry.metadata.agent } : {}),
				...(entry.metadata.ferment_id !== undefined ? { ferment_id: entry.metadata.ferment_id } : {}),
				created_at: entry.metadata.created_at,
				updated_at: entry.metadata.updated_at,
				tags: entry.metadata.tags,
			},
			{ defaultKeyType: "PLAIN", defaultStringType: "QUOTE_DOUBLE" },
		)

		const content = `---\n${frontmatter}---\n${entry.body}`

		try {
			writeFileSync(tmpPath, content, "utf-8")
			renameSync(tmpPath, filePath)
		} catch (err) {
			try {
				if (existsSync(tmpPath)) {
					unlinkSync(tmpPath)
				}
			} catch {
				// ignore cleanup failure
			}
			throw err
		}
	}

	async list(
		scope: "user" | "project" | "local",
		opts?: { agent?: string; ferment_id?: string },
	): Promise<MemoryEntry[]> {
		const scopeDir = getScopeDir(this, scope)

		if (!existsSync(scopeDir)) {
			return []
		}

		const files = readdirSync(scopeDir).filter((f) => extname(f) === ".md" && !f.startsWith("."))
		const results: MemoryEntry[] = []

		for (const file of files) {
			const key = basename(file, ".md")
			if (key.includes("..") || key.includes("/")) {
				continue
			}
			const filePath = join(scopeDir, file)
			const content = readFileSync(filePath, "utf-8")
			const entry = parseMarkdown(content, key, scope)
			if (!entry) {
				continue
			}
			if (opts?.agent !== undefined && entry.metadata.agent !== opts.agent) {
				continue
			}
			if (opts?.ferment_id !== undefined && entry.metadata.ferment_id !== opts.ferment_id) {
				continue
			}
			results.push(entry)
		}

		return results
	}

	async delete(scope: "user" | "project" | "local", key: string): Promise<void> {
		sanitizeKey(key)
		const scopeDir = getScopeDir(this, scope)
		const filePath = join(scopeDir, `${key}.md`)

		try {
			unlinkSync(filePath)
		} catch (err: unknown) {
			if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
				return
			}
			throw err
		}
	}
}
