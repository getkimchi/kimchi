import { assertReviewLensId, DEFAULT_REVIEW_CONCURRENCY, type ReviewLensId } from "../review-panel/lenses.js"
import type { ParsedReviewRequest, ReviewPanelParseResult } from "./types.js"
import { ReviewTargetError } from "./types.js"

function argumentError(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_arguments", message)
}

function rejectUnknownOption(argument: string): never {
	throw argumentError(`Unknown review target option "${argument}".`)
}

function optionValue(args: readonly string[], index: number, option: string): { value: string; nextIndex: number } {
	const argument = args[index]
	const equals = argument.indexOf("=")
	if (equals >= 0) {
		const value = argument.slice(equals + 1)
		if (!value) throw argumentError(`${option} requires a value.`)
		return { value, nextIndex: index }
	}
	const value = args[index + 1]
	if (!value || value.startsWith("-")) throw argumentError(`${option} requires a value.`)
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

function bareRequest(fetch: boolean): ParsedReviewRequest {
	return { kind: "bare", fetch, panel: { lenses: [], all: false, concurrency: DEFAULT_REVIEW_CONCURRENCY } }
}

function parseTargetOnlyArgs(args: readonly string[]): ParsedReviewRequest {
	if (args.length === 0) return bareRequest(false)
	const target = args[0]
	if (target !== "working-tree" && target !== "branch") {
		if (args.length === 1 && target === "--fetch") return bareRequest(true)
		if (target.startsWith("--")) {
			if (target === "--base" || target === "--include-working-tree") {
				throw argumentError(`${target} requires an explicit working-tree or branch target.`)
			}
			if (target === "--fetch") throw argumentError("--fetch does not take a value.")
			rejectUnknownOption(target)
		}
		throw argumentError(`Unknown review target "${target}". Use working-tree or branch <ref>.`)
	}

	if (target === "working-tree") {
		let fetch = false
		for (const argument of args.slice(1)) {
			if (argument === "--fetch") {
				if (fetch) throw argumentError("--fetch was provided more than once.")
				fetch = true
				continue
			}
			if (argument === "--base" || argument === "--include-working-tree") {
				throw argumentError(`${argument} can only be used with a branch target.`)
			}
			if (argument.startsWith("--")) rejectUnknownOption(argument)
			throw argumentError(`Unexpected argument "${argument}" after working-tree.`)
		}
		return { kind: "working-tree", fetch }
	}

	const branch = args[1]
	if (!branch || branch.startsWith("-")) {
		throw argumentError("branch requires a ref before its options, for example branch feature --base main.")
	}
	let base: string | undefined
	let includeWorkingTree = false
	let fetch = false
	for (let index = 2; index < args.length; index += 1) {
		const argument = args[index]
		if (argument === "--base") {
			if (base !== undefined) throw argumentError("--base was provided more than once.")
			const value = args[index + 1]
			if (!value || value.startsWith("-")) throw argumentError("--base requires a ref value.")
			base = value
			index += 1
			continue
		}
		if (argument === "--include-working-tree") {
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
		throw argumentError(`Unexpected positional argument "${argument}" for branch ${branch}.`)
	}
	return { kind: "branch", branch, base, includeWorkingTree, fetch }
}

/** Parse the tokens following /review. Shell tokenization and UI dispatch belong to the surface adapter. */
export function parseReviewTargetArgs(args: readonly string[]): ParsedReviewRequest {
	const { targetArgs, panel } = extractPanelOptions(args)
	return { ...parseTargetOnlyArgs(targetArgs), panel }
}
