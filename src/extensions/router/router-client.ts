import { Type } from "typebox"
import { Value } from "typebox/value"
import type { RouterConfig } from "./router-config.js"

const RouterResponseSchema = Type.Object(
	{
		best_model: Type.String({ pattern: "\\S" }),
		probabilities: Type.Record(Type.String({ pattern: "\\S" }), Type.Number()),
	},
	{ additionalProperties: true },
)

export interface RouteRecommendation {
	bestModel: string
	probabilities: Readonly<Record<string, number>>
}

export type RouteQueryResult =
	| { ok: true; recommendation: RouteRecommendation }
	| { ok: false; reason: "cancelled" | "timeout" | "network" | "http" | "malformed" }

export const ROUTER_TIMEOUT_MS = 5000

export async function routeQuery(
	query: string,
	config: RouterConfig,
	options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RouteQueryResult> {
	const controller = new AbortController()
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, ROUTER_TIMEOUT_MS)
	const onExternalAbort = () => controller.abort()
	if (options.signal?.aborted) controller.abort()
	else options.signal?.addEventListener("abort", onExternalAbort, { once: true })

	try {
		const response = await (options.fetchImpl ?? fetch)(new URL("/v1/route", config.endpoint), {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
			body: JSON.stringify({ query }),
			signal: controller.signal,
		})
		if (!response.ok) return { ok: false, reason: "http" }

		let data: unknown
		try {
			data = await response.json()
		} catch {
			return { ok: false, reason: "malformed" }
		}
		if (!Value.Check(RouterResponseSchema, data)) return { ok: false, reason: "malformed" }
		const bestModel = data.best_model.trim()
		return { ok: true, recommendation: { bestModel, probabilities: data.probabilities } }
	} catch {
		if (options.signal?.aborted) return { ok: false, reason: "cancelled" }
		if (timedOut) return { ok: false, reason: "timeout" }
		return { ok: false, reason: "network" }
	} finally {
		clearTimeout(timeout)
		options.signal?.removeEventListener("abort", onExternalAbort)
	}
}
