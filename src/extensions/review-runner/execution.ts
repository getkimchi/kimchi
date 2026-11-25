import { AsyncLocalStorage } from "node:async_hooks"
import type {
	AgentToolResult,
	BashOperations,
	BashToolInput,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent"
import { createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { isInSandboxCluster } from "../../utils/sandbox.js"
import { isDirectInstallCommand } from "./install-command.js"
import { detectReviewNetworkBoundary, offlineEnvironment, type ReviewNetworkBoundary } from "./network-boundary.js"
import type { ReviewWorktree } from "./types.js"

export const REVIEW_CHECK_TOOL = "run_review_check"
export const REVIEW_COMMAND_TOOL = "run_review_command"
export const REVIEW_COMMAND_OUTPUT_LIMIT = 32 * 1024

export type ReviewExecutionMode = "local" | "headless"
export type ReviewApprovalKind = "direct-install" | "online-rerun" | "offline-unavailable"
export type ReviewApprovalStatus = "approved" | "declined" | "unavailable" | "aborted"
export type ReviewCommandStatus = "passed" | "failed" | "blocked" | "cancelled"
export type ReviewNetworkMode = "offline" | "approved-online" | "sandbox" | "unenforced"

export interface ReviewApprovalRequest {
	kind: ReviewApprovalKind
	command: string
	intendedCheck: string
	worktrees: string[]
	toolCallId?: string
	toolName?: string
	input?: Record<string, unknown>
}

export interface ReviewApprovalGrant {
	toolCallId: string
	toolName: string
	command: string
	approvalKind: ReviewApprovalKind
}

export interface ReviewApprovalPresentation {
	command: string
	intended_check: string
	worktrees: string[]
	network: "online"
	reason: ReviewApprovalKind
}

export interface ReviewExecutionEvent {
	event?: ToolCallEvent
	ctx?: ExtensionContext
	mode: string
	signal?: AbortSignal
}

export type ReviewApprover = (
	request: ReviewApprovalRequest,
	execution: ReviewExecutionEvent,
) => Promise<ReviewApprovalStatus>
export type ReviewAuthorizationResult = { block: true; reason: string; deferToReviewApproval?: boolean } | undefined
export type ReviewCommandAuthorizer = (
	command: string,
	execution: ReviewExecutionEvent,
) => Promise<ReviewAuthorizationResult>

/** The narrow seam consumed by permissions/index.ts. No reviewer code imports
 * the parent-surface registry or creates a prompt of its own. */
export interface ReviewPermissionPolicy {
	preApproved(toolName: string): boolean
	approvalFor(toolName: string, input: Record<string, unknown>): ReviewApprovalRequest | undefined
	bindApprover(approver: ReviewApprover): void
	requestApproval(request: ReviewApprovalRequest, execution: ReviewExecutionEvent): Promise<ReviewApprovalStatus>
	bindCommandAuthorizer(authorizer: ReviewCommandAuthorizer): void
	authorizeCommand(command: string, execution: ReviewExecutionEvent): Promise<ReviewAuthorizationResult>
	captureExecution(event: ToolCallEvent, ctx: ExtensionContext, mode: string): void
	executionFor(toolCallId?: string): ReviewExecutionEvent | undefined
	settleBashApproval(toolCallId: string, status: ReviewApprovalStatus, request?: ReviewApprovalRequest): void
	consumeApprovalGrant(grant: ReviewApprovalGrant): ReviewApprovalGrant | undefined
	clearApprovalGrant(toolCallId?: string): void
}

export interface ReviewCommandRequest {
	command: string
	cwd: string
	intendedCheck: string
	worktree: ReviewWorktree
	online?: boolean
	signal?: AbortSignal
	toolCallId?: string
	/** Actual tool identity used for approval-grant matching; defaults to bash. */
	toolName?: string
	/** Internal queue evidence path: the requester was already authorized before reuse. */
	authorizationAlreadyChecked?: boolean
	/** A standalone hard block deferred by the precheck; only approval can settle it. */
	deferredHardBlockReason?: string
}

export interface ReviewCommandRecord {
	command: string
	cwd: string
	intendedCheck: string
	worktree: string
	status: ReviewCommandStatus
	exitCode?: number | null
	elapsedMs: number
	output: string
	network: ReviewNetworkMode
	networkBoundary?: ReviewNetworkBoundary["kind"]
	approval: "not-requested" | ReviewApprovalStatus
}

export interface ReviewExecutionController extends ReviewPermissionPolicy {
	readonly mode: ReviewExecutionMode
	readonly worktree: ReviewWorktree
	readonly records: readonly ReviewCommandRecord[]
	environment(base: NodeJS.ProcessEnv, toolCallId?: string): NodeJS.ProcessEnv
	commandForExecution(command: string, toolCallId?: string): string
	networkFor(toolCallId?: string): ReviewNetworkMode
	networkBoundaryFor(toolCallId?: string): ReviewNetworkBoundary | undefined
	resolveNetworkBoundary(): Promise<ReviewNetworkBoundary | undefined>
	markOfflineBoundary(toolCallId: string | undefined, boundary: ReviewNetworkBoundary): void
	execute(request: Omit<ReviewCommandRequest, "worktree">): Promise<ReviewCommandRecord>
	record(record: ReviewCommandRecord): void
}

export interface ReviewExecutionPolicyOptions {
	mode?: ReviewExecutionMode
	/** Force a boundary for tests, or null to reproduce an unavailable platform. */
	networkBoundary?: ReviewNetworkBoundary | null
	commandAuthorizer?: ReviewCommandAuthorizer
}

export interface ReviewExecutionControllerOptions extends ReviewExecutionPolicyOptions {
	mode: ReviewExecutionMode
	worktree: ReviewWorktree
	operations?: BashOperations
	outputLimit?: number
}

/** Print/ACP output mode is not a sandbox. Only the established sandbox-cluster
 * sentinel selects headless behavior unless a coordinator explicitly injects it. */
export function reviewExecutionMode(explicit?: ReviewExecutionMode): ReviewExecutionMode {
	return explicit ?? (isInSandboxCluster() ? "headless" : "local")
}

export function reviewApprovalPresentation(request: ReviewApprovalRequest): ReviewApprovalPresentation {
	return {
		command: request.command,
		intended_check: request.intendedCheck,
		worktrees: request.worktrees,
		network: "online",
		reason: request.kind,
	}
}

class ExecutionController implements ReviewExecutionController {
	private approver?: ReviewApprover
	private commandAuthorizer?: ReviewCommandAuthorizer
	private readonly pendingApprovalGrants = new Map<string, ReviewApprovalGrant>()
	private readonly consumedApprovalGrants = new Map<string, ReviewApprovalGrant>()
	private readonly offlineToolCalls = new Map<string, ReviewNetworkBoundary>()
	private readonly executions = new Map<string, ReviewExecutionEvent>()
	private readonly commandRecords: ReviewCommandRecord[] = []

	constructor(private readonly options: ReviewExecutionControllerOptions) {
		this.commandAuthorizer = options.commandAuthorizer
	}

	get mode(): ReviewExecutionMode {
		return this.options.mode
	}

	get worktree(): ReviewWorktree {
		return this.options.worktree
	}

	get records(): readonly ReviewCommandRecord[] {
		return this.commandRecords
	}

	preApproved(toolName: string): boolean {
		return toolName === REVIEW_CHECK_TOOL || toolName === REVIEW_COMMAND_TOOL
	}

	approvalFor(toolName: string, input: Record<string, unknown>): ReviewApprovalRequest | undefined {
		if (this.mode === "headless" || toolName !== "bash" || typeof input.command !== "string") return undefined
		if (!isDirectInstallCommand(input.command)) return undefined
		return {
			kind: "direct-install",
			command: input.command,
			intendedCheck: "Explicit package installation requested by the reviewer",
			worktrees: [this.worktree.path],
		}
	}

	bindApprover(approver: ReviewApprover): void {
		if (this.mode === "local") this.approver = approver
	}

	bindCommandAuthorizer(authorizer: ReviewCommandAuthorizer): void {
		this.commandAuthorizer = authorizer
	}

	authorizeCommand = (command: string, execution: ReviewExecutionEvent): Promise<ReviewAuthorizationResult> => {
		return this.commandAuthorizer ? this.commandAuthorizer(command, execution) : Promise.resolve(undefined)
	}

	requestApproval = async (
		request: ReviewApprovalRequest,
		execution: ReviewExecutionEvent,
	): Promise<ReviewApprovalStatus> => {
		if (this.mode === "headless") return "unavailable"
		if (execution.signal?.aborted) return "aborted"
		const approval = this.approver?.(request, execution)
		return approval ? awaitReviewApproval(approval, execution.signal) : "unavailable"
	}

	captureExecution(event: ToolCallEvent, ctx: ExtensionContext, mode: string): void {
		this.executions.set(event.toolCallId, { event, ctx, mode })
		if (this.executions.size > 200) this.executions.delete(this.executions.keys().next().value ?? "")
	}

	executionFor(toolCallId?: string): ReviewExecutionEvent | undefined {
		return toolCallId === undefined ? undefined : this.executions.get(toolCallId)
	}

	settleBashApproval(toolCallId: string, status: ReviewApprovalStatus, request?: ReviewApprovalRequest): void {
		this.clearApprovalGrant(toolCallId)
		if (status === "approved" && request) {
			this.pendingApprovalGrants.set(toolCallId, {
				toolCallId,
				toolName: request.toolName ?? "bash",
				command: request.command,
				approvalKind: request.kind,
			})
		}
		if (status !== "approved" && request) {
			this.record({
				command: request.command,
				cwd: this.worktree.path,
				intendedCheck: request.intendedCheck,
				worktree: this.worktree.path,
				status: status === "aborted" ? "cancelled" : "blocked",
				elapsedMs: 0,
				output: "The online command was not run.",
				network: "unenforced",
				approval: status,
			})
		}
	}

	consumeApprovalGrant(grant: ReviewApprovalGrant): ReviewApprovalGrant | undefined {
		const pending = this.pendingApprovalGrants.get(grant.toolCallId)
		this.pendingApprovalGrants.delete(grant.toolCallId)
		if (
			!pending ||
			pending.toolName !== grant.toolName ||
			pending.command !== grant.command ||
			pending.approvalKind !== grant.approvalKind
		) {
			return undefined
		}
		this.consumedApprovalGrants.set(grant.toolCallId, grant)
		return grant
	}

	clearApprovalGrant(toolCallId?: string): void {
		if (toolCallId === undefined) return
		this.pendingApprovalGrants.delete(toolCallId)
		this.consumedApprovalGrants.delete(toolCallId)
	}

	networkFor(toolCallId?: string): ReviewNetworkMode {
		if (this.mode === "headless") return "sandbox"
		if (
			toolCallId !== undefined &&
			(this.pendingApprovalGrants.has(toolCallId) || this.consumedApprovalGrants.has(toolCallId))
		) {
			return "approved-online"
		}
		if (toolCallId !== undefined && this.offlineToolCalls.has(toolCallId)) return "offline"
		return "unenforced"
	}

	networkBoundaryFor(toolCallId?: string): ReviewNetworkBoundary | undefined {
		return toolCallId === undefined ? undefined : this.offlineToolCalls.get(toolCallId)
	}

	resolveNetworkBoundary = (): Promise<ReviewNetworkBoundary | undefined> => {
		if (this.options.networkBoundary !== undefined) return Promise.resolve(this.options.networkBoundary ?? undefined)
		return detectReviewNetworkBoundary()
	}

	markOfflineBoundary(toolCallId: string | undefined, boundary: ReviewNetworkBoundary): void {
		if (!toolCallId) return
		this.offlineToolCalls.set(toolCallId, boundary)
		if (this.offlineToolCalls.size > 200) this.offlineToolCalls.delete(this.offlineToolCalls.keys().next().value ?? "")
	}

	commandForExecution(command: string, toolCallId?: string): string {
		const boundary = toolCallId === undefined ? undefined : this.offlineToolCalls.get(toolCallId)
		return boundary ? boundary.wrap(command) : command
	}

	environment(base: NodeJS.ProcessEnv, toolCallId?: string): NodeJS.ProcessEnv {
		const withWorktree = { ...base, ...this.worktree.env }
		return this.networkFor(toolCallId) === "offline" ? offlineEnvironment(withWorktree) : withWorktree
	}

	record(record: ReviewCommandRecord): void {
		this.commandRecords.push(record)
		if (this.commandRecords.length > 200) this.commandRecords.shift()
	}

	execute = async (request: Omit<ReviewCommandRequest, "worktree">): Promise<ReviewCommandRecord> => {
		return executeReviewCommand(this, {
			...request,
			worktree: this.worktree,
			operations: this.options.operations,
			outputLimit: this.options.outputLimit,
		})
	}
}

export function createReviewExecutionController(options: ReviewExecutionControllerOptions): ReviewExecutionController {
	return new ExecutionController(options)
}

function boundedAppend(previous: string, chunk: string, limit: number): string {
	const combined = previous + chunk
	return combined.length <= limit ? combined : combined.slice(combined.length - limit)
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

async function awaitReviewApproval(
	approval: Promise<ReviewApprovalStatus>,
	signal: AbortSignal | undefined,
): Promise<ReviewApprovalStatus> {
	if (!signal) return approval
	if (signal.aborted) return "aborted"
	let onAbort: (() => void) | undefined
	const cancelled = new Promise<ReviewApprovalStatus>((resolve) => {
		onAbort = () => resolve("aborted")
		signal.addEventListener("abort", onAbort, { once: true })
	})
	try {
		return await Promise.race([approval, cancelled])
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort)
	}
}

interface Preparation {
	command: string
	environment: NodeJS.ProcessEnv
	network: Exclude<ReviewNetworkMode, "unenforced">
	networkBoundary?: ReviewNetworkBoundary["kind"]
	approval: ReviewCommandRecord["approval"]
}

function blockedRecord(
	controller: ReviewExecutionController,
	request: ReviewCommandRequest,
	startedAt: number,
	output: string,
	approval: ReviewCommandRecord["approval"] = "not-requested",
	status: ReviewCommandStatus = "blocked",
): ReviewCommandRecord {
	const record: ReviewCommandRecord = {
		command: request.command,
		cwd: request.cwd,
		intendedCheck: request.intendedCheck,
		worktree: request.worktree.path,
		status,
		elapsedMs: Date.now() - startedAt,
		output,
		network: "unenforced",
		approval,
	}
	controller.record(record)
	return record
}

function consumeApprovedPreparation(
	controller: ReviewExecutionController,
	request: ReviewCommandRequest,
	approvalKind: ReviewApprovalKind,
	startedAt: number,
): Preparation | ReviewCommandRecord {
	if (!request.toolCallId) {
		return {
			command: request.command,
			environment: { ...process.env, ...request.worktree.env },
			network: "approved-online",
			approval: "approved",
		}
	}
	const approvalRequest: ReviewApprovalRequest = {
		kind: approvalKind,
		command: request.command,
		intendedCheck: request.intendedCheck,
		worktrees: [request.worktree.path],
		toolCallId: request.toolCallId,
		toolName: request.toolName ?? "bash",
	}
	controller.settleBashApproval(request.toolCallId, "approved", approvalRequest)
	const consumed = controller.consumeApprovalGrant({
		toolCallId: request.toolCallId,
		toolName: request.toolName ?? "bash",
		command: request.command,
		approvalKind,
	})
	if (!consumed) {
		return blockedRecord(
			controller,
			request,
			startedAt,
			"The settled approval did not exactly match this execution; the command was not run.",
			"unavailable",
		)
	}
	return {
		command: request.command,
		environment: { ...process.env, ...request.worktree.env },
		network: "approved-online",
		approval: "approved",
	}
}

/** Resolve authorization, approval and actual containment before every local run. */
export async function prepareReviewCommand(
	controller: ReviewExecutionController,
	request: ReviewCommandRequest,
	startedAt = Date.now(),
): Promise<Preparation | ReviewCommandRecord> {
	const execution = controller.executionFor(request.toolCallId) ?? { mode: "library" }
	const approvalExecution: ReviewExecutionEvent = {
		...execution,
		...(request.signal ? { signal: request.signal } : {}),
	}
	let deferredHardBlockReason = request.deferredHardBlockReason
	if (!request.authorizationAlreadyChecked) {
		const denial = await controller.authorizeCommand(request.command, execution)
		if (denial?.deferToReviewApproval) deferredHardBlockReason = denial.reason
		else if (denial) return blockedRecord(controller, request, startedAt, denial.reason)
	}
	if (controller.mode === "headless") {
		if (deferredHardBlockReason) {
			return blockedRecord(controller, request, startedAt, deferredHardBlockReason)
		}
		return {
			command: request.command,
			environment: { ...process.env, ...request.worktree.env },
			network: "sandbox",
			approval: "not-requested",
		}
	}
	const directInstall = isDirectInstallCommand(request.command)
	const needsOnlineApproval = request.online === true || directInstall
	if (needsOnlineApproval && request.toolCallId) {
		const consumed = controller.consumeApprovalGrant({
			toolCallId: request.toolCallId,
			toolName: request.toolName ?? "bash",
			command: request.command,
			approvalKind: directInstall ? "direct-install" : "online-rerun",
		})
		if (consumed) {
			// The worker gate settled this exact identity, command, and approval
			// kind. Consume it once instead of prompting again or replaying it.
			return {
				command: request.command,
				environment: { ...process.env, ...request.worktree.env },
				network: "approved-online",
				approval: "approved",
			}
		}
	}
	if (needsOnlineApproval) {
		const approval = await controller.requestApproval(
			{
				kind: directInstall ? "direct-install" : "online-rerun",
				command: request.command,
				intendedCheck: request.intendedCheck,
				worktrees: [request.worktree.path],
				toolCallId: request.toolCallId,
				toolName: request.toolName ?? "bash",
			},
			approvalExecution,
		)
		if (approval !== "approved") {
			return blockedRecord(
				controller,
				request,
				startedAt,
				approval === "unavailable"
					? "Approval is unavailable locally; the command was not run."
					: "The online request was declined or cancelled; the command was not run.",
				approval,
				approval === "aborted" ? "cancelled" : "blocked",
			)
		}
		if (approval === "approved") {
			return consumeApprovedPreparation(
				controller,
				request,
				directInstall ? "direct-install" : "online-rerun",
				startedAt,
			)
		}
	}
	const boundary = await controller.resolveNetworkBoundary()
	if (!boundary) {
		const approval = await controller.requestApproval(
			{
				kind: "offline-unavailable",
				command: request.command,
				intendedCheck: request.intendedCheck,
				worktrees: [request.worktree.path],
				toolCallId: request.toolCallId,
				toolName: request.toolName ?? "bash",
			},
			approvalExecution,
		)
		if (approval !== "approved") {
			return blockedRecord(
				controller,
				request,
				startedAt,
				"Offline network access cannot be enforced on this platform, so this command requires online approval. The command was not run.",
				approval,
				approval === "aborted" ? "cancelled" : "blocked",
			)
		}
		return consumeApprovedPreparation(controller, request, "offline-unavailable", startedAt)
	}
	if (deferredHardBlockReason) {
		return blockedRecord(controller, request, startedAt, deferredHardBlockReason)
	}
	controller.markOfflineBoundary(request.toolCallId, boundary)
	return {
		command: boundary.wrap(request.command),
		environment: offlineEnvironment({ ...process.env, ...request.worktree.env }),
		network: "offline",
		networkBoundary: boundary.kind,
		approval: "not-requested",
	}
}

export async function executeReviewCommand(
	controller: ReviewExecutionController,
	request: ReviewCommandRequest & { operations?: BashOperations; outputLimit?: number },
): Promise<ReviewCommandRecord> {
	const startedAt = Date.now()
	let output = ""
	const outputLimit = request.outputLimit ?? REVIEW_COMMAND_OUTPUT_LIMIT
	let preparation: Awaited<ReturnType<typeof prepareReviewCommand>> | undefined
	try {
		request.signal?.throwIfAborted()
		preparation = await prepareReviewCommand(controller, request, startedAt)
		if ("status" in preparation) return preparation
		request.signal?.throwIfAborted()
		const operations = request.operations ?? createLocalBashOperations()
		const result = await operations.exec(preparation.command, request.cwd, {
			onData: (data) => {
				output = boundedAppend(output, data.toString("utf8"), outputLimit)
			},
			signal: request.signal,
			env: preparation.environment,
		})
		const status: ReviewCommandStatus = request.signal?.aborted
			? "cancelled"
			: result.exitCode === 0
				? "passed"
				: "failed"
		const record: ReviewCommandRecord = {
			command: request.command,
			cwd: request.cwd,
			intendedCheck: request.intendedCheck,
			worktree: request.worktree.path,
			status,
			exitCode: result.exitCode,
			elapsedMs: Date.now() - startedAt,
			output,
			network: preparation.network,
			...(preparation.networkBoundary ? { networkBoundary: preparation.networkBoundary } : {}),
			approval: preparation.approval,
		}
		controller.record(record)
		return record
	} catch (error) {
		// Preparation throws before its optional result is assigned must retain
		// their original rejection while finally still clears the settled grant.
		if (preparation === undefined) throw error
		const cancelled = request.signal?.aborted === true || errorText(error) === "aborted"
		output = boundedAppend(output, errorText(error), outputLimit)
		const record: ReviewCommandRecord = {
			command: request.command,
			cwd: request.cwd,
			intendedCheck: request.intendedCheck,
			worktree: request.worktree.path,
			status: cancelled ? "cancelled" : "failed",
			elapsedMs: Date.now() - startedAt,
			output,
			network: preparation.network,
			...(preparation.networkBoundary ? { networkBoundary: preparation.networkBoundary } : {}),
			approval: preparation.approval,
		}
		controller.record(record)
		return record
	} finally {
		controller.clearApprovalGrant(request.toolCallId)
	}
}

/** Adapt Pi's bash tool, retaining its process group, cancellation and output
 * behavior while enforcing the local offline boundary and private environment. */
export function createReviewBashToolDefinition(
	controller: ReviewExecutionController,
	cwd = controller.worktree.path,
): ReturnType<typeof createBashToolDefinition> {
	const activeCall = new AsyncLocalStorage<string>()
	const base = createBashToolDefinition(cwd, {
		spawnHook: (context) => {
			const toolCallId = activeCall.getStore()
			return {
				...context,
				command: controller.commandForExecution(context.command, toolCallId),
				env: controller.environment(context.env, toolCallId),
			}
		},
	})
	return {
		...base,
		execute: async (toolCallId, input: BashToolInput, signal, onUpdate, ctx) => {
			const startedAt = Date.now()
			const commandCwd = ctx?.cwd ?? cwd
			try {
				signal?.throwIfAborted()
				const request: ReviewCommandRequest = {
					command: input.command,
					cwd: commandCwd,
					intendedCheck: "Reviewer bash command",
					worktree: controller.worktree,
					toolCallId,
					authorizationAlreadyChecked: true,
					...(signal ? { signal } : {}),
				}
				const preparation = await prepareReviewCommand(controller, request, startedAt)
				const record = (
					status: ReviewCommandStatus,
					output: string,
					exitCode?: number | null,
				): ReviewCommandRecord => ({
					command: input.command,
					cwd: commandCwd,
					intendedCheck: "Reviewer bash command",
					worktree: controller.worktree.path,
					status,
					...(exitCode !== undefined ? { exitCode } : {}),
					elapsedMs: Date.now() - startedAt,
					output: output.slice(-REVIEW_COMMAND_OUTPUT_LIMIT),
					network: "status" in preparation ? "unenforced" : preparation.network,
					...("status" in preparation || !preparation.networkBoundary
						? {}
						: { networkBoundary: preparation.networkBoundary }),
					approval:
						"status" in preparation
							? preparation.approval
							: preparation.network === "approved-online"
								? "approved"
								: "not-requested",
				})
				if ("status" in preparation) {
					return {
						content: [{ type: "text", text: JSON.stringify(preparation) }],
						details: undefined,
						isError: true,
					}
				}
				try {
					const result = await activeCall.run(toolCallId, () => base.execute(toolCallId, input, signal, onUpdate, ctx))
					const exitCode =
						result.structuredContent &&
						typeof result.structuredContent === "object" &&
						"exit_code" in result.structuredContent &&
						typeof result.structuredContent.exit_code === "number"
							? result.structuredContent.exit_code
							: undefined
					controller.record(
						record(
							signal?.aborted ? "cancelled" : result.isError ? "failed" : "passed",
							result.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n"),
							exitCode,
						),
					)
					return result
				} catch (error) {
					controller.record(record(signal?.aborted ? "cancelled" : "failed", errorText(error)))
					throw error
				}
			} finally {
				controller.clearApprovalGrant(toolCallId)
			}
		},
	}
}

export function commandToolResult(record: ReviewCommandRecord): AgentToolResult<ReviewCommandRecord> {
	return {
		content: [{ type: "text", text: JSON.stringify(record) }],
		details: record,
		isError: record.status !== "passed",
	}
}

export { isDirectInstallCommand } from "./install-command.js"
export { offlineEnvironment } from "./network-boundary.js"
