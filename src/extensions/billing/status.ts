import { isDeepStrictEqual } from "node:util"
import { loadConfig } from "../../config.js"

export type BillingPlan = "community" | "coder" | "teams" | "enterprise"
export type BillingCreditStatus = "ok" | "low" | "exhausted"

export interface BillingStatus {
	serverless?: boolean
	plan?: BillingPlan
	isPaidTier?: boolean
	remainingCredits?: number
	creditStatus?: BillingCreditStatus
	restrictedMode?: boolean
	budget?: BudgetSnapshot
	updatedAt: string
}

export interface BillingWarning {
	kind: "low" | "exhausted"
	message: string
}

export interface BillingStatusLine {
	amount?: string
	budget?: string
}

export interface BudgetSnapshot {
	period: BudgetPeriod
	budgets: BudgetEntry[]
}

export interface BudgetPeriod {
	startTime: string
	endTime: string
}

export interface BudgetEntry {
	scope: "API_KEY" | "USER" | "TEAM_PER_USER" | "TEAM_POOLED" | "ORGANIZATION_SOFT" | "ORGANIZATION_HARD"
	scopeId: string
	budgetType?: string
	budgetLimitUsd: string
	totalSpendUsd: string
	providerBudgets: BudgetProvider[]
}

export interface BudgetProvider {
	provider: string
	limitType: string
	budgetLimitUsd: string
	usageUsd: string
}

export type BudgetStatus = "OK" | "WARNING" | "EXHAUSTED"

interface BillingApiConfig {
	apiKey: string
	creditsUrl: string
	budgetUrl: string
}

interface RefreshBillingStatusOptions {
	fetch?: typeof fetch
	jsonTimeoutMs?: number
	loadConfig?: typeof loadConfig
	requestTimeoutMs?: number
}

export const LOW_CREDITS_THRESHOLD_USD = 5
export const COMMUNITY_TIER_HEADER_NOTICE =
	"You are using Community tier. For faster performance, upgrade to Coder at https://app.kimchi.dev/pricing"
export const BILLING_EXHAUSTED_MESSAGE = "You ran out of credits. Top up at https://app.kimchi.dev/billing"
const BILLING_REFRESH_TIMEOUT_MS = 5000

const TIER_FIELDS = ["tier", "tier_name", "tierName"] as const
const IS_PAID_TIER_FIELDS = ["is_paid_tier", "isPaidTier"] as const
const BILLING_STATUS_FIELDS = ["billing_status", "billingStatus"] as const
const HAS_CREDITS_FIELDS = ["has_credits", "hasCredits"] as const

let currentBillingStatus: BillingStatus | undefined
let creditsApiConfig: BillingApiConfig | undefined
let creditsApiGeneration = 0
let latestBillingRefreshId = 0
let latestBudgetRefreshId = 0
const listeners = new Set<(status: BillingStatus | undefined) => void>()

export function getBillingStatus(): BillingStatus | undefined {
	return currentBillingStatus
}

export function setBillingStatusForTest(status: BillingStatus | undefined): void {
	currentBillingStatus = status
	notifyListeners()
}

export function clearBillingStatus(): void {
	if (!currentBillingStatus) return
	currentBillingStatus = undefined
	notifyListeners()
}

