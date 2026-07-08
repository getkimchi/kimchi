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
	updatedAt: string
}

export interface BillingWarning {
	kind: "low" | "exhausted"
	message: string
}

export interface BillingStatusLine {
	text: string
	tone: "dim" | "accent"
}

interface BillingCreditsApiConfig {
	apiKey: string
	creditsUrl: string
}

interface RefreshBillingStatusOptions {
	fetch?: typeof fetch
	jsonTimeoutMs?: number
	loadConfig?: typeof loadConfig
	requestTimeoutMs?: number
}

export const LOW_CREDITS_THRESHOLD_EUR = 5
export const COMMUNITY_TIER_HEADER_NOTICE =
	"You are using Community tier. For faster performance, upgrade to Coder at app.kimchi.dev/pricing"
export const BILLING_EXHAUSTED_MESSAGE = "You ran out of credits. Top up at app.kimchi.dev/billing"
const BILLING_REFRESH_TIMEOUT_MS = 5000

const TIER_FIELDS = ["tier", "tier_name", "tierName"] as const
const IS_PAID_TIER_FIELDS = ["is_paid_tier", "isPaidTier"] as const
const BILLING_STATUS_FIELDS = ["billing_status", "billingStatus"] as const
const HAS_CREDITS_FIELDS = ["has_credits", "hasCredits"] as const
const PLAN_DISPLAY_NAMES: Partial<Record<BillingPlan, string>> = {
	community: "Community",
	coder: "Coder",
	teams: "Teams",
	enterprise: "Enterprise",
}

let currentBillingStatus: BillingStatus | undefined
let creditsApiConfig: BillingCreditsApiConfig | undefined
let creditsApiGeneration = 0
let latestBillingRefreshId = 0
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
	const next = apiKey && llmEndpoint ? { apiKey, creditsUrl: creditsEndpointFromLlmEndpoint(llmEndpoint) } : undefined
	const changed = creditsApiConfig?.apiKey !== next?.apiKey || creditsApiConfig?.creditsUrl !== next?.creditsUrl
	creditsApiConfig = next
	if (changed) {
		creditsApiGeneration++
		latestBillingRefreshId++
		clearBillingStatus()
	}
}

export function creditsEndpointFromLlmEndpoint(llmEndpoint: string): string {
	const trimmed = llmEndpoint.trim().replace(/\/+$/, "")
	const proxyRoot = trimmed.replace(/\/openai\/v1$/i, "")
	return `${proxyRoot}/v1/credits`
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

export async function refreshBillingStatusFromConfig(
	options: RefreshBillingStatusOptions = {},
): Promise<BillingStatus | undefined> {
	try {
		const config = (options.loadConfig ?? loadConfig)()
		configureBillingCreditsApi({ apiKey: config.apiKey, llmEndpoint: config.llmEndpoint })
		return await refreshBillingStatus(options)
	} catch {
		return undefined
	}
}

export function observeCreditsPayload(payload: unknown): BillingStatus | undefined {
	const update = parseCreditsPayload(payload)
	if (!update) return undefined
	if (update.serverless === false) {
		return replaceBillingStatus({ serverless: false })
	}
	return applyBillingUpdate(update)
}

export function getCommunityTierHeaderNotice(
	status: BillingStatus | undefined = currentBillingStatus,
): string | undefined {
	return status?.plan === "community" ? COMMUNITY_TIER_HEADER_NOTICE : undefined
}

export function getBillingWarning(
	status: BillingStatus | undefined = currentBillingStatus,
): BillingWarning | undefined {
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
			status.remainingCredits < LOW_CREDITS_THRESHOLD_EUR)
	if (isLow) {
		const balance =
			typeof status.remainingCredits === "number" ? ` (${formatCreditsAmount(status.remainingCredits)} remaining)` : ""
		return {
			kind: "low",
			message: `Heads up: your credits are running low${balance}. Top up now to avoid slowdowns and rate limits: app.kimchi.dev/billing`,
		}
	}

	return undefined
}

export function getBillingStatusLine(
	status: BillingStatus | undefined = currentBillingStatus,
): BillingStatusLine | undefined {
	if (!status || status.serverless === false) return undefined

	const label = planDisplayName(status.plan) ?? "Credits"
	const suffix = typeof status.remainingCredits === "number" ? `: ${formatCreditsAmount(status.remainingCredits)}` : ""
	const tone = status.plan === "community" ? "dim" : "accent"
	return { text: `${label}${suffix}`, tone }
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
	const normalized = value.replace(/[€$]/g, "").replace(/eur/gi, "").replace(/\s+/g, "").replace(",", ".")
	const match = normalized.match(/^-?\d+(?:\.\d+)?/)
	if (!match) return undefined
	const parsed = Number(match[0])
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
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
	const value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "")
	return `€${value}`
}

function planDisplayName(plan: BillingPlan | undefined): string | undefined {
	return plan ? PLAN_DISPLAY_NAMES[plan] : undefined
}

function hasSignificantChange(previous: BillingStatus | undefined, next: BillingStatus): boolean {
	return (
		previous?.serverless !== next.serverless ||
		previous?.plan !== next.plan ||
		previous?.isPaidTier !== next.isPaidTier ||
		previous?.remainingCredits !== next.remainingCredits ||
		previous?.creditStatus !== next.creditStatus ||
		previous?.restrictedMode !== next.restrictedMode
	)
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
