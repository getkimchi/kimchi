/**
 * Cast AI Analytics API Client
 *
 * Fetches analytics, productivity metrics, and timeseries data from Cast AI.
 */

import { resolveEndpoints } from "../../config.js"
import { fetchWithRetry } from "../../utils/http.js"
import type {
	BreakdownDimension,
	GenerateAnalyticsResponse,
	GenerateBreakdownResponse,
	GenerateProductivityMetricsTimeseriesResponse,
	GetProductivityMetricsResponse,
} from "./types.js"

interface ApiClientConfig {
	apiKey: string
	baseUrl?: string
}

export class CastAiStatsApi {
	private apiKey: string
	private baseUrl: string

	constructor(config: ApiClientConfig) {
		this.apiKey = config.apiKey
		this.baseUrl = config.baseUrl ?? resolveEndpoints().castApiUrl
	}

	/**
	 * Make an authenticated API request to Cast AI
	 */
	private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
		const url = `${this.baseUrl}${path}`
		const headers = new Headers(options.headers)
		headers.set("Authorization", `Bearer ${this.apiKey}`)
		headers.set("Content-Type", "application/json")
		headers.set("Accept", "application/json")

		const response = await fetchWithRetry(url, { ...options, headers }, { timeoutMs: 10_000, retry: { maxRetries: 3 } })

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error")
			throw new Error(`Kimchi API error (${response.status}): ${errorText}`)
		}

		return response.json() as Promise<T>
	}

	/**
	 * Generates analytics data for the organization.
	 * Endpoint: GET /ai-optimizer/v1beta/analytics
	 *
	 * Passes inferUserFromApiKey=true so the user is inferred from the API key.
	 */
	async generateAnalytics(startTime: Date, endTime: Date): Promise<GenerateAnalyticsResponse> {
		const params = new URLSearchParams({
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			inferUserFromApiKey: "true",
		})

		return this.request<GenerateAnalyticsResponse>(`/ai-optimizer/v1beta/analytics?${params.toString()}`)
	}

	/**
	 * Breaks the organization's billed cost down by one dimension, most expensive first. The filter is a CEL
	 * expression, for example `castai_api_key_owner_id == "<user ID>"`.
	 * Endpoint: GET /ai-optimizer/v1beta/organizations/{organizationId}:generateBreakdown
	 */
	async generateBreakdown(
		organizationId: string,
		dimension: BreakdownDimension,
		startTime: Date,
		endTime: Date,
		filter: string,
	): Promise<GenerateBreakdownResponse> {
		const params = new URLSearchParams({
			dimension,
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
			filter,
			pageSize: "1000",
		})
		return this.request<GenerateBreakdownResponse>(
			`/ai-optimizer/v1beta/organizations/${encodeURIComponent(organizationId)}:generateBreakdown?${params.toString()}`,
		)
	}

	/**
	 * Gets aggregated productivity metrics.
	 * Endpoint: GET /ai-optimizer/v1beta/productivity-metrics
	 *
	 * Passes inferUserFromApiKey=true so the user is inferred from the API key.
	 */
	async getProductivityMetrics(
		startTime: Date,
		endTime: Date,
		options: {
			metricNames?: string[]
			sessionId?: string
			providerName?: string
		} = {},
	): Promise<GetProductivityMetricsResponse> {
		const params = new URLSearchParams({
			from: startTime.toISOString(),
			to: endTime.toISOString(),
			inferUserFromApiKey: "true",
		})

		if (options.providerName) {
			params.set("provider_name", options.providerName)
		}

		if (options.metricNames?.length) {
			for (const name of options.metricNames) {
				params.append("metric_names", name)
			}
		}

		if (options.sessionId) {
			params.set("session_id", options.sessionId)
		}

		return this.request<GetProductivityMetricsResponse>(
			`/ai-optimizer/v1beta/productivity-metrics?${params.toString()}`,
		)
	}

	/**
	 * Generates productivity metrics as time series data points.
	 * Endpoint: GET /ai-optimizer/v1beta/productivity-metrics:generateTimeseries
	 *
	 * Passes inferUserFromApiKey=true so the user is inferred from the API key.
	 */
	async generateProductivityMetricsTimeseries(
		startTime: Date,
		endTime: Date,
		options: {
			metricNames?: string[]
			sessionId?: string
			providerName?: string
		} = {},
	): Promise<GenerateProductivityMetricsTimeseriesResponse> {
		const params = new URLSearchParams({
			from: startTime.toISOString(),
			to: endTime.toISOString(),
			inferUserFromApiKey: "true",
		})

		if (options.metricNames?.length) {
			for (const name of options.metricNames) {
				params.append("metric_names", name)
			}
		}

		if (options.sessionId) {
			params.set("session_id", options.sessionId)
		}

		return this.request<GenerateProductivityMetricsTimeseriesResponse>(
			`/ai-optimizer/v1beta/productivity-metrics:generateTimeseries?${params.toString()}`,
		)
	}
}

/**
 * Create a stats API client with the given API key
 */
export function createStatsClient(config: ApiClientConfig): CastAiStatsApi {
	return new CastAiStatsApi(config)
}

/**
 * Get default time range for stats queries (last 30 days)
 */
export function getDefaultTimeRange(): { startTime: Date; endTime: Date } {
	const endTime = new Date()
	const startTime = new Date()
	startTime.setDate(startTime.getDate() - 30)
	return { startTime, endTime }
}

/**
 * Get time range for stats queries (last N days)
 */
export function getTimeRange(days: number): { startTime: Date; endTime: Date } {
	const endTime = new Date()
	const startTime = new Date()
	startTime.setDate(startTime.getDate() - days)
	return { startTime, endTime }
}