export function subscribeBillingStatus(listener: (status: BillingStatus | undefined) => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function configureBillingCreditsApi(options: { apiKey?: string; llmEndpoint?: string }): void {
	const apiKey = options.apiKey?.trim()
	const llmEndpoint = options.llmEndpoint?.trim()
	const next =
		apiKey && llmEndpoint
			? {
					apiKey,
					creditsUrl: creditsEndpointFromLlmEndpoint(llmEndpoint),
					budgetUrl: budgetEndpointFromLlmEndpoint(llmEndpoint),
				}
			: undefined
	const changed =
		creditsApiConfig?.apiKey !== next?.apiKey ||
		creditsApiConfig?.creditsUrl !== next?.creditsUrl ||
		creditsApiConfig?.budgetUrl !== next?.budgetUrl
	creditsApiConfig = next
	if (changed) {
		creditsApiGeneration++
		latestBillingRefreshId++
		latestBudgetRefreshId++
		clearBillingStatus()
	}
}

export function creditsEndpointFromLlmEndpoint(llmEndpoint: string): string {
	return billingEndpointFromLlmEndpoint(llmEndpoint, "credits")
}

export function budgetEndpointFromLlmEndpoint(llmEndpoint: string): string {
	return billingEndpointFromLlmEndpoint(llmEndpoint, "budget")
}

function billingEndpointFromLlmEndpoint(llmEndpoint: string, resource: "credits" | "budget"): string {
	const trimmed = llmEndpoint.trim().replace(/\/+$/, "")
	const proxyRoot = trimmed.replace(/\/openai\/v1$/i, "")
	return `${proxyRoot}/v1/${resource}`
}

export async function refreshBillingStatus(
	options: RefreshBillingStatusOptions = {},
): Promise<BillingStatus | undefined> {
	const config = creditsApiConfig
	const generation = creditsApiGeneration
	if (!config) return undefined
	const refreshId = ++latestBillingRefreshId
	const fetchImpl = options.fetch ?? fetch
	let response: Response
	try {
		response = await fetchImpl(config.creditsUrl, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(options.requestTimeoutMs ?? BILLING_REFRESH_TIMEOUT_MS),
		})
	} catch {
		return undefined
	}
	if (!response.ok) return undefined

	let payload: unknown
	try {
		payload = await readResponseJson(response, options.jsonTimeoutMs ?? BILLING_REFRESH_TIMEOUT_MS)
	} catch {
		return undefined
	}
	if (
		refreshId !== latestBillingRefreshId ||
		generation !== creditsApiGeneration ||
		creditsApiConfig?.apiKey !== config.apiKey ||
		creditsApiConfig?.creditsUrl !== config.creditsUrl
	) {
		return undefined
	}
	return observeCreditsPayload(payload)
}

export async function refreshBudgetStatus(
	options: RefreshBillingStatusOptions = {},
): Promise<BudgetSnapshot | undefined> {
	const config = creditsApiConfig
	const generation = creditsApiGeneration
	if (!config) return undefined
	const refreshId = ++latestBudgetRefreshId
	const fetchImpl = options.fetch ?? fetch
	let response: Response
	try {
		response = await fetchImpl(config.budgetUrl, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(options.requestTimeoutMs ?? BILLING_REFRESH_TIMEOUT_MS),
		})
	} catch {
		return undefined
	}
	if (response.status === 404) {
		if (isCurrentBudgetRefresh(refreshId, generation, config)) clearBudgetSnapshot()
		return undefined
	}
	if (!response.ok) return undefined

	let payload: unknown
	try {
		payload = await readResponseJson(response, options.jsonTimeoutMs ?? BILLING_REFRESH_TIMEOUT_MS)
	} catch {
		return undefined
	}
	if (!isCurrentBudgetRefresh(refreshId, generation, config)) return undefined

	const budget = parseBudgetPayload(payload)
	if (!budget) return undefined
	applyBudgetSnapshot(budget)
	return budget
}

export async function refreshBillingSnapshot(
	options: RefreshBillingStatusOptions = {},
): Promise<BillingStatus | undefined> {
	await Promise.allSettled([refreshBillingStatus(options), refreshBudgetStatus(options)])
	return currentBillingStatus
}

export async function refreshBillingStatusFromConfig(
	options: RefreshBillingStatusOptions = {},
): Promise<BillingStatus | undefined> {
	try {
		const config = (options.loadConfig ?? loadConfig)()
		configureBillingCreditsApi({ apiKey: config.apiKey, llmEndpoint: config.llmEndpoint })
		return await refreshBillingSnapshot(options)
	} catch {
		return undefined
	}
}

export function observeCreditsPayload(payload: unknown): BillingStatus | undefined {
	const update = parseCreditsPayload(payload)
	if (!update) return undefined
	if (update.serverless === false) {
		return replaceBillingStatus({ serverless: false, budget: currentBillingStatus?.budget })
	}
	return applyBillingUpdate(update)
}

export function getCommunityTierHeaderNotice(
	status: BillingStatus | undefined = currentBillingStatus,
): string | undefined {
	return status?.plan === "community" ? COMMUNITY_TIER_HEADER_NOTICE : undefined
}

export function getBillingWarnings(status: BillingStatus | undefined = currentBillingStatus): BillingWarning[] {
	const warnings = [getCreditBillingWarning(status), getBudgetWarning(status)].filter(
		(warning): warning is BillingWarning => warning !== undefined,
	)
	return warnings
}

