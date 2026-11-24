import type { ParsedReviewRequest } from "./types.js"
import { ReviewTargetError } from "./types.js"

const RESERVED_STAGE_4_OPTIONS = new Set(["--lens", "--all", "--concurrency"])

function argumentError(message: string): ReviewTargetError {
	return new ReviewTargetError("invalid_arguments", message)
}

function reservedOption(argument: string): string | undefined {
	const option = argument.split("=", 1)[0]
	return RESERVED_STAGE_4_OPTIONS.has(option) ? option : undefined
}

function rejectUnknownOption(argument: string): never {
	const reserved = reservedOption(argument)
	if (reserved) {
		throw argumentError(`${reserved} is reserved for panel selection and is not supported by target resolution yet.`)
	}
	throw argumentError(`Unknown review target option "${argument}".`)
}

function bareRequest(fetch: boolean): ParsedReviewRequest {
	return { kind: "bare", fetch }
}

/** Parse the tokens following /review. Shell tokenization and UI dispatch belong to the surface adapter. */
export function parseReviewTargetArgs(args: readonly string[]): ParsedReviewRequest {
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
