/**
 * Page fetcher — retrieves a URL using Playwright (primary) or native fetch() (fallback).
 *
 * Playwright renders JavaScript, so SPA content is captured. When Playwright is
 * not installed, falls back to native fetch() with a warning.
 */

import { getBrowser } from "./browser-pool.js"

/** Maximum raw response size in bytes (5 MB). */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** Default timeout in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 30

/** Binary content-type prefixes that we refuse to process. */
const BINARY_PREFIXES = [
	"image/",
	"audio/",
	"video/",
	"application/octet-stream",
	"application/zip",
	"application/gzip",
	"application/pdf",
	"application/wasm",
	"font/",
] as const

/** Content-type prefixes treated as text (returned as-is when non-HTML). */
const TEXT_PREFIXES = [
	"text/",
	"application/json",
	"application/xml",
	"application/xhtml+xml",
	"application/rss+xml",
	"application/atom+xml",
	"application/javascript",
	"application/x-javascript",
	"application/ld+json",
] as const

export interface FetchResult {
	body: string
	finalURL: string
	contentType: string
	statusCode: number
	isHTML: boolean
	/** Set when Playwright was unavailable and native fetch was used instead. */
	fallbackWarning?: string
}

export class FetchError extends Error {
	constructor(
		message: string,
		public readonly category: "timeout" | "cancelled" | "http" | "network" | "binary" | "too_large" | "unknown",
	) {
		super(message)
		this.name = "FetchError"
	}
}

export interface FetchOptions {
	timeoutSeconds?: number
	/** Requested output format — when "text" and Playwright is active, uses page.textContent(). */
	format?: "markdown" | "text" | "html"
	signal?: AbortSignal
}

