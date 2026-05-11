/**
 * Helpers for the plan-mode question dropdown.
 *
 * Ferment-owned decisions should use structured host UI in the relevant tool
 * handler. These helpers are only a fallback for generic assistant questions.
 */

const BINARY_CONFIRMATION_QUESTIONS = new Set(["does this plan look right?"])

export function extractTrailingQuestion(text: string): string {
	const trimmed = text.trim()
	if (!trimmed) return "Continue?"

	// Look for the last `?` and walk back to the nearest sentence start
	// (start-of-text, blank line, or sentence-ending punctuation followed by space).
	const lastQ = trimmed.lastIndexOf("?")
	if (lastQ === -1) return trimmed.slice(-200)

	// Search backwards from lastQ for a sentence boundary.
	const tail = trimmed.slice(0, lastQ + 1)
	const boundary = tail.search(/(?:^|[\n.!?]\s+|"\s+)([^.!?\n"]*\?)$/)
	if (boundary >= 0) {
		// Pull out the captured group (the question itself, without the boundary char).
		const m = tail.match(/(?:^|[\n.!?]\s+|"\s+)([^.!?\n"]*\?)$/)
		if (m?.[1]) return m[1].trim()
	}

	// Fallback: take the last line that contains the question mark.
	const lines = tail.split("\n")
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes("?")) return lines[i].trim()
	}
	return trimmed.slice(-200)
}

export function isBinaryConfirmationQuestion(question: string): boolean {
	return BINARY_CONFIRMATION_QUESTIONS.has(question.trim().toLowerCase())
}

/**
 * Attempt to extract contextual options from assistant message text.
 * Returns undefined if no patterns match (fallback to boolean yes/no).
 *
 * This intentionally looks only at the final question block. Earlier content
 * may contain numbered plans, checklists, or examples that are not UI options.
 */
export function extractContextualOptions(text: string): string[] | undefined {
	const finalBlock = extractFinalQuestionBlock(text)
	if (!finalBlock) return undefined
	if (isBinaryConfirmationQuestion(extractTrailingQuestion(finalBlock))) return undefined

	const lines = extractOptionLinesAdjacentToQuestion(finalBlock)

	if (lines.length >= 2) {
		const numbered = lines.filter((l) => /^\d+[.)]\s/.test(l))
		if (numbered.length >= 2) {
			return numbered.map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
		}

		const lettered = lines.filter((l) => /^\(?[a-z][.)]\)?\s/.test(l))
		if (lettered.length >= 2) {
			return lettered.map((l) => l.replace(/^\(?[a-z][.)]\)?\s*/, "").trim())
		}

		const bulleted = lines.filter((l) => /^[-*•]\s/.test(l))
		if (bulleted.length >= 2) {
			return bulleted.map((l) => l.replace(/^[-*•]\s*/, "").trim())
		}
	}

	return undefined
}

function extractOptionLinesAdjacentToQuestion(finalBlock: string): string[] {
	const lines = finalBlock
		.trim()
		.split("\n")
		.map((l) => l.trim())

	const questionLineIdx = lines.findLastIndex((l) => l.includes("?"))
	if (questionLineIdx === -1) return []

	const optionLines: string[] = []
	for (let i = questionLineIdx + 1; i < lines.length; i++) {
		const line = lines[i]
		if (!line || !isOptionLine(line)) break
		optionLines.push(line)
	}

	return optionLines
}

function isOptionLine(line: string): boolean {
	return /^\d+[.)]\s/.test(line) || /^\(?[a-z][.)]\)?\s/.test(line) || /^[-*•]\s/.test(line)
}

function extractFinalQuestionBlock(text: string): string | undefined {
	const trimmed = text.trim()
	if (!trimmed) return undefined

	const lastQ = trimmed.lastIndexOf("?")
	if (lastQ === -1) return undefined

	const blockStart = trimmed.lastIndexOf("\n\n", lastQ)
	if (blockStart === -1) return trimmed
	return trimmed.slice(blockStart + 2)
}
