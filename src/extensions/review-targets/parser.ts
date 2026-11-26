import { assertReviewLensId, DEFAULT_REVIEW_CONCURRENCY, type ReviewLensId } from "../review-panel/lenses.js"
import { parseProviderReviewUrl } from "./provider-url.js"
import type { ParsedReviewRequest, ReviewBranchPreference, ReviewPanelParseResult } from "./types.js"
import { ReviewTargetError } from "./types.js"

export type ReviewOptionTarget = "working-tree" | "branch" | "pull-request"

const COMMON_REVIEW_OPTIONS = ["--fetch", "--lens", "--all", "--concurrency"] as const
const REVIEW_OPTIONS: Record<ReviewOptionTarget, readonly string[]> = {
	"working-tree": COMMON_REVIEW_OPTIONS,
	branch: [...COMMON_REVIEW_OPTIONS, "--base", "--prefer", "--include-working-tree"],
	"pull-request": [...COMMON_REVIEW_OPTIONS, "--base"],
}

export function reviewTargetOptions(target: ReviewOptionTarget): readonly string[] {
	return REVIEW_OPTIONS[target]
}

export function allowsReviewTargetOption(target: ReviewOptionTarget, option: string): boolean {
	return REVIEW_OPTIONS[target].includes(option)
}

function argumentError(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_arguments", message)
}

function rejectUnknownOption(argument: string): never {
	throw argumentError(`Unknown review target option "${argument}".`)
}

function optionValue(
	args: readonly string[],
	index: number,
	option: string,
	requirement = "a value",
): { value: string; nextIndex: number } {
	const argument = args[index]
	const equals = argument.indexOf("=")
	if (equals >= 0) {
		const value = argument.slice(equals + 1)
		if (!value) throw argumentError(`${option} requires ${requirement}.`)
		return { value, nextIndex: index }
	}
	const value = args[index + 1]
	if (!value || value.startsWith("-")) throw argumentError(`${option} requires ${requirement}.`)
	return { value, nextIndex: index + 1 }
}

function extractPanelOptions(args: readonly string[]): {
	targetArgs: string[]
	panel: ReviewPanelParseResult
} {
	const targetArgs: string[] = []
	const lenses: ReviewLensId[] = []
	let all = false
	let concurrency = DEFAULT_REVIEW_CONCURRENCY
	let sawConcurrency = false
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]
		const option = argument.split("=", 1)[0]
		if (option === "--lens") {
			const { value, nextIndex } = optionValue(args, index, "--lens")
			const lens = assertReviewLensId(value)
			if (!lenses.includes(lens)) lenses.push(lens)
			index = nextIndex
			continue
		}
		if (option === "--all") {
			if (argument !== "--all") throw argumentError("--all does not take a value.")
			if (all) throw argumentError("--all was provided more than once.")
			all = true
			continue
		}
		if (option === "--concurrency") {
			if (sawConcurrency) throw argumentError("--concurrency was provided more than once.")
			const { value, nextIndex } = optionValue(args, index, "--concurrency")
			if (!/^[0-9]+$/.test(value)) throw argumentError("--concurrency must be a positive integer.")
			const parsed = Number(value)
			if (!Number.isSafeInteger(parsed) || parsed < 1) {
				throw argumentError("--concurrency must be a positive integer.")
			}
			concurrency = parsed
			sawConcurrency = true
			index = nextIndex
			continue
		}
		targetArgs.push(argument)
	}
	if (all && lenses.length > 0) throw argumentError("--lens cannot be combined with --all.")
	return { targetArgs, panel: { lenses, all, concurrency } }
}

export interface ReviewTargetGrammar {
	kind: ReviewOptionTarget
	targetArgs: string[]
	bareBranchName?: string
	explicitBranchForm: boolean
}

/** Classify the target after removing the same panel options the parser removes. */
export function reviewTargetGrammar(args: readonly string[]): ReviewTargetGrammar {
	const { targetArgs } = extractPanelOptions(args)
	const first = targetArgs[0]
	const branch = first === "branch" ? targetArgs[1] : first
	return {
		kind: first === "working-tree" ? "working-tree" : /^https?:\/\//i.test(branch ?? "") ? "pull-request" : "branch",
		targetArgs,
		bareBranchName: first === "branch" ? undefined : branch,
		explicitBranchForm: first === "branch",
	}
}

function bareRequest(fetch: boolean): ParsedReviewRequest {
	return { kind: "bare", fetch, panel: { lenses: [], all: false, concurrency: DEFAULT_REVIEW_CONCURRENCY } }
}