function getCreditBillingWarning(status: BillingStatus | undefined): BillingWarning | undefined {
	if (!status || !isPaidPlan(status)) return undefined

	if (status.creditStatus === "ok") return undefined

	const exhausted =
		status.creditStatus === "exhausted" ||
		(status.creditStatus === undefined &&
			(status.restrictedMode === true || (typeof status.remainingCredits === "number" && status.remainingCredits <= 0)))
	if (exhausted) {
		return { kind: "exhausted", message: BILLING_EXHAUSTED_MESSAGE }
	}

	const isLow =
		status.creditStatus === "low" ||
		(status.creditStatus === undefined &&
			typeof status.remainingCredits === "number" &&
			status.remainingCredits > 0 &&
			status.remainingCredits < LOW_CREDITS_THRESHOLD_USD)
	if (isLow) {
		const balance =
			typeof status.remainingCredits === "number" ? ` (${formatCreditsAmount(status.remainingCredits)} remaining)` : ""
		return {
			kind: "low",
			message: `Heads up: your credits are running low${balance}. Top up now to avoid slowdowns and rate limits: https://app.kimchi.dev/billing`,
		}
	}

	return undefined
}

export function getBillingStatusLine(
	status: BillingStatus | undefined = currentBillingStatus,
): BillingStatusLine | undefined {
	if (!status) return undefined
	const amount =
		status.serverless === false || typeof status.remainingCredits !== "number"
			? undefined
			: formatCreditsAmount(status.remainingCredits)
	const displayBudget = getDisplayBudget(status.budget)
	const budget = displayBudget
		? `${budgetUsagePercentage(displayBudget).toFixed(2)}% (${formatBudgetSpendAndLimit(displayBudget)})`
		: undefined
	if (!amount && !budget) return undefined
	return { ...(amount ? { amount } : {}), ...(budget ? { budget } : {}) }
}

function parseCreditsPayload(payload: unknown): Partial<BillingStatus> | undefined {
	const body = asRecord(payload)
	const serverless = typeof body.serverless === "boolean" ? body.serverless : undefined
	if (serverless === false) return { serverless }
	const isCreditsSnapshot =
		serverless === true ||
		hasAny(body, TIER_FIELDS) ||
		hasAny(body, IS_PAID_TIER_FIELDS) ||
		hasAny(body, BILLING_STATUS_FIELDS) ||
		hasAny(body, HAS_CREDITS_FIELDS) ||
		"remaining" in body
	if (!isCreditsSnapshot) return undefined

	const plan = parsePlan(readString(body, TIER_FIELDS))
	const isPaidTier = readBoolean(body, IS_PAID_TIER_FIELDS)
	const remainingCredits = parseCreditsAmount(body.remaining)
	const statusFromBilling = parseCreditStatus(readString(body, BILLING_STATUS_FIELDS))
	const hasCredits = readBoolean(body, HAS_CREDITS_FIELDS)
	const creditStatus = statusFromBilling ?? (hasCredits === false ? "exhausted" : undefined)
	const restrictedMode = hasCredits === undefined ? undefined : !hasCredits

	const update: Partial<BillingStatus> = {}
	if (serverless !== undefined) update.serverless = serverless
	if (serverless === true || hasAny(body, TIER_FIELDS)) update.plan = plan
	if (serverless === true || hasAny(body, IS_PAID_TIER_FIELDS)) update.isPaidTier = isPaidTier
	if (serverless === true || hasAny(body, BILLING_STATUS_FIELDS) || hasCredits === false) {
		update.creditStatus = creditStatus
	}
	if (serverless === true || "remaining" in body) update.remainingCredits = remainingCredits
	if (serverless === true || hasAny(body, HAS_CREDITS_FIELDS)) update.restrictedMode = restrictedMode

	return Object.keys(update).length > 0 ? update : undefined
}

function parseBudgetPayload(payload: unknown): BudgetSnapshot | undefined {
	const body = asRecord(payload)
	const period = asRecord(body.period)
	const budgetValues = body.budgets === undefined ? [] : body.budgets
	if (typeof period.startTime !== "string" || typeof period.endTime !== "string" || !Array.isArray(budgetValues)) {
		return undefined
	}

	const budgets: BudgetEntry[] = []
	for (const value of budgetValues) {
		const budget = parseBudgetEntry(value)
		if (!budget) return undefined
		budgets.push(budget)
	}
	return {
		period: { startTime: period.startTime, endTime: period.endTime },
		budgets,
	}
}

