import { createHash } from "node:crypto"
import { resolveEndpoints } from "../../config.js"
import { isWorkId } from "../../shared/work-id.js"
import { plainURL } from "../../utils/url.js"
import { object, SHA256_HEX } from "./summary.js"

// Billing identity captured when a request is dispatched, and the exact tag that later finds its bill.

export interface BillingSource {
	apiUrl: string
	gatewayUrl: string
	/** One-way fingerprint of the credential actually sent; never the credential itself. */
	credentialHash: string
}

export type BillingSelector = { type: "tag"; tag: string; startTime: string; endTime: string }

/** The exact tag finds the bill; starting early tolerates a fast local clock within the API's 33-day range. */
export const LOOKUP_LEAD_MS = 12 * 60 * 60_000

/** How long after dispatch a bill is still looked up. */
export const LOOKUP_WINDOW_MS = 32 * 24 * 60 * 60_000

/** Billing timestamps describe completed reports, so retain a broad fixed window. */
export function requestTagSelector(
	requestId: string,
	dispatchedAt: string,
	leadMs = LOOKUP_LEAD_MS,
): BillingSelector | undefined {
	if (!isWorkId(requestId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(dispatchedAt)) return undefined
	const timestamp = Date.parse(dispatchedAt)
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== dispatchedAt) return undefined
	return {
		type: "tag",
		tag: `kimchi-request:${requestId}`,
		startTime: new Date(timestamp - leadMs).toISOString(),
		endTime: new Date(timestamp + LOOKUP_WINDOW_MS).toISOString(),
	}
}

function httpUrl(value: unknown): value is string {
	return plainURL(value, ["https:", "http:"]) !== undefined
}

function fingerprint(key: string): string {
	return createHash("sha256").update(key).digest("hex")
}

export function isBillingSource(value: unknown): value is BillingSource {
	return (
		object(value) &&
		httpUrl(value.apiUrl) &&
		httpUrl(value.gatewayUrl) &&
		typeof value.credentialHash === "string" &&
		SHA256_HEX.test(value.credentialHash)
	)
}

export function sameBillingSource(left: BillingSource, right: BillingSource): boolean {
	return (
		left.apiUrl === right.apiUrl && left.gatewayUrl === right.gatewayUrl && left.credentialHash === right.credentialHash
	)
}

/** Capture at dispatch, after provider auth has supplied the actual outgoing headers. */
export function captureBillingSource(headers: Headers, url: string, cwd: string): BillingSource | undefined {
	const key = headers.get("x-api-key") ?? /^Bearer (\S+)$/i.exec(headers.get("authorization") ?? "")?.[1]
	if (!key) return undefined
	let gatewayUrl: string
	try {
		const parsed = new URL(url)
		parsed.search = ""
		parsed.hash = ""
		gatewayUrl = parsed.toString()
	} catch {
		return undefined
	}
	if (!httpUrl(gatewayUrl)) return undefined
	const endpoints = resolveEndpoints({ cwd })
	const configured = [
		endpoints.llmEndpoint,
		endpoints.openAiBaseUrl,
		endpoints.anthropicBaseUrl,
		endpoints.experimentalOpenAiBaseUrl,
	]
	if (!configured.some((base) => gatewayUrl.startsWith(`${base.replace(/\/+$/, "")}/`))) return undefined
	if (!httpUrl(endpoints.platformApiUrl)) return undefined
	return { apiUrl: endpoints.platformApiUrl.replace(/\/+$/, ""), gatewayUrl, credentialHash: fingerprint(key) }
}

export function isBillingSelector(value: unknown): value is BillingSelector {
	return (
		object(value) &&
		value.type === "tag" &&
		typeof value.tag === "string" &&
		typeof value.startTime === "string" &&
		typeof value.endTime === "string"
	)
}

export function sameBillingSelector(left: BillingSelector, right: BillingSelector): boolean {
	return left.tag === right.tag && left.startTime === right.startTime && left.endTime === right.endTime
}