function parseTargetOnlyArgs(args: readonly string[]): ParsedReviewRequest {
	if (args.length === 0) return bareRequest(false)
	const target = args[0]
	if (target === "--fetch") {
		if (args.length === 1) return bareRequest(true)
		throw argumentError("--fetch requires an explicit working-tree, branch, or PR/MR target.")
	}
	if (target.startsWith("--")) {
		if (["--base", "--include-working-tree", "--prefer"].includes(target)) {
			throw argumentError(`${target} requires an explicit working-tree or branch target.`)
		}
		rejectUnknownOption(target)
	}

	if (target === "working-tree") {
		let fetch = false
		for (const argument of args.slice(1)) {
			const option = argument.split("=", 1)[0]
			if (argument.startsWith("--") && !allowsReviewTargetOption("working-tree", option)) {
				if (["--base", "--include-working-tree", "--prefer"].includes(option)) {
					throw argumentError(`${option} can only be used with a branch target.`)
				}
				rejectUnknownOption(argument)
			}
			if (argument === "--fetch") {
				if (fetch) throw argumentError("--fetch was provided more than once.")
				fetch = true
				continue
			}
			if (argument === "--base" || argument === "--include-working-tree" || argument === "--prefer") {
				throw argumentError(`${argument} can only be used with a branch target.`)
			}
			if (argument.startsWith("--")) rejectUnknownOption(argument)
			throw argumentError(`Unexpected argument "${argument}" after working-tree.`)
		}
		return { kind: "working-tree", fetch }
	}

	const explicitBranch = target === "branch"
	const branch = explicitBranch ? args[1] : target
	if (!branch || branch.startsWith("-")) {
		throw argumentError("branch requires a ref before its options, for example branch feature --base main.")
	}
	const provider = explicitBranch || !/^https?:\/\//i.test(branch) ? undefined : parseProviderReviewUrl(branch)
	if (!explicitBranch && /^https?:\/\//i.test(branch) && !provider) {
		throw argumentError(
			"Invalid PR/MR URL. Use https://github.com/<owner>/<repo>/pull/<n> or a GitLab <project>/-/merge_requests/<n> URL.",
		)
	}
	let base: string | undefined
	let includeWorkingTree = false
	let fetch = false
	let prefer: ReviewBranchPreference | undefined
	for (let index = explicitBranch ? 2 : 1; index < args.length; index += 1) {
		const argument = args[index]
		const option = argument.split("=", 1)[0]
		if (argument.startsWith("--") && !allowsReviewTargetOption(provider ? "pull-request" : "branch", option)) {
			if (["--base", "--include-working-tree", "--prefer"].includes(option)) {
				throw argumentError(`${option} can only be used with a branch target.`)
			}
			rejectUnknownOption(argument)
		}
		if (option === "--base") {
			if (base !== undefined) throw argumentError("--base was provided more than once.")
			const { value, nextIndex } = optionValue(args, index, "--base", "a ref value")
			base = value
			index = nextIndex
			continue
		}
		if (option === "--prefer") {
			if (provider) throw argumentError("--prefer can only be used with a branch target.")
			if (prefer !== undefined) throw argumentError("--prefer was provided more than once.")
			const { value, nextIndex } = optionValue(args, index, "--prefer")
			if (value !== "local" && value !== "remote") throw argumentError("--prefer must be local or remote.")
			prefer = value
			index = nextIndex
			continue
		}
		if (argument === "--include-working-tree") {
			if (provider) throw argumentError("--include-working-tree can only be used with a branch target.")
			if (includeWorkingTree) throw argumentError("--include-working-tree was provided more than once.")
			includeWorkingTree = true
			continue
		}
		if (argument === "--fetch") {
			if (fetch) throw argumentError("--fetch does not take a value and may be provided only once.")
			fetch = true
			continue
		}
		if (argument.startsWith("--")) rejectUnknownOption(argument)
		throw argumentError(`Unexpected positional argument "${argument}" for ${provider ? "PR/MR" : "branch"} ${branch}.`)
	}
	if (provider) return { kind: "pull-request", ...provider, base, fetch }
	return { kind: "branch", branch, base, includeWorkingTree, fetch, ...(prefer ? { prefer } : {}) }
}

/** Parse the tokens following /review. Shell tokenization and UI dispatch belong to the surface adapter. */
export function parseReviewTargetArgs(args: readonly string[]): ParsedReviewRequest {
	const { targetArgs, panel } = extractPanelOptions(args)
	return { ...parseTargetOnlyArgs(targetArgs), panel }
}
