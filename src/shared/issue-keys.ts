/*
 * Jira issue keys, read by the same rules as the backend's lib/jira: a project key of at least two characters (an
 * uppercase letter, then uppercase letters, digits or underscores, at most 255 in all), a dash and an issue number of
 * 1 to 16 digits without a leading zero, such as ABC-123.
 */

const MAX_PROJECT_KEY_LENGTH = 255
const MAX_ISSUE_NUMBER_DIGITS = 16
/** The most Jira keys a PR cost upload carries for one PR, as the backend bounds them. */
export const MAX_PULL_REQUEST_ISSUE_KEYS = 20

const isUppercase = (character: string) => character >= "A" && character <= "Z"
const isDigit = (character: string) => character >= "0" && character <= "9"
/** An ASCII letter, digit or underscore. Any other character, a non-ASCII one too, ends a word. */
const isWordCharacter = (character: string) =>
	isUppercase(character) || isDigit(character) || (character >= "a" && character <= "z") || character === "_"

function isIssueProject(text: string): boolean {
	return (
		text.length >= 2 &&
		text.length <= MAX_PROJECT_KEY_LENGTH &&
		isUppercase(text[0]) &&
		Array.from(text).every((character) => isUppercase(character) || isDigit(character) || character === "_")
	)
}

function isIssueNumber(text: string): boolean {
	return text !== "" && text.length <= MAX_ISSUE_NUMBER_DIGITS && text[0] !== "0" && Array.from(text).every(isDigit)
}

/** Whether `text` is exactly one Jira issue key. */
export function isIssueKey(text: string): boolean {
	const dash = text.indexOf("-")
	return dash !== -1 && isIssueProject(text.slice(0, dash)) && isIssueNumber(text.slice(dash + 1))
}

/** The end of the run of word characters that starts at `index`. */
function wordEnd(text: string, index: number): number {
	let end = index
	while (end < text.length && isWordCharacter(text[end])) end++
	return end
}

/**
 * The distinct Jira keys a branch name names, in order. A key is a whole word: a letter, digit or underscore on
 * either side makes it part of a longer one.
 */
export function branchIssueKeys(branch: string): string[] {
	const keys: string[] = []
	for (let index = 0; index < branch.length; ) {
		if (!isWordCharacter(branch[index])) {
			index++
			continue
		}
		// A key starts a word: its project key is the whole word, and its number the whole word after the dash.
		const start = index
		index = wordEnd(branch, index)
		if (branch[index] !== "-" || !isIssueProject(branch.slice(start, index))) continue
		const end = wordEnd(branch, index + 1)
		if (!isIssueNumber(branch.slice(index + 1, end))) continue
		const key = branch.slice(start, end)
		if (!keys.includes(key)) keys.push(key)
		index = end
	}
	return keys
}

/** Saved branch keys as a saved link or upload row holds them: up to the bound, all valid, or else none. */
export function savedBranchIssueKeys(value: unknown): string[] {
	return Array.isArray(value) &&
		value.length <= MAX_PULL_REQUEST_ISSUE_KEYS &&
		value.every((key): key is string => typeof key === "string" && isIssueKey(key))
		? value
		: []
}