function isBinaryContentType(ct: string): boolean {
	const lower = ct.toLowerCase()
	return BINARY_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function isTextContentType(ct: string): boolean {
	const lower = ct.toLowerCase()
	return TEXT_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function isHTMLContentType(ct: string): boolean {
	const lower = ct.toLowerCase()
	return lower.startsWith("text/html") || lower.startsWith("application/xhtml+xml")
}

/**
 * Fetch a URL. Tries Playwright first; falls back to native fetch() when
 * Playwright is not installed.
 */
export async function fetchPage(url: string, options?: FetchOptions): Promise<FetchResult> {
	const browser = await getBrowser()
	if (browser) {
		return fetchWithPlaywright(browser, url, options)
	}
	return fetchWithNative(url, options)
}

// ---------------------------------------------------------------------------
// Playwright path
// ---------------------------------------------------------------------------

async function fetchWithPlaywright(
	browser: import("playwright").Browser,
	url: string,
	options?: FetchOptions,
): Promise<FetchResult> {
	const timeoutMs = (options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
	const page = await browser.newPage()

	if (options?.signal) {
		if (options.signal.aborted) {
			void page.close().catch(() => {})
			throw new FetchError(`Fetch of "${url}" was cancelled`, "cancelled")
		}
		options.signal.addEventListener(
			"abort",
			() => {
				void page.close().catch(() => {})
			},
			{ once: true },
		)
	}

	try {
		const response = await page.goto(url, {
			waitUntil: "load",
			timeout: timeoutMs,
		})

		if (!response) {
			throw new FetchError(`No response from "${url}"`, "network")
		}

		const statusCode = response.status()
		if (statusCode >= 400) {
			throw new FetchError(`HTTP ${statusCode} ${response.statusText()} fetching "${url}"`, "http")
		}

		const contentType = response.headers()["content-type"] ?? "application/octet-stream"
		if (isBinaryContentType(contentType)) {
			throw new FetchError(
				`Unsupported binary content-type "${contentType}" for "${url}". Only text-based content is supported`,
				"binary",
			)
		}

		const finalURL = page.url()

		// For non-HTML text content, read the body bytes directly.
		if (!isHTMLContentType(contentType)) {
			const buf = await response.body()
			if (buf.byteLength > MAX_RESPONSE_BYTES) {
				throw new FetchError(
					`Response too large: ${buf.byteLength} bytes exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for "${url}"`,
					"too_large",
				)
			}
			if (!isTextContentType(contentType)) {
				// Unknown non-binary type — try to decode as text
				try {
					return {
						body: new TextDecoder().decode(buf),
						finalURL,
						contentType,
						statusCode,
						isHTML: false,
					}
				} catch {
					throw new FetchError(`Unsupported content-type "${contentType}" for "${url}"`, "binary")
				}
			}
			return {
				body: new TextDecoder().decode(buf),
				finalURL,
				contentType,
				statusCode,
				isHTML: false,
			}
		}

		// HTML content — wait for network to settle so JS can finish rendering.
		await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {
			// networkidle may not fire on very busy pages — proceed with what we have.
		})

		// For format: text, use Playwright's built-in textContent extraction
		// which captures the rendered (post-JS) text.
		if (options?.format === "text") {
			const textContent = (await page.textContent("body")) ?? ""
			const byteLength = new TextEncoder().encode(textContent).byteLength
			if (byteLength > MAX_RESPONSE_BYTES) {
				throw new FetchError(
					`Response too large: ${byteLength} bytes exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for "${url}"`,
					"too_large",
				)
			}
			return {
				body: textContent,
				finalURL,
				contentType,
				statusCode,
				isHTML: true,
				// Signal that text was extracted directly by Playwright — skip
				// content-converter's DOM-based text extraction.
			}
		}

		// For markdown/html, get the full rendered HTML.
		const html = await page.content()
		const byteLength = new TextEncoder().encode(html).byteLength
		if (byteLength > MAX_RESPONSE_BYTES) {
			throw new FetchError(
				`Response too large: ${byteLength} bytes exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for "${url}"`,
				"too_large",
			)
		}

		return {
			body: html,
			finalURL,
			contentType,
			statusCode,
			isHTML: true,
		}
	} catch (err: unknown) {
		if (err instanceof FetchError) throw err
		if (options?.signal?.aborted) {
			throw new FetchError(`Fetch of "${url}" was cancelled`, "cancelled")
		}
		const name = err instanceof Error ? err.name : ""
		const message = err instanceof Error ? err.message : String(err)
		if (name === "TimeoutError" || message.includes("Timeout") || message.includes("timeout")) {
			throw new FetchError(
				`Timeout: request to "${url}" timed out after ${options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS} seconds`,
				"timeout",
			)
		}
		if (message.includes("ERR_NAME_NOT_RESOLVED") || message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
			throw new FetchError(`DNS error: could not resolve hostname for "${url}"`, "network")
		}
		if (message.includes("ERR_CONNECTION_REFUSED") || message.includes("ECONNREFUSED")) {
			throw new FetchError(`Connection refused: "${url}"`, "network")
		}
		if (message.includes("ERR_CONNECTION_RESET") || message.includes("ECONNRESET")) {
			throw new FetchError(`Connection reset while fetching "${url}"`, "network")
		}
		throw new FetchError(`Network error fetching "${url}": ${message}`, "network")
	} finally {
		await page.close().catch(() => {})
	}
}

// ---------------------------------------------------------------------------
// Native fetch fallback
// ---------------------------------------------------------------------------

const FALLBACK_WARNING =
	"Warning: Playwright is not installed. Fetching with native HTTP client — " +
	"JavaScript-rendered content (SPAs) will not be captured. " +
	"Run `npx playwright install chromium` to enable full SPA support."

async function fetchWithNative(url: string, options?: FetchOptions): Promise<FetchResult> {
	const timeoutMs = (options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal

	let response: Response
	try {
		response = await fetch(url, {
			signal,
			redirect: "follow",
			headers: {
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		})
	} catch (err: unknown) {
		clearTimeout(timer)
		if (err instanceof DOMException && err.name === "AbortError") {
			if (options?.signal?.aborted) {
				throw new FetchError(`Fetch of "${url}" was cancelled`, "cancelled")
			}
			throw new FetchError(
				`Timeout: request to "${url}" timed out after ${options?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS} seconds`,
				"timeout",
			)
		}
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
			throw new FetchError(`DNS error: could not resolve hostname for "${url}"`, "network")
		}
		if (message.includes("ECONNREFUSED")) {
			throw new FetchError(`Connection refused: "${url}"`, "network")
		}
		if (message.includes("ECONNRESET") || message.includes("EPIPE")) {
			throw new FetchError(`Connection reset while fetching "${url}"`, "network")
		}
		throw new FetchError(`Network error fetching "${url}": ${message}`, "network")
	} finally {
		clearTimeout(timer)
	}

	// HTTP errors
	if (!response.ok) {
		throw new FetchError(`HTTP ${response.status} ${response.statusText} fetching "${url}"`, "http")
	}

	// Content-type checks
	const contentType = response.headers.get("content-type") ?? "application/octet-stream"
	if (isBinaryContentType(contentType)) {
		throw new FetchError(
			`Unsupported binary content-type "${contentType}" for "${url}". Only text-based content is supported`,
			"binary",
		)
	}

	// Size check via Content-Length header (fast path)
	const contentLength = response.headers.get("content-length")
	if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
		throw new FetchError(
			`Response too large: ${contentLength} bytes exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit for "${url}"`,
			"too_large",
		)
	}

	// Read body as text, enforcing size limit
	let body: string
	if (!isTextContentType(contentType) && !isHTMLContentType(contentType)) {
		try {
			body = await readBodyWithLimit(response)
		} catch (err) {
			if (err instanceof FetchError) throw err
			throw new FetchError(`Unsupported content-type "${contentType}" for "${url}"`, "binary")
		}
	} else {
		body = await readBodyWithLimit(response)
	}

	return {
		body,
		finalURL: response.url,
		contentType,
		statusCode: response.status,
		isHTML: isHTMLContentType(contentType),
		fallbackWarning: FALLBACK_WARNING,
	}
}

/**
 * Read the response body as text, enforcing the 5 MB size limit.
 */
async function readBodyWithLimit(response: Response): Promise<string> {
	const buffer = await response.arrayBuffer()
	if (buffer.byteLength > MAX_RESPONSE_BYTES) {
		throw new FetchError(
			`Response too large: ${buffer.byteLength} bytes exceeds the ${MAX_RESPONSE_BYTES / 1024 / 1024}MB limit`,
			"too_large",
		)
	}
	return new TextDecoder().decode(buffer)
}
