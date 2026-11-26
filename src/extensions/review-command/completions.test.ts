import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AutocompleteItem, CombinedAutocompleteProvider } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it } from "vitest"
import { parseReviewTargetArgs } from "../review-targets/parser.js"
import { reviewArgumentCompletions } from "./completions.js"

const temporaryDirectories: string[] = []
afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "review-completions-"))
	temporaryDirectories.push(root)
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" })
	git("init", "--initial-branch=main")
	git("config", "user.name", "Review Fixture")
	git("config", "user.email", "[EMAIL_ADDRESS_5]")
	writeFileSync(join(root, "value.txt"), "base\n")
	git("add", "value.txt")
	git("commit", "-m", "base")
	git("branch", "feature")
	git("branch", "master")
	git("update-ref", "refs/remotes/origin/remote-only", "HEAD")
	return root
}

async function suggestions(root: string, line: string) {
	const provider = new CombinedAutocompleteProvider(
		[{ name: "review", getArgumentCompletions: (prefix) => reviewArgumentCompletions(prefix, root) }],
		root,
	)
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal, force: false })
}

function apply(provider: CombinedAutocompleteProvider, line: string, item: AutocompleteItem, prefix: string): string {
	return provider.applyCompletion([line], 0, line.length, item, prefix).lines[0]
}

function labeled(items: AutocompleteItem[], label: string): AutocompleteItem {
	const item = items.find((candidate) => candidate.label === label)
	if (!item) throw new Error(`Missing completion ${label} in ${JSON.stringify(items)}`)
	return item
}

describe("review completion application through Pi", () => {
	it("completes an option name and root argument", async () => {
		const root = repository()
		const result = await suggestions(root, "/review feature --")
		if (!result) throw new Error("Expected --base suggestion")
		expect(
			apply(
				new CombinedAutocompleteProvider([], root),
				"/review feature --",
				labeled(result.items, "--base"),
				result.prefix,
			),
		).toBe("/review feature --base")
	})

	it("completes an equals-form base without erasing the target", async () => {
		const root = repository()
		const result = await suggestions(root, "/review feature --base=ma")
		if (!result) throw new Error("Expected a base suggestion")
		expect(
			apply(
				new CombinedAutocompleteProvider([], root),
				"/review feature --base=ma",
				labeled(result.items, "master"),
				result.prefix,
			),
		).toBe("/review feature --base=master")
	})

	it("offers local and remote preferences only for branch targets", async () => {
		const root = repository()
		for (const value of ["local", "remote"]) {
			const result = await suggestions(root, "/review feature --prefer ")
			if (!result) throw new Error("Expected preference suggestions")
			expect(
				apply(
					new CombinedAutocompleteProvider([], root),
					"/review feature --prefer ",
					labeled(result.items, value),
					result.prefix,
				),
			).toBe(`/review feature --prefer ${value}`)
		}
	})

	it("does not offer preferences on working-tree or PR targets", async () => {
		const root = repository()
		expect(await suggestions(root, "/review --lens spec working-tree --prefer ")).toBeNull()
		expect(await suggestions(root, "/review working-tree --base=ma")).toBeNull()
		expect(await suggestions(root, "/review https://github.com/owner/repository/pull/42 --prefer ")).toBeNull()
	})

	it("retains the full target when completing later flags", async () => {
		const root = repository()
		const result = await suggestions(root, "/review working-tree --f")
		if (!result) throw new Error("Expected --fetch suggestion")
		expect(
			apply(
				new CombinedAutocompleteProvider([], root),
				"/review working-tree --f",
				labeled(result.items, "--fetch"),
				result.prefix,
			),
		).toBe("/review working-tree --fetch")
	})

	it.each(["--concurrency=2", "--lens=spec"])("completes --base with the earlier %s option intact", async (option) => {
		const root = repository()
		const line = `/review ${option} feature --base=ma`
		const result = await suggestions(root, line)
		if (!result) throw new Error("Expected a base suggestion")
		expect(
			apply(new CombinedAutocompleteProvider([], root), line, labeled(result.items, "master"), result.prefix),
		).toBe(`/review ${option} feature --base=master`)
	})
})

describe("review target grammar completions", () => {
	it("rejects a working-tree preference under the shared parser", () => {
		expect(() => parseReviewTargetArgs(["working-tree", "--prefer", "local"])).toThrow(
			/can only be used with a branch target/,
		)
		expect(() => parseReviewTargetArgs(["feature", "--prefer", "local"])).not.toThrow()
	})
})
