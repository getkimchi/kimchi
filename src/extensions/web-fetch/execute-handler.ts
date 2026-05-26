/**
 * Execute handler for the web_fetch tool.
 *
 * Separated from index.ts so it can be tested without importing
 * pi-mono framework packages (pi-ai, pi-coding-agent, typebox).
 */

import { cacheGet, cacheSet } from "./cache.js"
import { type OutputFormat, convertContent } from "./content-converter.js"
import { FetchError, type FetchResult, fetchPage } from "./page-fetcher.js"
import { validateURL } from "./url-validator.js"

/** Maximum timeout in seconds. Values above this are clamped. */
export const MAX_TIMEOUT_SECONDS = 120

/** Maximum output characters before truncation. */
export const MAX_OUTPUT_CHARS = 100_000

export interface WebFetchParams {
	url: string
	format?: OutputFormat
	timeout?: number
}

export interface WebFetchDetails {
	durationMs: number
	words: number
	warning: string | undefined
}

export interface WebFetchResult {
	content: { type: "text"; text: string }[]
	details: WebFetchDetails
}

function countWords(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length
}

function buildOutput(metadataLines: string[], content: string, truncationNotice: string): string {
	return `${metadataLines.join("\n")}\n\n${content}${truncationNotice}`
}

export async function executeWebFetch(params: WebFetchParams, signal?: AbortSignal): Promise<WebFetchResult> {
	const format: OutputFormat = params.format ?? "markdown"
	const timeoutSeconds = params.timeout != null ? Math.max(0, Math.min(params.timeout, MAX_TIMEOUT_SECONDS)) : undefined
	const startedAt = Date.now()

	const errorResult = (text: string): WebFetchResult => ({
		content: [{ type: "text" as const, text }],
		details: { durationMs: Date.now() - startedAt, words: countWords(text), warning: undefined },
	})

	// Validate URL
	const validation = validateURL(params.url)
	if (!validation.valid) {
		return errorResult(`Error: ${validation.error}`)
	}

	// Check cache
	const cached = cacheGet(params.url, format)
	if (cached != null) {
		return {
			content: [{ type: "text" as const, text: cached }],
			details: { durationMs: Date.now() - startedAt, words: countWords(cached), warning: undefined },
		}
	}

	// Fetch
	let result: FetchResult
	try {
		result = await fetchPage(params.url, { timeoutSeconds, format, signal })
	} catch (err: unknown) {
		const message = err instanceof FetchError ? err.message : err instanceof Error ? err.message : String(err)
		return errorResult(`Error: ${message}`)
	}

	// Convert content based on format.
	// When Playwright extracted text directly (format: text), the body is already
	// plain text — skip the content converter. For non-HTML, return as-is.
	const playwrightExtractedText = result.isHTML && format === "text" && !result.fallbackWarning
	let content =
		result.isHTML && !playwrightExtractedText ? convertContent(result.body, result.finalURL, format) : result.body

	// Truncate output if it exceeds the character limit
	const totalChars = content.length
	let truncated = false
	if (content.length > MAX_OUTPUT_CHARS) {
		content = content.slice(0, MAX_OUTPUT_CHARS)
		truncated = true
	}

	// Build metadata header
	const lines = [
		`URL: ${params.url}`,
		...(result.finalURL !== params.url ? [`Final URL: ${result.finalURL}`] : []),
		`Content-Type: ${result.contentType}`,
		`Format: ${format}`,
		`Characters: ${totalChars.toLocaleString()}`,
		...(truncated
			? [
					`Truncated: content truncated to ${MAX_OUTPUT_CHARS.toLocaleString()} of ${totalChars.toLocaleString()} characters`,
				]
			: []),
		"Cache: miss",
		...(result.fallbackWarning ? [result.fallbackWarning] : []),
	]

	const truncationNotice = truncated
		? `\n\n[Content truncated: showing ${MAX_OUTPUT_CHARS.toLocaleString()} of ${totalChars.toLocaleString()} characters]`
		: ""
	const output = buildOutput(lines, content, truncationNotice)

	// Store in cache with Cache: hit metadata (swap at array level to avoid
	// corrupting page body that might contain the literal "Cache: miss" string)
	const cacheIndex = lines.indexOf("Cache: miss")
	const cachedLines = [...lines]
	cachedLines[cacheIndex] = "Cache: hit"
	// Truncated responses are cached as-is: re-fetching would hit the same
	// truncation limit, so serving the truncated copy is correct.
	cacheSet(params.url, format, buildOutput(cachedLines, content, truncationNotice))

	return {
		content: [{ type: "text" as const, text: output }],
		details: {
			durationMs: Date.now() - startedAt,
			words: countWords(output),
			warning: result.fallbackWarning,
		},
	}
}
