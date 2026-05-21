import type {
	DerivedThinkingStep,
	ThinkingSemanticRole,
	ThinkingSourceBlock,
	ThinkingStepsMode,
	ThinkingSummaryEvent,
} from "./types.js"

const LIST_ITEM_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|[a-z][.)]\s+)/i
const HEADING_RE = /^\s{0,3}#{1,6}\s+/
const LEADING_SUMMARY_PHRASE_RE =
	/^(?:i\s+(?:need|should|want)\s+to|need\s+to|i(?:'m| am)\s+going\s+to|i(?:'ll| will)|let\s+me|let'?s|first,?\s+|next,?\s+|then,?\s+|now,?\s+|okay,?\s+)/i

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n")
}

function collapseWhitespace(text: string): string {
	return text.replace(/[ \t]+/g, " ").trim()
}

function stripLeadingMarker(text: string): string {
	return text.replace(HEADING_RE, "").replace(LIST_ITEM_RE, "").trim()
}

function stripLeadingSummaryPhrase(text: string): string {
	const stripped = text.replace(LEADING_SUMMARY_PHRASE_RE, "").trim()
	return stripped.length > 0 ? stripped : text.trim()
}

function capitalize(text: string): string {
	if (!text) return text
	return text.charAt(0).toUpperCase() + text.slice(1)
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text
	const truncated = text.slice(0, Math.max(0, maxLength - 1)).trimEnd()
	return `${truncated}…`
}

