export const FERMENT_TOOLS = {
	REQUEST_WORKFLOW: "request_ferment_workflow",
	PROPOSE_SCOPING: "propose_ferment_scoping",
	LIST: "list_ferments",
	SCOPE: "scope_ferment",
	CONFIRM_COMPLETION_CRITERIA: "confirm_ferment_completion_criteria",
	UPDATE_SCOPE_FIELD: "update_ferment_scope_field",
	COMPLETE: "complete_ferment",
	ACTIVATE_PHASE: "activate_ferment_phase",
	REFINE_PHASE: "refine_ferment_phase",
	COMPLETE_PHASE: "complete_ferment_phase",
	SKIP_PHASE: "skip_ferment_phase",
	FAIL_PHASE: "fail_ferment_phase",
	START_STEP: "start_ferment_step",
	COMPLETE_STEP: "complete_ferment_step",
	VERIFY_STEP: "verify_ferment_step",
	SKIP_STEP: "skip_ferment_step",
	FAIL_STEP: "fail_ferment_step",
	ADD_DECISION: "add_ferment_decision",
	ADD_MEMORY: "add_ferment_memory",
	ASK_USER: "ask_user",
} as const

export const FERMENT_TOOL_NAMES = Object.freeze(Object.values(FERMENT_TOOLS))

const FERMENT_TOOL_NAME_SET = new Set<string>(FERMENT_TOOL_NAMES)
const NON_PLANNER_FERMENT_TOOL_NAMES = new Set<string>([FERMENT_TOOLS.LIST, FERMENT_TOOLS.REQUEST_WORKFLOW])
const PLANNER_ONLY_FERMENT_TOOL_NAMES = new Set<string>([
	FERMENT_TOOLS.PROPOSE_SCOPING,
	FERMENT_TOOLS.SCOPE,
	FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA,
	FERMENT_TOOLS.UPDATE_SCOPE_FIELD,
	FERMENT_TOOLS.COMPLETE,
	FERMENT_TOOLS.ACTIVATE_PHASE,
	FERMENT_TOOLS.REFINE_PHASE,
	FERMENT_TOOLS.COMPLETE_PHASE,
	FERMENT_TOOLS.SKIP_PHASE,
	FERMENT_TOOLS.FAIL_PHASE,
	FERMENT_TOOLS.START_STEP,
	FERMENT_TOOLS.COMPLETE_STEP,
	FERMENT_TOOLS.VERIFY_STEP,
	FERMENT_TOOLS.SKIP_STEP,
	FERMENT_TOOLS.FAIL_STEP,
	FERMENT_TOOLS.ADD_DECISION,
	FERMENT_TOOLS.ADD_MEMORY,
	FERMENT_TOOLS.ASK_USER,
])

// Ferment tools that drive user-facing UI or other side-effects; must NOT bypass user
// permission rules and the classifier. Membership opts a tool back into normal evaluation.
const USER_FACING_FERMENT_TOOL_NAMES = new Set<string>([
	FERMENT_TOOLS.CONFIRM_COMPLETION_CRITERIA,
	FERMENT_TOOLS.ASK_USER,
])

export function isFermentToolName(name: string): boolean {
	return FERMENT_TOOL_NAME_SET.has(name)
}

export function isUserFacingFermentToolName(name: string): boolean {
	return USER_FACING_FERMENT_TOOL_NAMES.has(name)
}

export function isClassifiedFermentToolName(name: string): boolean {
	return PLANNER_ONLY_FERMENT_TOOL_NAMES.has(name) || NON_PLANNER_FERMENT_TOOL_NAMES.has(name)
}

/** Shared message: there is no `create_ferment` tool. Explains the canonical creation/scoping paths. */
export const CREATE_FERMENT_REDIRECT_MESSAGE =
	'Ferment creation is host-owned and only happens through the `/ferment` slash commands. There is no `create_ferment` tool, no equivalent native or MCP tool, and no filesystem layout you can construct by hand. Do not search for, retry with, or invent variants like `new_ferment`, `start_ferment`, `make_ferment`, `begin_ferment`, `ferment_create`, etc.; none exist. Do NOT create directories, write status/manifest files, or run shell commands under `.kimchi/` to simulate a ferment — the host will not recognize them and the FSM will reject them. If a draft ferment is already active, call `propose_ferment_scoping` for draft scoping. Otherwise STOP, do not call any tools, and tell the user to run `/ferment`, `/ferment new "..."` or `/ferment one-shot "..."` themselves. Wait for the host to create the ferment before resuming.'