function parseBudgetEntry(value: unknown): BudgetEntry | undefined {
	const entry = asRecord(value)
	const providerValues = entry.providerBudgets === undefined ? [] : entry.providerBudgets
	if (
		!isBudgetScope(entry.scope) ||
		typeof entry.scopeId !== "string" ||
		(entry.budgetType !== undefined && typeof entry.budgetType !== "string") ||
		!isUsd(entry.budgetLimitUsd) ||
		!isUsd(entry.totalSpendUsd) ||
		!Array.isArray(providerValues)
	) {
		return undefined
	}

	const providers: BudgetProvider[] = []
	for (const value of providerValues) {
		const provider = parseBudgetProvider(value)
		if (!provider) return undefined
		providers.push(provider)
	}
	return {
		scope: entry.scope,
		scopeId: entry.scopeId,
		...(typeof entry.budgetType === "string" ? { budgetType: entry.budgetType } : {}),
		budgetLimitUsd: entry.budgetLimitUsd,
		totalSpendUsd: entry.totalSpendUsd,
		providerBudgets: providers,
	}
}

function parseBudgetProvider(value: unknown): BudgetProvider | undefined {
	const provider = asRecord(value)
	const rawLimitType = provider.limitType === undefined ? "DISABLED" : provider.limitType
	if (typeof rawLimitType !== "string") return undefined
	const limitType = rawLimitType === "UNSPECIFIED" || rawLimitType.endsWith("_UNSPECIFIED") ? "DISABLED" : rawLimitType
	if (!isSupportedProviderLimitType(limitType)) return undefined
	const budgetLimitUsd =
		provider.budgetLimitUsd === undefined && !isCappedProviderLimitType(limitType) ? "" : provider.budgetLimitUsd
	if (
		typeof provider.provider !== "string" ||
		!isOptionalUsd(budgetLimitUsd) ||
		(isCappedProviderLimitType(limitType) && budgetLimitUsd === "") ||
		!isUsd(provider.usageUsd)
	) {
		return undefined
	}
	return {
		provider: provider.provider,
		limitType,
		budgetLimitUsd,
		usageUsd: provider.usageUsd,
	}
}

export function isCappedProviderLimitType(limitType: string): boolean {
	return limitType === "CAPPED" || limitType.endsWith("_CAPPED")
}

function isSupportedProviderLimitType(limitType: string): boolean {
	return (
		isCappedProviderLimitType(limitType) ||
		limitType === "DISABLED" ||
		limitType.endsWith("_DISABLED") ||
		limitType === "UNLIMITED" ||
		limitType.endsWith("_UNLIMITED")
	)
}

function isBudgetScope(value: unknown): value is BudgetEntry["scope"] {
	return (
		value === "API_KEY" ||
		value === "USER" ||
		value === "TEAM_PER_USER" ||
		value === "TEAM_POOLED" ||
		value === "ORGANIZATION_SOFT" ||
		value === "ORGANIZATION_HARD"
	)
}

function isUsd(value: unknown): value is string {
	return typeof value === "string" && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0
}

function isOptionalUsd(value: unknown): value is string {
	return value === "" || isUsd(value)
}

async function readResponseJson(response: Response, timeoutMs: number): Promise<unknown> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			void response.body?.cancel().catch(() => undefined)
			reject(new Error("Timed out reading billing credits response"))
		}, timeoutMs)
	})
	try {
		return await Promise.race([response.json(), timeoutPromise])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

function parsePlan(value: string | undefined): BillingPlan | undefined {
	if (!value) return undefined
	const normalized = normalizeBillingKey(value)
	if (["community", "free", "free-tier", "free-slow"].includes(normalized)) return "community"
	if (["starter", "coder", "individual"].includes(normalized) || normalized.startsWith("coder-")) return "coder"
	if (normalized === "team" || normalized === "teams" || normalized.startsWith("teams-")) return "teams"
	if (normalized === "enterprise" || normalized.startsWith("enterprise-")) return "enterprise"
	return undefined
}

function parseCreditStatus(value: string | undefined): BillingCreditStatus | undefined {
	if (!value) return undefined
	const normalized = normalizeBillingKey(value).replace(/^billing-status-/, "")
	if (["ok", "active", "healthy", "free-tier"].includes(normalized)) return "ok"
	if (["low", "low-balance", "running-low", "near-empty"].includes(normalized)) return "low"
	if (["exhausted", "depleted", "empty", "out", "out-of-credits", "no-credits"].includes(normalized)) {
		return "exhausted"
	}
	return undefined
}

function normalizeBillingKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-")
}

