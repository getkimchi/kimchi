/**
 * TypeScript types matching Cast AI Analytics API responses.
 * Based on actual API responses (protobuf JSON encoding uses camelCase)
 */

// ─── Request Types ────────────────────────────────────────────────────────────

export interface GenerateAnalyticsRequest {
	id: string
	start_time: string
	end_time: string
	castai_api_key?: string
	filter?: string
}

export interface GetProductivityMetricsRequest {
	from: string
	to: string
	metric_names?: string[]
	user_id?: string
	session_id?: string
	provider_name?: string
}

export interface GenerateProductivityMetricsTimeseriesRequest {
	organization_id: string
	from: string
	to: string
	metric_names?: string[]
	user_id?: string
	session_id?: string
	provider_name?: string
}

// ─── Analytics API Types ─────────────────────────────────────────────────────

export interface GenerateAnalyticsResponse {
	comparison?: Comparison
	cost?: Cost
	apiCalls?: ApiCalls
	errors?: Errors
	ttft?: Ttft
	requestDuration?: RequestDuration
	hostedModels?: HostedModels
	tokens?: TokensDetail
	stepDuration: string
	mostRecentTime?: string
}

/**
 * Detailed token metrics with per-model breakdowns including cache tokens.
 * Used when the API returns the new unified tokens structure.
 */
export interface TokensDetail {
	items: TokenDetailItem[]
}

export interface TokenDetailItem {
	executionTime: string
	models: ModelTokenStat[]
}

export interface ModelTokenStat {
	model: string
	provider: string
	castaiApiKey: string
	providerName: string
	inputTokens: number | string
	outputTokens: number | string
	totalTokens: number | string
	cacheReadTokens: number | string
	cacheWriteTokens: number | string
	castaiApiKeyMetadata: CastAiApiKeyMetadata
}

export interface Comparison {
	apiCalls?: ComparisonValue
	errors?: ComparisonValue
	cost?: ComparisonValue
	tokens?: ComparisonValue
}

export interface ComparisonValue {
	currentValue: number
	previousValue: number
	changePercentage: number
}

export interface Cost {
	items: CostItem[]
}

export interface CostItem {
	executionTime: string
	models: ModelCost[]
}

export interface ModelCost {
	model: string
	provider: string
	castaiApiKey: string
	providerName: string
	totalCost: string
	totalCostPerMillionTokens: string
	castaiApiKeyMetadata: CastAiApiKeyMetadata
	inputTokenCost: string
	outputTokenCost: string
}

export interface CastAiApiKeyMetadata {
	id: string
	name: string
	ownerType: string
	ownerId: string
	ownerEmail: string
}

export interface ApiCalls {
	items: ApiCallItem[]
}

export interface ApiCallItem {
	executionTime: string
	models: ModelStatItem[]
}

// Model stats used in apiCalls
export interface ModelStatItem {
	model: string
	provider: string
	castaiApiKey: string
	providerName: string
	totalCount: number | string
	castaiApiKeyMetadata: CastAiApiKeyMetadata
}

export interface Errors {
	items: ErrorItem[]
}

export interface ErrorItem {
	executionTime: string
	value: number
	errorType?: string
	model?: string
}

export interface Ttft {
	items: TtftItem[]
}

export interface TtftItem {
	executionTime: string
	p50: number
	p90: number
	p99: number
}

export interface RequestDuration {
	items: RequestDurationItem[]
}

export interface RequestDurationItem {
	executionTime: string
	p50: number
	p90: number
	p99: number
}

export interface HostedModels {
	items: HostedModelItem[]
}

export interface HostedModelItem {
	model: string
	count: number
}

// ─── Productivity Metrics API Types ───────────────────────────────────────────

export interface GetProductivityMetricsResponse {
	from?: string
	to?: string
	items: ProviderProductivityMetrics[]
}

export interface ProviderProductivityMetrics {
	providerName: string
	summaries: MetricSummary[]
	sessionStats: SessionStats
	comparison: ProductivityComparison
}

export interface MetricSummary {
	metricName: string
	totalValue: number
	breakdown: DimensionValue[]
	groupedBreakdown: GroupedDimensionValue[]
}

export interface DimensionValue {
	dimension: string
	value: string
	count: number
	valueSum: number
}

export interface GroupedDimensionValue {
	dimensions: Record<string, string>
	valueSum: number
}

export interface SessionStats {
	totalSessions: number
	totalDurationSeconds: number
	avgSessionDurationSeconds: number
	medianSessionDurationSeconds: number
	durationP50Seconds: number
	durationP75Seconds: number
	durationP90Seconds: number
	durationP99Seconds: number
}

export interface ProductivityComparison {
	linesOfCode: ProductivityComparisonValue
	pullRequests: ProductivityComparisonValue
	commits: ProductivityComparisonValue
	cost: ProductivityComparisonValue
	tokens: ProductivityComparisonValue
	sessionTimeSeconds: ProductivityComparisonValue
	sessions: ProductivityComparisonValue
	toolUsage: ProductivityComparisonValue
	toolDurationMs: ProductivityComparisonValue
}

export interface ProductivityComparisonValue {
	value: number
	previousIntervalValue: number
	changePercentage: number
}

// ─── Productivity Metrics Timeseries API Types ───────────────────────────────

export interface GenerateProductivityMetricsTimeseriesResponse {
	from?: string
	to?: string
	providers: ProviderTimeSeries[]
}

export interface ProviderTimeSeries {
	providerName: string
	metrics: MetricTimeSeries[]
}

export interface MetricTimeSeries {
	metricName: string
	dataPoints: TimeSeriesDataPoint[]
}

export interface TimeSeriesDataPoint {
	timestamp: string
	value: number
}
