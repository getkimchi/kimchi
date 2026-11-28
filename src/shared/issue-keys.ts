/*
 * An issue key is a project key of at least two characters (an uppercase letter, then uppercase letters, digits or
 * underscores, at most 255 in all), a dash and an issue number of 1 to 16 digits without a leading zero, such as
 * ABC-123. Branch-name matching also accepts fully lowercase ASCII project prefixes and emits the uppercase key.
 */

const MAX_PROJECT_KEY_LENGTH = 255
const MAX_ISSUE_NUMBER_DIGITS = 16
/** The most issue keys a PR cost upload carries for one PR. */
export const MAX_PULL_REQUEST_ISSUE_KEYS = 20

const isUppercase = (character: string) => character >= "A" && character <= "Z"
const isLowercase = (character: string) => character >= "a" && character <= "z"
const isDigit = (character: string) => character >= "0" && character <= "9"
/** An ASCII letter, digit or underscore. Any other character, a non-ASCII one too, ends a word. */
const isWordCharacter = (character: string) =>
	isUppercase(character) || isLowercase(character) || isDigit(character) || character === "_"

function isProject(text: string, isLetter: (character: string) => boolean): boolean {
	return (
		text.length >= 2 &&
		text.length <= MAX_PROJECT_KEY_LENGTH &&
		isLetter(text[0]) &&
		Array.from(text).every((character) => isLetter(character) || isDigit(character) || character === "_")
	)
}

const isIssueProject = (text: string) => isProject(text, isUppercase)
const isLowercaseIssueProject = (text: string) => isProject(text, isLowercase)

function isIssueNumber(text: string): boolean {
	return text !== "" && text.length <= MAX_ISSUE_NUMBER_DIGITS && text[0] !== "0" && Array.from(text).every(isDigit)
}

/** Whether `text` is exactly one canonical, uppercase issue key. */
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

/** A branch prefix is canonical uppercase, or fully lowercase ASCII to normalize to uppercase. */
function branchProjectKey(word: string): string | undefined {
	if (isIssueProject(word)) return word
	if (isLowercaseIssueProject(word)) return word.toUpperCase()
	return undefined
}

/**
 * The distinct issue keys a branch name names, in uppercase and in order. Projects may be uppercase or fully lowercase.
 * A key is a whole word: a letter, digit or underscore on either side makes it part of a longer one.
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
		if (branch[index] !== "-") continue
		const project = branchProjectKey(branch.slice(start, index))
		if (project === undefined) continue
		const end = wordEnd(branch, index + 1)
		const number = branch.slice(index + 1, end)
		if (!isIssueNumber(number)) continue
		const key = `${project}-${number}`
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