function parseCreditsAmount(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
	if (typeof value !== "string") return undefined
	const normalized = [...value.toLowerCase()]
		.filter((character) => character.trim() !== "")
		.join("")
		.replaceAll("$", "")
		.replaceAll("usd", "")
		.replace(",", ".")
	const parsed = Number(normalized)
	return normalized !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function getDisplayBudget(
	snapshot: BudgetSnapshot | undefined = currentBillingStatus?.budget,
): BudgetEntry | undefined {
	return snapshot?.budgets
		.filter((budget) => Number(budget.budgetLimitUsd) > 0)
		.reduce<BudgetEntry | undefined>(
			(selected, budget) =>
				!selected || budgetUsagePercentage(budget) > budgetUsagePercentage(selected) ? budget : selected,
			undefined,
		)
}

export function budgetLabel(budget: Pick<BudgetEntry, "scope" | "scopeId" | "budgetType">): string {
	switch (budget.scope) {
		case "API_KEY":
			return "API key"
		case "USER":
			return "Personal"
		case "TEAM_PER_USER":
		case "TEAM_POOLED":
			return `Team ${budget.scopeId.slice(0, 8)}`
		case "ORGANIZATION_SOFT":
			return isPerUserBudgetType(budget.budgetType) ? "Organization per-user soft" : "Organization soft"
		case "ORGANIZATION_HARD":
			return isPerUserBudgetType(budget.budgetType) ? "Organization per-user hard" : "Organization hard"
	}
}

function isPerUserBudgetType(value: string | undefined): boolean {
	return value === "PER_USER" || value?.endsWith("_PER_USER") === true
}

export function budgetUsagePercentage(budget: Pick<BudgetEntry, "budgetLimitUsd" | "totalSpendUsd">): number {
	return usagePercentage(budget.totalSpendUsd, budget.budgetLimitUsd)
}

export function providerBudgetUsagePercentage(budget: Pick<BudgetProvider, "budgetLimitUsd" | "usageUsd">): number {
	return usagePercentage(budget.usageUsd, budget.budgetLimitUsd)
}

export function budgetStatus(budget: BudgetEntry): BudgetStatus {
	const percentage = budgetUsagePercentage(budget)
	if (percentage >= 100) return budget.scope === "ORGANIZATION_SOFT" ? "WARNING" : "EXHAUSTED"
	return percentage >= 90 ? "WARNING" : "OK"
}

function usagePercentage(usageUsd: string, budgetLimitUsd: string): number {
	const usage = Number(usageUsd)
	const limit = Number(budgetLimitUsd)
	return Number.isFinite(usage) && Number.isFinite(limit) && limit > 0 ? (usage / limit) * 100 : 0
}

export function formatBudgetAmount(value: string): string {
	const amount = Number(value)
	if (!Number.isFinite(amount)) return "$0.00"
	if (amount >= 1000) {
		return formatCompactBudgetAmount(amount)
	}
	return `$${amount.toFixed(2)}`
}

export function formatBudgetLimit(value: string): string {
	if (value === "") return "unlimited"
	const amount = Number(value)
	if (!Number.isFinite(amount)) return "$0"
	if (amount === 0) return "unlimited"
	if (amount >= 1000) return formatCompactBudgetAmount(amount)
	return `$${amount.toFixed(Number.isInteger(amount) ? 0 : 2)}`
}

function formatBudgetSpendAndLimit(budget: Pick<BudgetEntry, "budgetLimitUsd" | "totalSpendUsd">): string {
	return `${formatBudgetAmount(budget.totalSpendUsd)}/${formatBudgetLimit(budget.budgetLimitUsd)}`
}

function formatCompactBudgetAmount(amount: number): string {
	const compact = Math.round((amount / 1000) * 10) / 10
	return `$${compact.toFixed(compact % 1 === 0 ? 0 : 1)}k`
}

function getBudgetWarning(status: BillingStatus | undefined): BillingWarning | undefined {
	let selected: BudgetEntry | undefined
	for (const budget of status?.budget?.budgets ?? []) {
		if (!selected) {
			selected = budget
			continue
		}
		const candidateStatus = budgetStatus(budget)
		const selectedStatus = budgetStatus(selected)
		if (
			budgetStatusRank(candidateStatus) > budgetStatusRank(selectedStatus) ||
			(candidateStatus === selectedStatus && budgetUsagePercentage(budget) > budgetUsagePercentage(selected))
		) {
			selected = budget
		}
	}
	if (!selected) return undefined
	const selectedStatus = budgetStatus(selected)
	if (selectedStatus === "WARNING") {
		return {
			kind: "low",
			message: `Budget warning: ${budgetLabel(selected)} budget is ${Math.round(budgetUsagePercentage(selected))}% used (${formatBudgetSpendAndLimit(selected)}).`,
		}
	}
	if (selectedStatus === "EXHAUSTED") {
		return {
			kind: "exhausted",
			message: `Budget exhausted: ${budgetLabel(selected)} budget is fully used (${formatBudgetSpendAndLimit(selected)}).`,
		}
	}
	return undefined
}

function budgetStatusRank(status: BudgetStatus): number {
	return status === "EXHAUSTED" ? 2 : status === "WARNING" ? 1 : 0
}

function isPaidPlan(status: BillingStatus): boolean {
	return status.isPaidTier === true
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function hasAny(record: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.some((key) => key in record)
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "string") return value
	}
	return undefined
}