function ensureCompleteVisibleSummary(summary: string): string {
	const trimmed = summary.trim()
	if (!trimmed) return trimmed
	if (!/(?:…|\.\.\.)$/u.test(trimmed)) {
		return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed.replace(/[.!?;:,]+$/g, "")}.`
	}

	const withoutEllipsis = trimmed.replace(/(?:…|\.\.\.)+$/gu, "").trimEnd()
	const boundaryMatches = [
		...Array.from(withoutEllipsis.matchAll(/[,:;](?=\s|$)/g), (match) => match.index ?? -1),
		...Array.from(
			withoutEllipsis.matchAll(/\b(?:before|after|while|because|so|then|once|until)\b/gi),
			(match) => match.index ?? -1,
		),
	].filter((index) => index > 0)
	const boundaryIndex = boundaryMatches.length > 0 ? Math.max(...boundaryMatches) : -1
	const candidate =
		boundaryIndex > 0
			? withoutEllipsis.slice(0, boundaryIndex).trimEnd()
			: withoutEllipsis.replace(/\s+\S*$/u, "").trimEnd()
	const cleaned = (candidate || withoutEllipsis).replace(/[.!?;:,]+$/g, "").trimEnd()
	return cleaned ? `${cleaned}.` : `${withoutEllipsis.replace(/[.!?;:,]+$/g, "").trimEnd()}.`
}

function firstMeaningfulLine(text: string): string {
	const lines = normalizeNewlines(text)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	return lines[0] ?? ""
}

function firstSentence(text: string): string {
	const normalized = collapseWhitespace(text)
	if (!normalized) return ""
	const match = normalized.match(/^(.{1,120}?)(?:[.!?](?:\s|$)|$)/)
	return match?.[1]?.trim() ?? normalized
}

function splitListChunk(chunk: string): string[] {
	const lines = normalizeNewlines(chunk).split("\n")
	let contentStartIndex = 0
	while (contentStartIndex < lines.length) {
		const trimmed = lines[contentStartIndex]!.trim()
		if (!trimmed || isStandaloneHeadingChunk(trimmed)) {
			contentStartIndex += 1
			continue
		}
		break
	}

	const headingPrefix = lines.slice(0, contentStartIndex).join("\n").trim()
	const contentLines = lines.slice(contentStartIndex)
	const itemLineIndexes = contentLines.reduce<number[]>((indexes, line, index) => {
		if (LIST_ITEM_RE.test(line)) indexes.push(index)
		return indexes
	}, [])

	if (itemLineIndexes.length < 2) return [chunk.trim()]

	const items: string[] = []
	let current: string[] = []
	for (const line of contentLines) {
		if (LIST_ITEM_RE.test(line) && current.length > 0) {
			const item = current.join("\n").trim()
			items.push(headingPrefix ? `${headingPrefix}\n\n${item}` : item)
			current = [line]
		} else {
			current.push(line)
		}
	}
	if (current.length > 0) {
		const item = current.join("\n").trim()
		items.push(headingPrefix ? `${headingPrefix}\n\n${item}` : item)
	}
	return items.filter(Boolean)
}

function stripMarkdownEmphasis(text: string): string {
	return text
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(^|[^\w/.-])\*(?=\S)([\s\S]*?\S)\*(?=[^\w/.-]|$)/g, "$1$2")
		.replace(/(^|[^\w/.-])_(?=\S)([\s\S]*?\S)_(?=[^\w/.-]|$)/g, "$1$2")
}

function isStandaloneHeadingChunk(chunk: string): boolean {
	const lines = normalizeNewlines(chunk)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.length !== 1) return false

	const line = lines[0]!
	if (LIST_ITEM_RE.test(line)) return false
	if (HEADING_RE.test(line)) return true
	if (!/^(\*\*|__)(.+?)\1$/.test(line)) return false

	const stripped = stripMarkdownEmphasis(stripLeadingMarker(line))
	return stripped.length > 0 && stripped.length <= 80 && !/[.!?]/.test(stripped)
}

function mergeHeadingParagraphChunks(chunks: string[]): string[] {
	const merged: string[] = []
	for (let index = 0; index < chunks.length; index += 1) {
		const chunk = chunks[index]!
		const nextChunk = chunks[index + 1]
		if (isStandaloneHeadingChunk(chunk)) {
			const introChunks: string[] = []
			let nextIndex = index + 1
			while (
				nextIndex < chunks.length &&
				!isStandaloneHeadingChunk(chunks[nextIndex]!) &&
				!isListParagraphChunk(chunks[nextIndex]!)
			) {
				introChunks.push(chunks[nextIndex]!)
				nextIndex += 1
			}

			const followingListChunks: string[] = []
			while (nextIndex < chunks.length && isListParagraphChunk(chunks[nextIndex]!)) {
				followingListChunks.push(chunks[nextIndex]!)
				nextIndex += 1
			}

			if (introChunks.length > 0 && followingListChunks.length > 0) {
				merged.push(`${chunk}\n\n${introChunks.join("\n\n")}`)
				for (const listChunk of followingListChunks) {
					merged.push(`${chunk}\n\n${listChunk}`)
				}
				index = nextIndex - 1
				continue
			}

			if (followingListChunks.length > 0) {
				merged.push(`${chunk}\n\n${followingListChunks.join("\n\n")}`)
				index = nextIndex - 1
				continue
			}
			if (nextChunk && !isStandaloneHeadingChunk(nextChunk)) {
				merged.push(`${chunk}\n\n${nextChunk}`)
				index += 1
				continue
			}
		}
		merged.push(chunk)
	}
	return merged
}

function isListParagraphChunk(chunk: string): boolean {
	const lines = normalizeNewlines(chunk)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)

	for (const line of lines) {
		if (LIST_ITEM_RE.test(line)) return true
		if (!isStandaloneHeadingChunk(line)) return false
	}
	return false
}

function isListContinuationChunk(chunk: string): boolean {
	const normalized = normalizeNewlines(chunk).trim()
	if (!normalized || isListParagraphChunk(normalized) || isStandaloneHeadingChunk(normalized)) {
		return false
	}

	const firstLine = normalized
		.split("\n")
		.map((line) => stripMarkdownEmphasis(line.trim()))
		.find(Boolean)
	if (!firstLine) return false
	if (FAILURE_CUE_RE.test(firstLine)) return false
	if (STANDALONE_LIST_ACTION_RE.test(firstLine)) return false

	const hasFocusedActionCue =
		DIRECT_ACTION_START_RE.test(firstLine) &&
		(collectPathTokens(firstLine).length > 0 ||
			(firstLine.match(SYMBOL_TOKEN_RE) ?? []).length > 0 ||
			/\b(?:before editing|after editing|npm|node|git|pi|larra|mcp|tsx|tsc)\b/i.test(firstLine))
	if (hasFocusedActionCue) return false

	return !/^(?:overall|in summary|to summarize|in conclusion|finally|that should|this should|those steps should|this confirms|that confirms|with that)\b/i.test(
		firstLine,
	)
}

export function splitThinkingIntoStepTexts(text: string): string[] {
	const normalized = normalizeNewlines(text).trim()
	if (!normalized) return []

	const paragraphChunks = normalized
		.split(/\n{2,}/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)

	if (paragraphChunks.length === 0) return []

	const mergedChunks = mergeHeadingParagraphChunks(paragraphChunks)
	const steps: string[] = []
	for (let index = 0; index < mergedChunks.length; index += 1) {
		const chunk = mergedChunks[index]!
		const previousStep = steps[steps.length - 1]
		if (previousStep && isListParagraphChunk(previousStep) && !isListParagraphChunk(chunk)) {
			const continuationChunks = [chunk]
			let continuationIndex = index + 1
			while (continuationIndex < mergedChunks.length && !isListParagraphChunk(mergedChunks[continuationIndex]!)) {
				continuationChunks.push(mergedChunks[continuationIndex]!)
				continuationIndex += 1
			}

			if (
				continuationChunks.every(isListContinuationChunk) &&
				(continuationIndex === mergedChunks.length || isListParagraphChunk(mergedChunks[continuationIndex]!))
			) {
				steps[steps.length - 1] = `${previousStep}\n\n${continuationChunks.join("\n\n")}`
				index = continuationIndex - 1
				continue
			}
		}

		steps.push(...splitListChunk(chunk))
	}
	return steps.length > 0 ? steps : [normalized]
}

const SUMMARY_MAX_CHARS = 84
const MMR_LAMBDA = 0.7
const PURE_TIMESTAMP_RE = /^(?:\[)?\d{1,2}:\d{2}(?::\d{2})?(?:\])?$|^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}/i
const SEPARATOR_RE = /^[\s`~!@#$%^&*()_+=\-\[\]{}\|;:'",.<>/?·]+$/
const SPINNER_STATUS_RE =
	/^(?:thinking|loading|working|running|processing|waiting|done|complete|completed|idle)(?:[ .…:-]+)?$/i
const PATH_TOKEN_RE = /\b(?:[a-z0-9_-]+[/.])+[a-z0-9_-]+\b/gi
const SYMBOL_TOKEN_RE = /\b[a-z_][a-z0-9_]*\([^)]*\)/gi
const ARTIFACT_RE =
	/(?:\b[a-z0-9_-]+\.(?:ts|tsx|js|jsx|json|md|txt|yml|yaml|lock)\b|\b[a-z_][a-z0-9_]*\([^)]*\)|`[^`]+`|\b(?:npm|node|git|pi|larra|mcp|tsx|tsc)\b|\b(?:ts\d{3,5}|err_[a-z0-9_]+)\b)/i
const FAILURE_CUE_RE =
	/\b(failed|failure|error|errors|blocked|abort(?:ed)?|cannot|unable|did not complete|not completed|reverted|rollback|locked)\b/i
const SUCCESS_CUE_RE = /\b(pass(?:ed)?|succeed(?:ed)?)\b/i
const DECISION_CUE_RE =
	/\b(decided|decision|chose|switched|replaced|confirmed|fixed|resolved|discovered|found|preserve|keeping|keep)\b/i
const PLAN_CHANGE_CUE_RE =
	/\b(instead of|rather than|safer (?:plan|path|route|approach|option)|(?:less|lower)-?risk(?:y)? (?:plan|path|route|approach|option)|plan changed|keep the current summarizer as the baseline|only choose the challenger|limit the algorithmic changes)\b/i
const ACTION_CUE_RE =
	/\b(retry|rerun|inspect|check|verify|compare|search|find|read|patch|update|implement|remove|rename|write|run|fix|switch|revert|gather|retrieve|list|flag|review|plan|map|archive|explore|wait|look\s+into)\b/i
const NEXT_ACTION_CUE_RE = /\b(first|next|retry|rerun|before|after)\b/i
const UNCERTAINTY_CUE_RE =
	/\b(maybe|might|possibly|probably|seems|looks like|suspect|likely|whether|unverified|haven'?t verified|not verified|before I call this)\b/i
const SPECULATIVE_CUE_RE = /\b(seems like|could be useful|might be useful|would be useful|considering)\b/i
const META_CHATTER_RE =
	/\b(?:i(?:'m| am)?\s+(?:thinking|contemplating|curious|hoping|wondering)|take a closer look|what makes the most sense|could really help|idealized scenarios|real interactions|worth checking)\b/i
const WEAK_FRAGMENT_START_RE =
	/^(?:and|but|or|so|then|though|while|which|because|however|therefore|perhaps|maybe|possibly|also|still|just|since)\b/i
const GENERIC_OBJECT_ACTION_RE = /^(?:flag|review|check|inspect|look\s+into)\s+(?:that|this|it)\b/i
const DIRECT_ACTION_START_RE =
	/^(?:use|inspect|check|verify|compare|search|find|read|patch|update|implement|remove|rename|write|run|fix|switch|revert|gather|retrieve|list|flag|review|plan|map|archive|explore|wait|look\s+into)\b/i
const WEAK_ORIENTATION_RE = /\bconnect and orient ourselves\b/i
const TOOL_AVAILABILITY_CHATTER_RE =
	/\b(?:while (?:there(?:'s| is)) a tool for it|might not retrieve\b|can't retrieve\b|cannot retrieve\b)\b/i
const OUTCOME_UNCERTAINTY_CONTEXT_RE =
	/\b(?:whether|if|not sure|unsure|uncertain|unverified|not verified|haven'?t verified|maybe|might|may be|possibly|probably|seems|looks like|suspect|before I call this)\b/i
const EXPLICIT_SUCCESS_RESULT_RE =
	/\b(?:(?:npm(?: run)? [a-z0-9:-]+|tests?|build|typecheck|lint|validation|suite|command)\s+(?:has\s+)?(?:passed|succeeded)|(?:passed|succeeded)\s+(?:after|once)\b(?=.*\b(?:npm|test|build|typecheck|lint|validation|suite|command)\b))/i
const EXPLICIT_FAILURE_RESULT_RE =
	/\b(?:failed|blocked|abort(?:ed)?|cannot|unable|did not complete|not completed|reverted|rollback|locked)\b/i
const EXPLICIT_ERROR_RESULT_RE =
	/\b(?:error|errors)\b(?:(?:\s*(?::|=|-))|(?:\s+(?:with|from|because|during|while|after|in|code|message)\b)|(?=.*\b(?:threw|throwing|throws|raised|encountered|reported|returned|hit|shows?|caught)\b))/i
const FAILURE_REFERENCE_CONTEXT_RE =
	/\b(?:failure|failures|error|errors)\s+(?:handling|rendering|renderer|case|cases|path|paths|state|states|logic|message|messages|copy|text|wording|semantics|classification|detection|cue|cues|recovery|fallback|branch|branches|surface|mode|modes)\b/i
const STANDALONE_LIST_ACTION_RE =
	/^(?:(?:i\s+)?(?:need|should|will|want|plan)\s+to|(?:next|then|now)\b|(?:need|should|must)\s+)/i

function hasExplicitFailureCue(sentence: string): boolean {
	const normalized = collapseWhitespace(sentence)
	if (!FAILURE_CUE_RE.test(normalized) || OUTCOME_UNCERTAINTY_CONTEXT_RE.test(normalized)) return false
	if (EXPLICIT_FAILURE_RESULT_RE.test(normalized)) return true
	if (EXPLICIT_ERROR_RESULT_RE.test(normalized) && !FAILURE_REFERENCE_CONTEXT_RE.test(normalized)) return true
	return false
}

function hasExplicitSuccessCue(sentence: string): boolean {
	return EXPLICIT_SUCCESS_RESULT_RE.test(sentence) && !OUTCOME_UNCERTAINTY_CONTEXT_RE.test(sentence)
}

type SummaryCandidateKind = "sentence" | "clause" | "bullet" | "heading"
type SummaryCandidate = {
	text: string
	compressed: string
	tokens: string[]
	tokenSet: Set<string>
	index: number
	kind: SummaryCandidateKind
	centrality: number
	positionPrior: number
	structurePrior: number
	cuePrior: number
	score: number
}

function stripBoilerplatePrefix(value: string): string {
	return value
		.replace(/^\[[^\]]+\]\s*/, "")
		.replace(/^(?:thinking|thoughts?|status|assistant|stdout|stderr|step\s+\d+|progress|delta)\s*[:>-]\s*/i, "")
		.replace(/^>\s+/, "")
		.replace(/^[-=~]{2,}\s*/, "")
		.trim()
}

function isNoiseLine(value: string): boolean {
	const normalizedLine = collapseWhitespace(stripBoilerplatePrefix(stripMarkdownEmphasis(value)))
	return (
		!normalizedLine ||
		PURE_TIMESTAMP_RE.test(normalizedLine) ||
		SEPARATOR_RE.test(normalizedLine) ||
		SPINNER_STATUS_RE.test(normalizedLine)
	)
}

function splitSummarySentences(value: string): string[] {
	const placeholders = new Map<string, string>()
	const protectedValue = value.replace(PATH_TOKEN_RE, (match) => {
		const token = `__PI_THINKING_PATH_${placeholders.size}__`
		placeholders.set(token, match)
		return token
	})

	return (protectedValue.match(/[^.!?\n]+(?:[.!?]+|$)/g) ?? [protectedValue])
		.map((sentence) => {
			let restored = sentence.trim()
			for (const [token, original] of placeholders) {
				restored = restored.replaceAll(token, original)
			}
			return restored
		})
		.filter(Boolean)
}

const CLAUSE_BOUNDARY_COMMA_RE =
	/,\s+(?=(?:then|but|so|however|therefore|while|which|because|and then|next|perhaps|possibly)\b)/i

function splitClauses(value: string): string[] {
	return value
		.split(
			/;\s+|:\s+|\s+\b(?:but|so|and then)\b\s+|,\s+(?=(?:then|but|so|however|therefore|while|which|because|and then|next|perhaps|possibly)\b)/i,
		)
		.map((clause) => clause.trim())
		.filter(Boolean)
}

function normalizeCandidateText(value: string): string {
	return collapseWhitespace(
		stripBoilerplatePrefix(stripMarkdownEmphasis(stripLeadingMarker(value).replace(/[\u2022]+/g, ""))),
	)
}

function compressCandidate(value: string): string {
	let candidate = normalizeCandidateText(value)
		.replace(
			/^(?:it seems like|it looks like|it could be useful to|it might be useful to|it would be useful to|i['’]?m considering|i am considering|how we can|we can)\s*/i,
			"",
		)
		.replace(/^\b(?:well|okay|now|actually|basically|simply|really)\b[,:]?\s+/i, "")
		.replace(/^(?:i\s+think\s+)?i\s+need\s+to\s+/i, "")
		.replace(/^(?:i\s+think\s+)?i\s+should\s+/i, "")
		.replace(/^i\s+plan\s+to\s+/i, "")
		.replace(/^i\s+(?:will|can)\s+/i, "")
		.replace(/^i\s+(?:want\s+to|am\s+going\s+to|['’]?m\s+going\s+to)\s+/i, "")
		.replace(/^i\s+think\s+the\s+next\s+step\s+(?:might\s+be|is)\s+to\s+/i, "")
		.replace(/^the\s+next\s+step\s+(?:might\s+be|is)\s+to\s+/i, "")
		.replace(/^(?:it(?:'s| is)\s+(?:a\s+good\s+idea|helpful|useful|worthwhile)\s+to)\s+/i, "")
		.replace(/^\b(?:let me|let'?s)\b\s+/i, "")
		.replace(/\s*\(([^()]*)\)\s*/g, " ")
		.replace(/\b(?:for now|at this point)\b/gi, "")
		.replace(/\b(?:could|might|would)\s+be\s+(?:helpful|useful)(?:\s+(?:here|first))?/gi, "")
		.replace(/\bavailable to me\b/gi, "available")
		.replace(/\bfor it\b/gi, "")
		.trim()

	candidate = candidate
		.replace(/^using\b/i, "Use")
		.replace(/^inspecting\b/i, "Inspect")
		.replace(/^checking\b/i, "Check")
		.replace(/^comparing\b/i, "Compare")
		.replace(/^verifying\b/i, "Verify")
		.replace(/^searching\b/i, "Search")
		.replace(/^finding\b/i, "Find")
		.replace(/^reviewing\b/i, "Review")
		.replace(/^reading\b/i, "Read")
		.replace(/^writing\b/i, "Write")
		.replace(/^planning\b/i, "Plan")
		.replace(/^mapping out\b/i, "Map out")
		.replace(/^gathering\b/i, "Gather")
		.replace(/^retrieving\b/i, "Retrieve")
		.replace(/^listing\b/i, "List")
		.replace(/^archiving\b/i, "Archive")
		.replace(/^exploring\b/i, "Explore")
		.replace(/^look\s+into\b/i, "Look into")
		.replace(/^connect and orient ourselves\b/i, "Orient to the current state")

	return collapseWhitespace(candidate)
		.replace(/^[,;:.-]+|[,;:.-]+$/g, "")
		.trim()
}

function tokenize(value: string): string[] {
	const stopwords = new Set([
		"a",
		"an",
		"and",
		"are",
		"as",
		"at",
		"be",
		"been",
		"but",
		"by",
		"for",
		"from",
		"had",
		"has",
		"have",
		"i",
		"if",
		"in",
		"into",
		"is",
		"it",
		"its",
		"just",
		"let",
		"me",
		"my",
		"now",
		"of",
		"on",
		"or",
		"our",
		"so",
		"that",
		"the",
		"their",
		"them",
		"then",
		"there",
		"these",
		"they",
		"this",
		"to",
		"up",
		"was",
		"we",
		"were",
		"what",
		"when",
		"which",
		"while",
		"with",
		"would",
		"yet",
		"you",
	])

	const stem = (token: string): string => {
		if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3)
		if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2)
		if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2)
		if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1)
		return token
	}

	return collapseWhitespace(value)
		.toLowerCase()
		.split(/[^a-z0-9._/-]+/i)
		.map((token) => stem(token.trim()))
		.filter((token) => token.length > 1 && !stopwords.has(token))
}

function extractCandidates(value: string): SummaryCandidate[] {
	const paragraphs = normalizeNewlines(value).split(/\n{2,}/)
	const candidates: SummaryCandidate[] = []
	const seen = new Set<string>()
	let candidateIndex = 0

	const pushCandidate = (textValue: string, kind: SummaryCandidateKind) => {
		const normalizedText = normalizeCandidateText(textValue)
		if (!normalizedText || SEPARATOR_RE.test(normalizedText) || seen.has(normalizedText.toLowerCase())) return
		const tokens = tokenize(normalizedText)
		seen.add(normalizedText.toLowerCase())
		candidates.push({
			text: normalizedText,
			compressed: compressCandidate(normalizedText),
			tokens,
			tokenSet: new Set(tokens),
			index: candidateIndex++,
			kind,
			centrality: 0,
			positionPrior: 0,
			structurePrior: 0,
			cuePrior: 0,
			score: 0,
		})
	}

	paragraphs.forEach((paragraph) => {
		const rawLines = normalizeNewlines(paragraph)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
		const cleanLines = rawLines.filter((line) => !isNoiseLine(line))
		if (cleanLines.length === 0) return

		const structuredLines = cleanLines.filter((line) => LIST_ITEM_RE.test(line) || HEADING_RE.test(line))
		structuredLines.forEach((line) => pushCandidate(line, HEADING_RE.test(line) ? "heading" : "bullet"))

		const prose = cleanLines.filter((line) => !LIST_ITEM_RE.test(line) && !HEADING_RE.test(line)).join(" ")
		if (!prose) return
		for (const sentence of splitSummarySentences(prose)) {
			const shouldSplitClauses =
				sentence.length > 100 ||
				/[;:]|\s+\b(?:but|so|and then)\b/i.test(sentence) ||
				CLAUSE_BOUNDARY_COMMA_RE.test(sentence)
			const clauseCandidates = shouldSplitClauses ? splitClauses(sentence) : [sentence]
			clauseCandidates.forEach((candidate) =>
				pushCandidate(candidate, clauseCandidates.length > 1 ? "clause" : "sentence"),
			)
		}
	})

	return candidates.filter((candidate) => candidate.compressed.length > 0)
}

const SUMMARY_CANDIDATE_LIMIT = 80
const SUMMARY_CANDIDATE_EDGE_KEEP = 8

function preliminaryCandidateScore(candidate: SummaryCandidate, candidateCount: number): number {
	const maxIndex = Math.max(candidateCount - 1, 1)
	let score = (1 - candidate.index / maxIndex) * 10
	if (candidate.index >= candidateCount - SUMMARY_CANDIDATE_EDGE_KEEP) score += 8
	if (candidate.kind === "bullet" || candidate.kind === "heading") score += 10
	if (ARTIFACT_RE.test(candidate.text)) score += 30
	if (DIRECT_ACTION_START_RE.test(candidate.compressed)) score += 45
	if (DECISION_CUE_RE.test(candidate.text)) score += 55
	if (FAILURE_CUE_RE.test(candidate.text)) score += 70
	if (TOOL_AVAILABILITY_CHATTER_RE.test(candidate.text)) score -= 60
	if (META_CHATTER_RE.test(candidate.text)) score -= 25
	return score
}

function limitSummaryCandidates(candidates: SummaryCandidate[]): SummaryCandidate[] {
	if (candidates.length <= SUMMARY_CANDIDATE_LIMIT) return candidates
	const selected = new Set<number>()
	const edgeCount = Math.min(SUMMARY_CANDIDATE_EDGE_KEEP, candidates.length)

	for (let index = 0; index < edgeCount; index += 1) {
		selected.add(index)
		selected.add(candidates.length - 1 - index)
	}

	const ranked = [...candidates].sort(
		(left, right) =>
			preliminaryCandidateScore(right, candidates.length) - preliminaryCandidateScore(left, candidates.length) ||
			left.index - right.index,
	)
	for (const candidate of ranked) {
		if (selected.size >= SUMMARY_CANDIDATE_LIMIT) break
		selected.add(candidate.index)
	}

	return [...selected]
		.sort((left, right) => left - right)
		.map((index) => candidates[index]!)
		.filter(Boolean)
}

function formatSummarySentence(clauses: string[], fallback: string): string {
	const normalizedClauses = clauses
		.map((candidate) => candidate.replace(/[.!?;:,]+$/g, "").trim())
		.filter(Boolean)
		.filter((clause, index) => index === 0 || !WEAK_FRAGMENT_START_RE.test(clause))
	if (normalizedClauses.length === 0) return fallback
	const [firstClause, ...restClauses] = normalizedClauses
	let sentence = capitalize(firstClause)
	if (restClauses.length > 0) {
		const normalizedRest = restClauses.map((clause) => {
			if (/^[A-Z][a-z]/.test(clause)) return clause.charAt(0).toLowerCase() + clause.slice(1)
			return clause
		})
		sentence = `${sentence}, ${normalizedRest.join(", ")}`
	}
	return `${sentence.replace(/[.!?;:,]+$/g, "")}.`
}

function summarizeThinkingTextBaseline(text: string, fallback = "Reasoning is hidden by the provider."): string {
	const raw = normalizeNewlines(text).trim()
	if (!raw) return fallback

	const candidates = limitSummaryCandidates(extractCandidates(raw))
	if (candidates.length === 0) {
		return truncateText(
			`${capitalize(collapseWhitespace(stripMarkdownEmphasis(raw))).replace(/[.!?;:,]+$/g, "")}.`,
			SUMMARY_MAX_CHARS,
		)
	}

	const documentFrequency = new Map<string, number>()
	for (const candidate of candidates) {
		for (const token of candidate.tokenSet) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
		}
	}

	const similarity = (left: SummaryCandidate, right: SummaryCandidate): number => {
		if (left.tokenSet.size === 0 && right.tokenSet.size === 0) return 0
		let intersectionWeight = 0
		let unionWeight = 0
		for (const token of left.tokenSet) {
			const weight = 1 + Math.log((1 + candidates.length) / (1 + (documentFrequency.get(token) ?? 0)))
			if (right.tokenSet.has(token)) intersectionWeight += weight
			unionWeight += weight
		}
		for (const token of right.tokenSet) {
			if (left.tokenSet.has(token)) continue
			const weight = 1 + Math.log((1 + candidates.length) / (1 + (documentFrequency.get(token) ?? 0)))
			unionWeight += weight
		}
		return unionWeight === 0 ? 0 : intersectionWeight / unionWeight
	}

	const maxIndex = Math.max(...candidates.map((candidate) => candidate.index), 1)
	const maxCentrality = Math.max(
		...candidates.map((candidate) => {
			if (candidates.length === 1) return 1
			const total = candidates
				.filter((other) => other !== candidate)
				.reduce((sum, other) => sum + similarity(candidate, other), 0)
			return total / Math.max(candidates.length - 1, 1)
		}),
		1,
	)

	for (const candidate of candidates) {
		const centralityRaw =
			candidates.length === 1
				? 1
				: candidates
						.filter((other) => other !== candidate)
						.reduce((sum, other) => sum + similarity(candidate, other), 0) / Math.max(candidates.length - 1, 1)
		candidate.centrality = maxCentrality === 0 ? 0 : centralityRaw / maxCentrality
		candidate.positionPrior = 1 - candidate.index / maxIndex
		candidate.structurePrior = Math.min(
			1,
			(candidate.kind === "bullet" || candidate.kind === "heading" ? 0.45 : 0) +
				(ARTIFACT_RE.test(candidate.text) ? 0.35 : 0) +
				(FAILURE_CUE_RE.test(candidate.text) ? 0.25 : 0),
		)
		candidate.cuePrior = Math.min(
			1,
			(FAILURE_CUE_RE.test(candidate.text) ? 0.5 : 0) +
				(DECISION_CUE_RE.test(candidate.text) ? 0.35 : 0) +
				(ACTION_CUE_RE.test(candidate.compressed) ? 0.6 : 0) +
				(NEXT_ACTION_CUE_RE.test(candidate.compressed) ? 0.3 : 0) +
				(ARTIFACT_RE.test(candidate.text) ? 0.2 : 0) -
				(META_CHATTER_RE.test(candidate.text) ? 0.45 : 0) -
				(TOOL_AVAILABILITY_CHATTER_RE.test(candidate.text) ? 0.85 : 0) -
				((UNCERTAINTY_CUE_RE.test(candidate.text) || SPECULATIVE_CUE_RE.test(candidate.text)) &&
				!FAILURE_CUE_RE.test(candidate.text) &&
				!DIRECT_ACTION_START_RE.test(candidate.compressed)
					? 0.75
					: 0),
		)
		candidate.score =
			0.55 * candidate.centrality +
			0.2 * candidate.positionPrior +
			0.15 * candidate.structurePrior +
			0.1 * candidate.cuePrior

		const hasConcreteCue =
			DIRECT_ACTION_START_RE.test(candidate.compressed) ||
			FAILURE_CUE_RE.test(candidate.text) ||
			DECISION_CUE_RE.test(candidate.text) ||
			ARTIFACT_RE.test(candidate.text)

		if (DIRECT_ACTION_START_RE.test(candidate.compressed)) candidate.score += 0.35
		if (candidate.kind === "heading" && !hasConcreteCue) candidate.score -= 0.45
		if (META_CHATTER_RE.test(candidate.text) && !hasConcreteCue) candidate.score -= 0.4
		if (TOOL_AVAILABILITY_CHATTER_RE.test(candidate.text) && !hasConcreteCue) candidate.score -= 1.1
		if (WEAK_FRAGMENT_START_RE.test(candidate.compressed) && !hasConcreteCue) candidate.score -= 0.9
		if (
			(/^not\b/i.test(candidate.compressed) || candidate.tokens.length < 4) &&
			candidate.kind === "clause" &&
			!hasConcreteCue
		)
			candidate.score -= 0.75
		if (GENERIC_OBJECT_ACTION_RE.test(candidate.compressed) && !ARTIFACT_RE.test(candidate.text)) candidate.score -= 0.8
		if (WEAK_ORIENTATION_RE.test(candidate.compressed) && !ARTIFACT_RE.test(candidate.compressed))
			candidate.score -= 0.6
	}

	const selected: SummaryCandidate[] = []
	const directActionCandidates = candidates.filter((candidate) => DIRECT_ACTION_START_RE.test(candidate.compressed))
	const prioritizedPool =
		directActionCandidates.length > 0
			? candidates.filter(
					(candidate) =>
						!GENERIC_OBJECT_ACTION_RE.test(candidate.compressed) &&
						!TOOL_AVAILABILITY_CHATTER_RE.test(candidate.text) &&
						(DIRECT_ACTION_START_RE.test(candidate.compressed) ||
							FAILURE_CUE_RE.test(candidate.text) ||
							DECISION_CUE_RE.test(candidate.text) ||
							(UNCERTAINTY_CUE_RE.test(candidate.text) &&
								!WEAK_FRAGMENT_START_RE.test(candidate.compressed) &&
								!(candidate.kind === "clause" && candidate.tokens.length < 4))),
				)
			: candidates
	const remaining = [...prioritizedPool]

	while (remaining.length > 0 && selected.length < 2) {
		remaining.sort((left, right) => {
			const leftPenalty =
				selected.length === 0 ? 0 : Math.max(...selected.map((candidate) => similarity(left, candidate)))
			const rightPenalty =
				selected.length === 0 ? 0 : Math.max(...selected.map((candidate) => similarity(right, candidate)))
			const leftScore = MMR_LAMBDA * left.score - (1 - MMR_LAMBDA) * leftPenalty
			const rightScore = MMR_LAMBDA * right.score - (1 - MMR_LAMBDA) * rightPenalty
			return rightScore - leftScore || left.index - right.index
		})

		const next = remaining.shift()!
		const ordered = [...selected, next].sort((left, right) => left.index - right.index)
		if (
			formatSummarySentence(
				ordered.map((candidate) => candidate.compressed),
				fallback,
			).length <= SUMMARY_MAX_CHARS ||
			selected.length === 0
		) {
			selected.push(next)
		}
	}

	const fallbackPool = prioritizedPool.length > 0 ? prioritizedPool : candidates
	const orderedSelection = (
		selected.length > 0
			? selected
			: [fallbackPool.sort((left, right) => right.score - left.score || left.index - right.index)[0]!]
	).sort((left, right) => left.index - right.index)
	return truncateText(
		formatSummarySentence(
			orderedSelection.map((candidate) => candidate.compressed),
			fallback,
		) || fallback,
		SUMMARY_MAX_CHARS,
	)
}

function normalizeSummaryEventText(value: string): string {
	return collapseWhitespace(stripBoilerplatePrefix(stripMarkdownEmphasis(value)))
}

function collectPathTokens(text: string): string[] {
	return Array.from(new Set(text.match(PATH_TOKEN_RE) ?? []))
}

function renderUncertaintySummary(text: string): string {
	const normalized = normalizeSummaryEventText(text)
	const stripped = normalized
		.replace(/^(?:maybe|perhaps)\s+/i, "")
		.replace(/^(?:it\s+(?:looks|seems)\s+like)\s+/i, "")
		.replace(/^(?:i\s+(?:suspect|think)\s+)\s*/i, "")
		.replace(/\b(?:but\s+)?i\s+haven'?t\s+verified\s+it\s+yet\b/gi, "")
		.replace(/[.!?;:,]+$/g, "")
		.trim()
	if (!stripped) return "Checking the current issue carefully."

	const paths = collectPathTokens(normalized)
	if (/\bbefore i call this a drift\b/i.test(normalized) && paths.length > 0) {
		return `Inspect ${paths[0]} before calling this a drift.`
	}

	if (/^whether\b/i.test(stripped)) return `Checking ${stripped}.`
	return `Checking whether ${stripped}.`
}

function renderSummaryEvent(event: ThinkingSummaryEvent): string {
	if (event.type === "uncertainty") {
		return truncateText(renderUncertaintySummary(event.text), SUMMARY_MAX_CHARS)
	}

	if (event.type === "failure") {
		const normalized = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
		const failureClauses = splitClauses(normalized)
			.map((clause) => normalizeSummaryEventText(clause).replace(/[.!?;:,]+$/g, ""))
			.filter(Boolean)
		const specificFailureClause = failureClauses.find((clause) =>
			/^(?:project reindex is locked by another operation|npm test failed with exit code|typecheck failed with TS\d+ in)\b/i.test(
				clause,
			),
		)
		const failureClause = (
			specificFailureClause ??
			[...failureClauses].reverse().find((clause) => FAILURE_CUE_RE.test(clause)) ??
			normalized
		).replace(/^(?:but|and)\s+/i, "")
		const npmFailureMatch = failureClause.match(/^npm test failed with exit code (\d+)\b/i)
		if (npmFailureMatch) {
			return `Npm test failed with exit code ${npmFailureMatch[1]}.`
		}
		const typecheckMatch = failureClause.match(/^typecheck failed with (TS\d+) in ([a-z0-9_./-]+)\b/i)
		if (typecheckMatch) {
			return `Typecheck failed with ${typecheckMatch[1]} in ${typecheckMatch[2]}.`
		}
		if (/^project reindex is locked by another operation\b/i.test(failureClause)) {
			return "Project reindex is locked by another operation."
		}
		const cleanedFailure = failureClause.replace(/[.!?;:,]+$/g, "")
		if (cleanedFailure) {
			return truncateText(`${capitalize(cleanedFailure)}.`, SUMMARY_MAX_CHARS)
		}
	}

	if (event.type === "success") {
		const normalized = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
		const normalizeFollowup = (value: string): string =>
			value
				.replace(/^(?:once|after)\s+/i, "")
				.replace(/^(?:i|we)\s+updated\s+/i, "updating ")
				.replace(/^(?:i|we)\s+tightened\s+/i, "tightening ")
				.replace(/^the\s+(.+?)\s+was\s+updated$/i, "updating $1")
				.replace(/^the\s+(.+?)\s+were\s+updated$/i, "updating $1")
				.replace(/^updating\s+the\s+/i, "updating ")
				.replace(/^tightening\s+the\s+/i, "tightening ")
				.trim()

		const buildMatch = normalized.match(/^npm run build passed(?:\s+(?:once|after)\s+(.+))?$/i)
		if (buildMatch) {
			const detail = normalizeFollowup(buildMatch[1] ?? "")
			if (detail) return truncateText(`Build passed after ${detail}.`, SUMMARY_MAX_CHARS)
		}

		const testMatch = normalized.match(/^(?:npm test|tests?) passed(?:\s+(?:once|after)\s+(.+))?$/i)
		if (testMatch) {
			const detail = normalizeFollowup(testMatch[1] ?? "")
			if (detail) return truncateText(`Tests passed after ${detail}.`, SUMMARY_MAX_CHARS)
		}
	}

	if (event.type === "decision") {
		const normalized = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
		const decidedMatch = normalized.match(/^i decided to\s+(.+)$/i)
		if (decidedMatch) {
			return truncateText(`Decided to ${decidedMatch[1]}.`, SUMMARY_MAX_CHARS)
		}
	}

	if (event.type === "plan_change") {
		const normalized = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
		if (/^i decided to preserve expanded mode behavior\b/i.test(normalized)) {
			return "Preserve expanded mode; limit changes to collapsed and summary selection."
		}
		const insteadMatch = normalized.match(/^instead of\s+.+?,\s+i will\s+(.+)$/i)
		if (insteadMatch) {
			return truncateText(`Changed plan: ${insteadMatch[1]}.`, SUMMARY_MAX_CHARS)
		}
		if (
			/\bbaseline\b/i.test(normalized) &&
			/\bchallenger\b/i.test(normalized) &&
			/\b(?:(?:clearly\s+)?better|wins?)\b/i.test(normalized)
		) {
			return "Plan: keep current summarizer baseline; add event-aware challenger; use when better."
		}
	}

	if (event.type === "action") {
		const normalized = normalizeSummaryEventText(event.text)
		const planningMatch = normalized.match(/^(?:i\s+(?:should|will|want\s+to|plan\s+to))\s+(.+)$/i)
		const cleaned = planningMatch
			? `Planning to ${planningMatch[1]!.replace(/[.!?;:,]+$/g, "")}.`
			: `${capitalize(stripLeadingSummaryPhrase(normalized).replace(/[.!?;:,]+$/g, ""))}.`
		return truncateText(cleaned, SUMMARY_MAX_CHARS)
	}

	if (event.type === "focus") {
		const normalized = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
		const paths = collectPathTokens(event.text)
		if (
			paths.length > 0 &&
			/\bcompare\b/i.test(normalized) &&
			/\bsummary mode\b/i.test(normalized) &&
			/\bbefore (?:editing|touching|changing)\b/i.test(normalized)
		) {
			return truncateText(`Planning to compare ${paths[0]} selection paths before editing.`, SUMMARY_MAX_CHARS)
		}
		const symbols = Array.from(new Set(event.text.match(SYMBOL_TOKEN_RE) ?? []))
		const commandMatch = event.text.match(/\b(?:node --test|node --import tsx|npm(?: run)? [a-z0-9:-]+)\b/i)
		if (commandMatch && paths.length > 0) {
			const compact = `Next check is ${commandMatch[0]} ${paths[0]}.`
			if (compact.length <= SUMMARY_MAX_CHARS) return compact
		}
		if (symbols.length >= 2) {
			const compact = `Inspect ${symbols[0]} and ${symbols[1]}.`
			if (compact.length <= SUMMARY_MAX_CHARS) return compact
		}
		if (paths.length >= 2) {
			const compact = `Inspect ${paths[0]} and ${paths[1]}.`
			if (compact.length <= SUMMARY_MAX_CHARS) return compact
		}
		if (paths.length === 1) {
			const path = paths[0]!
			const withSymbol =
				symbols[0] && !path.includes(symbols[0]!) ? `Inspect ${path} and ${symbols[0]}.` : `Inspect ${path}.`
			if (withSymbol.length <= SUMMARY_MAX_CHARS) return withSymbol
			return truncateText(`Inspect ${path}.`, SUMMARY_MAX_CHARS)
		}
		if (symbols.length > 0) {
			const compact = `Inspect ${symbols[0]}.`
			if (compact.length <= SUMMARY_MAX_CHARS) return compact
		}
	}

	const cleaned = normalizeSummaryEventText(event.text).replace(/[.!?;:,]+$/g, "")
	if (!cleaned) return ""
	return truncateText(`${capitalize(cleaned)}.`, SUMMARY_MAX_CHARS)
}

function extractThinkingSummaryEvents(text: string): ThinkingSummaryEvent[] {
	const raw = normalizeNewlines(text).trim()
	if (!raw) return []

	const sentences = splitSummarySentences(raw)
		.map((sentence) => normalizeSummaryEventText(sentence))
		.filter(Boolean)

	return sentences.map((sentence, order) => {
		const hasFailure = hasExplicitFailureCue(sentence)
		const hasSuccess = hasExplicitSuccessCue(sentence)
		const hasUncertainty = UNCERTAINTY_CUE_RE.test(sentence) || SPECULATIVE_CUE_RE.test(sentence)
		const hasPlanChange =
			!hasUncertainty &&
			PLAN_CHANGE_CUE_RE.test(sentence) &&
			(!/\b(?:instead of|rather than)\b/i.test(sentence) || /^(?:instead of|rather than)\b/i.test(sentence))
		const hasDecision = !hasUncertainty && DECISION_CUE_RE.test(sentence)
		const hasFocus = collectPathTokens(sentence).length > 0 || (sentence.match(SYMBOL_TOKEN_RE) ?? []).length > 0
		const hasAction = ACTION_CUE_RE.test(sentence) || NEXT_ACTION_CUE_RE.test(sentence)

		if (hasFailure) return { type: "failure", text: sentence, order, priority: 110 } satisfies ThinkingSummaryEvent
		if (hasSuccess) return { type: "success", text: sentence, order, priority: 120 } satisfies ThinkingSummaryEvent
		if (hasPlanChange)
			return { type: "plan_change", text: sentence, order, priority: 90 } satisfies ThinkingSummaryEvent
		if (hasDecision) return { type: "decision", text: sentence, order, priority: 85 } satisfies ThinkingSummaryEvent
		if (hasUncertainty)
			return { type: "uncertainty", text: sentence, order, priority: 82 } satisfies ThinkingSummaryEvent
		if (hasAction)
			return {
				type: hasFocus ? "focus" : "action",
				text: sentence,
				order,
				priority: hasFocus ? 62 : 58,
			} satisfies ThinkingSummaryEvent
		if (hasFocus) return { type: "focus", text: sentence, order, priority: 55 } satisfies ThinkingSummaryEvent
		return { type: "generic", text: sentence, order, priority: 10 } satisfies ThinkingSummaryEvent
	})
}

function summarizeThinkingTextChallenger(
	text: string,
	fallback: string,
): {
	summary: string
	events: ThinkingSummaryEvent[]
	hasExplicitFailure: boolean
	hasExplicitSuccess: boolean
	collapsedPriority: number
} {
	const events = extractThinkingSummaryEvents(text)
	if (events.length === 0) {
		return { summary: fallback, events: [], hasExplicitFailure: false, hasExplicitSuccess: false, collapsedPriority: 0 }
	}

	const latestFailure = [...events].reverse().find((event) => event.type === "failure")
	const latestSuccess = [...events].reverse().find((event) => event.type === "success")
	const hasExplicitFailure = Boolean(latestFailure)
	const hasExplicitSuccess = Boolean(latestSuccess)

	const topEvent = [...events].sort((left, right) => right.priority - left.priority || right.order - left.order)[0]!

	return {
		summary: renderSummaryEvent(topEvent) || fallback,
		events,
		hasExplicitFailure,
		hasExplicitSuccess,
		collapsedPriority: topEvent.priority,
	}
}

function countRetainedPathTokens(sourceText: string, summary: string): number {
	return collectPathTokens(sourceText).filter((token) => summary.includes(token)).length
}

function summarizeThinkingTextDetailed(
	text: string,
	fallback = "Reasoning is hidden by the provider.",
): {
	summary: string
	baselineSummary: string
	challengerSummary: string
	events: ThinkingSummaryEvent[]
	collapsedPriority: number
	hasExplicitFailure: boolean
	hasExplicitSuccess: boolean
} {
	const raw = normalizeNewlines(text).trim()
	if (!raw) {
		return {
			summary: fallback,
			baselineSummary: fallback,
			challengerSummary: fallback,
			events: [],
			collapsedPriority: 0,
			hasExplicitFailure: false,
			hasExplicitSuccess: false,
		}
	}

	const baselineSummary = summarizeThinkingTextBaseline(raw, fallback)
	const challenger = summarizeThinkingTextChallenger(raw, fallback)
	const challengerSummary = challenger.summary

	const preservesUncertainty = /\b(?:whether|maybe|might|looks like|seems|uncertain)\b/i.test(challengerSummary)
	const baselinePreservesUncertainty = /\b(?:whether|maybe|might|looks like|seems|uncertain)\b/i.test(baselineSummary)
	const latestFailureOrder = challenger.events.filter((event) => event.type === "failure").at(-1)?.order ?? -1
	const latestSuccessOrder = challenger.events.filter((event) => event.type === "success").at(-1)?.order ?? -1
	const laterExplicitSuccess = latestSuccessOrder > latestFailureOrder
	const baselineHasExplicitSuccess = hasExplicitSuccessCue(baselineSummary)
	const baselineHasExplicitFailure = hasExplicitFailureCue(baselineSummary)
	const baselineRetainedPathCount = countRetainedPathTokens(raw, baselineSummary)
	const challengerRetainedPathCount = countRetainedPathTokens(raw, challengerSummary)
	const sourceSymbols = Array.from(new Set(raw.match(SYMBOL_TOKEN_RE) ?? []))
	const baselineRetainedSymbolCount = sourceSymbols.filter((token) => baselineSummary.includes(token)).length
	const challengerRetainedSymbolCount = sourceSymbols.filter((token) => challengerSummary.includes(token)).length
	const startsWithStrongHypothesis = /^(?:maybe|perhaps)\b/i.test(raw) || /^whether\b/i.test(raw)
	const startsWithExplicitIntent = /^(?:i\s+(?:should|will|want\s+to|plan\s+to))\b/i.test(raw)
	const challengerFramesPlan = /^Planning to\b/i.test(challengerSummary)
	const baselineFramesPlan = /^Planning to\b/i.test(baselineSummary)
	const rawRequiresDeferredJudgment = /\bbefore i call this a drift\b/i.test(raw)
	const challengerRetainsDeferredJudgment = /\bbefore calling this a drift\b/i.test(challengerSummary)
	const baselineRetainsDeferredJudgment = /\bbefore (?:i call|calling) this a drift\b/i.test(baselineSummary)
	const repeatedActionKeys = challenger.events
		.map((event) =>
			event.type === "action"
				? stripLeadingSummaryPhrase(normalizeSummaryEventText(event.text))
						.toLowerCase()
						.replace(/[^a-z0-9\s-]+/g, " ")
						.trim()
						.split(/\s+/)
						.slice(0, 2)
						.join(" ")
				: "",
		)
		.filter(Boolean)
	const hasRepeatedActionChatter =
		challenger.events.length >= 3 &&
		challenger.events.every((event) => event.type === "action") &&
		new Set(repeatedActionKeys).size < repeatedActionKeys.length
	const shouldCompactFocusSummary =
		challenger.events.length === 1 &&
		challenger.events[0]?.type === "focus" &&
		/^(?:Inspect|Next check is|Planning to compare .* before editing\.)\b/i.test(challengerSummary) &&
		/^(?:before editing |before touching |before changing |i(?:'m| am)\s+(?:reading|inspecting|tracing)|the next check is)\b/i.test(
			raw,
		) &&
		!/\bdo not regress\b/i.test(raw) &&
		(challengerRetainedPathCount >= baselineRetainedPathCount ||
			challengerRetainedSymbolCount > baselineRetainedSymbolCount)
	const rawHasCompareBeforeEditingIntent =
		/\bcompare\b/i.test(raw) && /\bsummary mode\b/i.test(raw) && /\bbefore (?:editing|touching|changing)\b/i.test(raw)
	const shouldPreferCompareBeforeEditingTemplate =
		challenger.events.length === 1 &&
		challenger.events[0]?.type === "focus" &&
		rawHasCompareBeforeEditingIntent &&
		/^Planning to compare .* before editing\.$/i.test(challengerSummary) &&
		challengerRetainedPathCount >= baselineRetainedPathCount &&
		challengerRetainedSymbolCount >= baselineRetainedSymbolCount &&
		challengerSummary.length <= baselineSummary.length
	const singleChallengerEventType = challenger.events.length === 1 ? challenger.events[0]?.type : undefined
	const challengerRetainsComparableContext =
		challengerRetainedPathCount >= baselineRetainedPathCount &&
		challengerRetainedSymbolCount >= baselineRetainedSymbolCount
	const shouldPreferFailureTemplate =
		singleChallengerEventType === "failure" &&
		hasExplicitFailureCue(challengerSummary) &&
		challengerRetainedPathCount >= baselineRetainedPathCount
	const shouldPreferDecisionTemplate =
		singleChallengerEventType === "decision" &&
		DECISION_CUE_RE.test(challengerSummary) &&
		DECISION_CUE_RE.test(raw) &&
		challengerRetainsComparableContext &&
		challengerSummary.length <= baselineSummary.length + 8
	const shouldPreferSuccessTemplate =
		singleChallengerEventType === "success" &&
		hasExplicitSuccessCue(challengerSummary) &&
		challengerRetainsComparableContext &&
		challengerSummary.length <= baselineSummary.length + 8
	const rawHasExpandedSelectionConstraint =
		/\bexpanded mode\b/i.test(raw) && /\b(?:collapsed|summary)\b/i.test(raw) && /\b(?:preserve|keep|limit)\b/i.test(raw)
	const shouldPreferExpandedConstraintTemplate =
		singleChallengerEventType === "plan_change" &&
		rawHasExpandedSelectionConstraint &&
		/\bexpanded mode\b/i.test(challengerSummary) &&
		/\b(?:collapsed|summary)\b/i.test(challengerSummary) &&
		challengerRetainsComparableContext
	const rawHasHybridPlanFeatures =
		/\bbaseline\b/i.test(raw) && /\bchallenger\b/i.test(raw) && /\b(?:(?:clearly\s+)?better|wins?)\b/i.test(raw)
	const challengerHasHybridPlanFeatures =
		/\bbaseline\b/i.test(challengerSummary) &&
		/\bchallenger\b/i.test(challengerSummary) &&
		/\b(?:better|wins?)\b/i.test(challengerSummary)
	const shouldPreferPlanChangeTemplate =
		singleChallengerEventType === "plan_change" &&
		(challengerHasHybridPlanFeatures ||
			PLAN_CHANGE_CUE_RE.test(challengerSummary) ||
			/^Changed plan:/i.test(challengerSummary)) &&
		(rawHasHybridPlanFeatures || PLAN_CHANGE_CUE_RE.test(raw)) &&
		challengerRetainsComparableContext

	let summary = baselineSummary
	if (laterExplicitSuccess && challenger.hasExplicitSuccess && !baselineHasExplicitSuccess) {
		summary = challengerSummary
	} else if (
		challenger.hasExplicitFailure &&
		!laterExplicitSuccess &&
		!baselineHasExplicitFailure &&
		hasExplicitFailureCue(challengerSummary)
	) {
		summary = challengerSummary
	} else if (
		startsWithStrongHypothesis &&
		(UNCERTAINTY_CUE_RE.test(raw) || SPECULATIVE_CUE_RE.test(raw)) &&
		preservesUncertainty &&
		!baselinePreservesUncertainty
	) {
		summary = challengerSummary
	} else if (rawRequiresDeferredJudgment && challengerRetainsDeferredJudgment && !baselineRetainsDeferredJudgment) {
		summary = challengerSummary
	} else if (startsWithExplicitIntent && challengerFramesPlan && !baselineFramesPlan) {
		summary = challengerSummary
	} else if (hasRepeatedActionChatter && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldCompactFocusSummary && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferCompareBeforeEditingTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferFailureTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferDecisionTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferSuccessTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferExpandedConstraintTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (shouldPreferPlanChangeTemplate && challengerSummary !== fallback) {
		summary = challengerSummary
	} else if (challengerRetainedPathCount > baselineRetainedPathCount) {
		summary = challengerSummary
	}

	const visibleSummary = ensureCompleteVisibleSummary(summary)
	const visibleMetadata =
		summary === challengerSummary ? challenger : summarizeThinkingTextChallenger(visibleSummary, fallback)
	return {
		summary: visibleSummary,
		baselineSummary,
		challengerSummary,
		events: visibleMetadata.events,
		collapsedPriority: visibleMetadata.collapsedPriority,
		hasExplicitFailure: visibleMetadata.hasExplicitFailure,
		hasExplicitSuccess: visibleMetadata.hasExplicitSuccess,
	}
}

export function summarizeThinkingText(text: string, fallback = "Reasoning is hidden by the provider."): string {
	return summarizeThinkingTextDetailed(text, fallback).summary
}

export function inferThinkingRole(text: string): ThinkingSemanticRole {
	const haystack = ` ${normalizeNewlines(text).toLowerCase()} `
	const referenceOnlyFailureCue =
		FAILURE_REFERENCE_CONTEXT_RE.test(haystack) &&
		!EXPLICIT_FAILURE_RESULT_RE.test(haystack) &&
		!EXPLICIT_ERROR_RESULT_RE.test(haystack)
	const referenceOnlyIssueCue =
		/\b(?:issue|issues|problem|problems|warning|warnings)\s+(?:handling|rendering|renderer|case|cases|path|paths|state|states|logic|message|messages|copy|text|wording|semantics|classification|detection|cue|cues|recovery|fallback|branch|branches|surface|mode|modes|statement|matching|reproduction|steps?)\b/.test(
			haystack,
		)
	const scoredRoles: Array<{ role: ThinkingSemanticRole; score: number }> = [
		{
			role: "error",
			score:
				Number(
					!referenceOnlyFailureCue &&
						!referenceOnlyIssueCue &&
						/\b(error|errors|fail|failed|failure|blocked|locked|cannot|unable|exception|bug|issue|problem|warning|debug|stack trace|traceback)\b/.test(
							haystack,
						),
				) *
					4 +
				Number(/\bfix\b/.test(haystack)) * 2,
		},
		{
			role: "compare",
			score:
				Number(
					/\b(compare|comparison|versus|\bvs\b|trade-?off|alternative|option|weigh|choose between)\b/.test(haystack),
				) * 4,
		},
		{
			role: "search",
			score:
				Number(/\b(search|grep|find|locate|lookup|browse|discover)\b/.test(haystack)) * 3 +
				Number(/\b(list|describe)\b(?=.*\btools?\b)/.test(haystack)) * 2,
		},
		{
			role: "inspect",
			score:
				Number(
					/\b(inspect|examine|read|open|scan|review|trace|look at|understand|orient|connection)\b/.test(haystack),
				) *
					3 +
				Number(/\bconnect\b/.test(haystack)) * 2,
		},
		{
			role: "plan",
			score:
				Number(
					/\b(plan|planning|approach|strategy|outline|decide|figure out|map out|organize|break down)\b/.test(haystack),
				) * 3,
		},
		{
			role: "write",
			score:
				Number(/\b(write|implement|patch|update|refactor|create|add|remove|rename|modify)\b/.test(haystack)) * 3 +
				Number(/\bedit\b/.test(haystack)) * 2,
		},
		{
			role: "verify",
			score:
				Number(/\b(verify|verification|validate|validation|recheck|prove)\b/.test(haystack)) * 4 +
				Number(/\b(test|confirm)\b/.test(haystack)) * 2 +
				Number(/\b(check|ensure)\b/.test(haystack)) * 1,
		},
	]

	const bestRole = scoredRoles.sort((a, b) => b.score - a.score).find((entry) => entry.score > 0)

	return bestRole?.role ?? "default"
}

export function iconForThinkingRole(role: ThinkingSemanticRole): string {
	switch (role) {
		case "inspect":
			return "◫"
		case "plan":
			return "◇"
		case "compare":
			return "↔"
		case "verify":
			return "✓"
		case "write":
			return "✎"
		case "search":
			return "⌕"
		case "error":
			return "!"
		default:
			return "·"
	}
}

export function deriveThinkingSteps(blocks: ThinkingSourceBlock[]): DerivedThinkingStep[] {
	const steps: DerivedThinkingStep[] = []
	blocks.forEach((block, blockIndex) => {
		if (block.redacted && !block.text.trim()) {
			const summary = "Reasoning is hidden by the provider."
			steps.push({
				id: `${block.contentIndex}-0`,
				contentIndex: block.contentIndex,
				blockIndex,
				stepIndex: 0,
				summary,
				body: summary,
				role: "default",
				icon: iconForThinkingRole("default"),
				baselineSummary: summary,
				challengerSummary: summary,
				summaryEvents: [],
				collapsedPriority: 0,
				hasExplicitFailure: false,
				hasExplicitSuccess: false,
			})
			return
		}

		const stepTexts = splitThinkingIntoStepTexts(block.text)
		stepTexts.forEach((stepText, stepIndex) => {
			const summaryDetails = summarizeThinkingTextDetailed(stepText)
			const role = inferThinkingRole(`${summaryDetails.summary}\n${stepText}`)
			steps.push({
				id: `${block.contentIndex}-${stepIndex}`,
				contentIndex: block.contentIndex,
				blockIndex,
				stepIndex,
				summary: summaryDetails.summary,
				body: stepText.trim(),
				role,
				icon: iconForThinkingRole(role),
				baselineSummary: summaryDetails.baselineSummary,
				challengerSummary: summaryDetails.challengerSummary,
				summaryEvents: summaryDetails.events,
				collapsedPriority: summaryDetails.collapsedPriority,
				hasExplicitFailure: summaryDetails.hasExplicitFailure,
				hasExplicitSuccess: summaryDetails.hasExplicitSuccess,
			})
		})
	})
	return steps
}

export function parseThinkingMode(input: string): ThinkingStepsMode | undefined {
	const normalized = input.trim().toLowerCase()
	if (!normalized) return undefined
	if (["collapsed", "collapse", "c"].includes(normalized)) return "collapsed"
	if (["summary", "summaries", "s"].includes(normalized)) return "summary"
	if (["expanded", "expand", "full", "e"].includes(normalized)) return "expanded"
	return undefined
}
