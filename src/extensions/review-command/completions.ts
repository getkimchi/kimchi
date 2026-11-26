import type { AutocompleteItem } from "@earendil-works/pi-tui"
import { REVIEW_LENSES } from "../review-panel/lenses.js"
import { gitText } from "../review-targets/git.js"
import { allowsReviewTargetOption, reviewTargetGrammar, reviewTargetOptions } from "../review-targets/parser.js"

function replacement(prefix: string, current: string, label: string, description?: string): AutocompleteItem {
	const beforeCurrent = prefix.slice(0, prefix.length - current.length)
	return { label, value: `${beforeCurrent}${label}`, ...(description ? { description } : {}) }
}

async function branches(prefix: string, current: string, root: string): Promise<AutocompleteItem[]> {
	try {
		const output = await gitText(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
		const values = new Set<string>()
		for (const ref of output.split("\n")) {
			if (ref.startsWith("refs/heads/")) values.add(ref.slice("refs/heads/".length))
			else if (ref.startsWith("refs/remotes/")) {
				const name = ref.slice("refs/remotes/".length)
				if (!name.endsWith("/HEAD")) values.add(name.includes("/") ? name.slice(name.indexOf("/") + 1) : name)
			}
		}
		return [...values].sort().map((value) => replacement(prefix, current, value, "Review this branch"))
	} catch {
		return []
	}
}

function matching(items: AutocompleteItem[], current: string): AutocompleteItem[] {
	return items.filter((candidate) => candidate.label.startsWith(current))
}

function matchingBase(items: AutocompleteItem[], prefix: string, current: string): AutocompleteItem[] {
	const typedValue = current.slice(current.indexOf("=") + 1)
	const beforeCurrent = prefix.slice(0, prefix.length - current.length)
	const basePrefix = current.slice(0, current.indexOf("=") + 1)
	return items
		.filter((candidate) => candidate.label.startsWith(typedValue))
		.map((candidate) => ({
			...candidate,
			value: `${beforeCurrent}${basePrefix}${candidate.label}`,
		}))
}

export async function reviewArgumentCompletions(prefix: string, root: string): Promise<AutocompleteItem[] | null> {
	if (!root.trim()) throw new Error("Review completions require an explicit repository cwd.")
	const leading = prefix.trimStart()
	const tokens = leading ? leading.split(/\s+/) : [""]
	const current = tokens.at(-1) ?? ""
	const previous = tokens.at(-2) ?? ""
	const grammar = reviewTargetGrammar(tokens)
	const branchItems = await branches(prefix, current, root)
	if (current.startsWith("--base=")) {
		return allowsReviewTargetOption(grammar.kind, "--base") ? matchingBase(branchItems, prefix, current) : null
	}
	if (previous === "--base") {
		return allowsReviewTargetOption(grammar.kind, "--base") ? matching(branchItems, current) : null
	}
	if (previous === "--prefer") {
		return allowsReviewTargetOption(grammar.kind, "--prefer")
			? matching([replacement(prefix, current, "local"), replacement(prefix, current, "remote")], current)
			: null
	}
	if (previous === "--lens" && allowsReviewTargetOption(grammar.kind, "--lens")) {
		return matching(
			REVIEW_LENSES.map((lens) => replacement(prefix, current, lens.id)),
			current,
		)
	}
	if (tokens.length === 1) {
		return matching(
			[
				replacement(prefix, current, "working-tree", "Review uncommitted working-tree changes"),
				replacement(prefix, current, "branch", "Use the explicit branch <ref> form"),
				...branchItems,
				replacement(prefix, current, "--fetch", "Fetch the selected remote before reviewing"),
			],
			current,
		)
	}
	if (grammar.explicitBranchForm && tokens.length === 2 && !current.startsWith("-")) {
		return matching(branchItems, current)
	}
	if (!current.startsWith("-")) return null
	return matching(
		reviewTargetOptions(grammar.kind).map((option) => replacement(prefix, current, option)),
		current,
	)
}