function readBoolean(record: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
	for (const key of keys) {
		const value = record[key]
		if (typeof value === "boolean") return value
	}
	return undefined
}

function formatCreditsAmount(amount: number): string {
	const rounded = Math.round(amount * 100) / 100
	return `$${rounded.toFixed(2)}`
}

function hasSignificantChange(previous: BillingStatus | undefined, next: BillingStatus): boolean {
	return (
		previous?.serverless !== next.serverless ||
		previous?.plan !== next.plan ||
		previous?.isPaidTier !== next.isPaidTier ||
		previous?.remainingCredits !== next.remainingCredits ||
		previous?.creditStatus !== next.creditStatus ||
		previous?.restrictedMode !== next.restrictedMode ||
		!isDeepStrictEqual(previous?.budget, next.budget)
	)
}

function isCurrentBudgetRefresh(refreshId: number, generation: number, config: BillingApiConfig): boolean {
	return (
		refreshId === latestBudgetRefreshId &&
		generation === creditsApiGeneration &&
		creditsApiConfig?.apiKey === config.apiKey &&
		creditsApiConfig?.budgetUrl === config.budgetUrl
	)
}

function applyBudgetSnapshot(budget: BudgetSnapshot): BillingStatus | undefined {
	return replaceBillingStatus({ ...(currentBillingStatus ?? {}), budget })
}

function clearBudgetSnapshot(): void {
	if (!currentBillingStatus?.budget) return
	const { budget: _budget, ...status } = currentBillingStatus
	replaceBillingStatus(status)
}

function applyBillingUpdate(update: Partial<BillingStatus>): BillingStatus | undefined {
	const next: BillingStatus = {
		...(currentBillingStatus ?? {}),
		...update,
		updatedAt: new Date().toISOString(),
	}
	if (update.remainingCredits !== undefined && update.remainingCredits > 0) {
		if (update.creditStatus === undefined) next.creditStatus = undefined
		if (update.restrictedMode === undefined) next.restrictedMode = undefined
	}
	if (update.creditStatus === "ok" && update.restrictedMode === undefined) next.restrictedMode = undefined
	return replaceBillingStatus(next)
}

function replaceBillingStatus(
	status: Omit<BillingStatus, "updatedAt"> & { updatedAt?: string },
): BillingStatus | undefined {
	const next: BillingStatus = { ...status, updatedAt: status.updatedAt ?? new Date().toISOString() }
	if (!hasSignificantChange(currentBillingStatus, next)) return currentBillingStatus

	currentBillingStatus = next
	notifyListeners()
	return next
}

function notifyListeners(): void {
	for (const listener of listeners) {
		listener(currentBillingStatus)
	}
}
