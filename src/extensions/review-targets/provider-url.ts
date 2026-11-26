import { join } from "node:path"
import type { ProviderReviewRequest } from "./types.js"

// biome-ignore lint/suspicious/noControlCharactersInRegex: Provider-supplied terminal escapes must not reach the display.
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: Provider-supplied terminal escapes must not reach the display.
const ANSI_OSC = /\u001b\][^\u0007\u001b]*?(?:\u0007|\u001b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: Provider-supplied terminal controls must not reach the display.
const TERMINAL_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

/** Terminal-safe provider presentation text, independent of Git ref spellings. */
export function sanitizeReviewDisplayText(value: string): string {
	return value.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(TERMINAL_CONTROLS, "").replace(/\s+/g, " ").trim()
}

export interface ParsedProviderReviewUrl {
	url: string
	provider: ProviderReviewRequest["provider"]
	host: string
	project: string
	number: number
}

function decodedSegments(pathname: string): string[] | undefined {
	try {
		const segments = pathname
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment))
		return segments.every(
			(segment) =>
				segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\"),
		)
			? segments
			: undefined
	} catch {
		return undefined
	}
}

/** Parse only the public PR/MR URL forms accepted by /review. */
export function parseProviderReviewUrl(input: string): ParsedProviderReviewUrl | undefined {
	let parsed: URL
	try {
		parsed = new URL(input)
	} catch {
		return undefined
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined
	// Never carry query credentials or fragments into provider argv or durable scope.
	parsed.search = ""
	parsed.hash = ""
	const canonicalUrl = `${parsed.origin}${parsed.pathname}`
	const segments = decodedSegments(parsed.pathname)
	if (!segments) return undefined

	if (parsed.hostname.toLowerCase() === "github.com" && !parsed.port) {
		if (segments.length !== 4 || segments[2] !== "pull" || !/^[1-9]\d*$/.test(segments[3])) return undefined
		const number = Number(segments[3])
		if (!Number.isSafeInteger(number)) return undefined
		return {
			url: canonicalUrl,
			provider: "github",
			host: "github.com",
			project: `${segments[0]}/${segments[1]}`,
			number,
		}
	}

	const marker = segments.lastIndexOf("-")
	const numberText = segments.at(-1) ?? ""
	if (
		marker < 1 ||
		segments.length !== marker + 3 ||
		segments[marker + 1] !== "merge_requests" ||
		!/^[1-9]\d*$/.test(numberText)
	) {
		return undefined
	}
	const number = Number(numberText)
	if (!Number.isSafeInteger(number)) return undefined
	return {
		url: canonicalUrl,
		provider: "gitlab",
		host: parsed.host.toLowerCase(),
		project: segments.slice(0, marker).join("/"),
		number,
	}
}

function safeCacheSegment(value: string): string {
	if (/^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..") return value
	return encodeURIComponent(value)
}

export function reviewRepositoryCachePath(
	request: Pick<ProviderReviewRequest, "host" | "project">,
	cacheRoot: string,
): string {
	const segments = request.project.split("/").map(safeCacheSegment)
	const repository = `${segments.pop()}.git`
	return join(cacheRoot, safeCacheSegment(request.host), ...segments, repository)
}
