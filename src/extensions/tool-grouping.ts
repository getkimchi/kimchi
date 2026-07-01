import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { Container, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { formatToolTimer } from "./tool-rendering.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = "file" | "pattern" | "directory" | "command" | "operation"

// ---------------------------------------------------------------------------
// classifyTool
// ---------------------------------------------------------------------------

const BASH_DIRECTORY_CMDS = new Set(["ls", "fd", "find"])
const BASH_PATTERN_CMDS = new Set(["grep", "rg"])
const BASH_FILE_CMDS = new Set(["cat", "head", "tail", "read"])

export function classifyTool(toolName: string, args: Record<string, unknown>): Category {
	switch (toolName) {
		case "read":
			return "file"
		case "grep":
		case "find":
			return "pattern"
		case "ls":
			return "directory"
		case "write":
		case "edit":
		case "multiedit":
			return "operation"
		case "bash": {
			const command = typeof args.command === "string" ? args.command.trim() : ""
			const words = command.split(/\s+/)
			const firstWord = words[0] ?? ""
			// rtk wraps known tools: "rtk grep ...", "rtk read ..." — classify by the wrapped tool
			const effectiveWord = firstWord === "rtk" ? (words[1] ?? "") : firstWord
			if (BASH_DIRECTORY_CMDS.has(effectiveWord)) return "directory"
			if (BASH_PATTERN_CMDS.has(effectiveWord)) return "pattern"
			if (BASH_FILE_CMDS.has(effectiveWord)) return "file"
			return "command"
		}
		default:
			return "operation"
	}
}

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

const PAST: Record<Category, (n: number) => string> = {
	file: (n) => `read ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searched for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listed ${n} ${n === 1 ? "directory" : "directories"}`,
	command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

const CONTINUOUS: Record<Category, (n: number) => string> = {
	file: (n) => `reading ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searching for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listing ${n} ${n === 1 ? "directory" : "directories"}`,
	command: (n) => `running ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

export function formatSummary(counts: Map<Category, number>, isInProgress: boolean): string {
	const table = isInProgress ? CONTINUOUS : PAST
	return Array.from(counts.entries())
		.filter(([, n]) => n > 0)
		.map(([cat, n]) => table[cat](n))
		.join(", ")
}

// ---------------------------------------------------------------------------
// Parent tracking via WeakMap
// ---------------------------------------------------------------------------

const ADDCHILD_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-addchild")
const parentMap = new WeakMap<object, Container>()

export function getParent(component: object): Container | undefined {
	return parentMap.get(component)
}

export function patchAddChild(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = Container.prototype as any
	if (proto[ADDCHILD_PATCH_FLAG]) return
	const original = proto.addChild
	proto.addChild = function patchedAddChild(component: object) {
		parentMap.set(component, this)
		return original.call(this, component)
	}
	proto[ADDCHILD_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// findToolGroup
// ---------------------------------------------------------------------------

function isToolLike(
	v: unknown,
): v is { toolName: string; toolCallId: string; isPartial: boolean; args: Record<string, unknown> } {
	if (!v || typeof v !== "object") return false
	const c = v as Record<string, unknown>
	return typeof c.toolName === "string" && typeof c.toolCallId === "string"
}

function isFailedTool(v: unknown): boolean {
	if (!isToolLike(v)) return false
	// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on unknown object
	const c = v as any
	return c.result?.isError === true
}

function isUngroupableTool(v: unknown): boolean {
	if (!isToolLike(v)) return false
	return classifyTool(v.toolName, v.args) === "operation"
}

function breaksRun(child: unknown): boolean {
	return !isToolLike(child) || isFailedTool(child) || isUngroupableTool(child)
}

export function findToolGroup(self: object, children: object[]): object[] {
	const selfIdx = children.indexOf(self)

	if (selfIdx === -1) {
		return breaksRun(self) ? [] : [self]
	}

	// Walk backward to find start of run
	let start = selfIdx
	for (let i = selfIdx - 1; i >= 0; i--) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		start = i
	}

	// Walk forward to find end of run
	let end = selfIdx
	for (let i = selfIdx + 1; i < children.length; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) break
		end = i
	}

	// Collect tools in [start..end], excluding Spacers and run-breakers
	const tools: object[] = []
	for (let i = start; i <= end; i++) {
		const child = children[i]
		if (child instanceof Spacer) continue
		if (breaksRun(child)) continue
		tools.push(child)
	}

	return tools
}

// ---------------------------------------------------------------------------
// buildGroupSummaryText
// ---------------------------------------------------------------------------

export function buildGroupSummaryText(run: object[], isInProgress: boolean): string {
	// Hybrid segments: describable tools (describeTool returns a string) become
	// individual segments; the rest are aggregated by category with counts. To
	// preserve chronological order, any pending count-based aggregate is flushed
	// (emitted) BEFORE a describable segment is appended. Segments are joined
	// with ", " in order of first appearance.
	const segments: string[] = []
	const order: Category[] = []
	const counts = new Map<Category, number>()

	const flush = () => {
		if (counts.size === 0) return
		const orderedCounts = new Map(order.map((cat) => [cat, counts.get(cat) ?? 0]))
		segments.push(formatSummary(orderedCounts, isInProgress))
		order.length = 0
		counts.clear()
	}

	for (const tool of run) {
		if (!isToolLike(tool)) continue
		const desc = describeTool(tool)
		if (desc !== undefined) {
			flush()
			segments.push(desc)
			continue
		}
		const cat = classifyTool(tool.toolName, tool.args)
		if (!counts.has(cat)) order.push(cat)
		counts.set(cat, (counts.get(cat) ?? 0) + 1)
	}
	flush()
	return segments.join(", ")
}

// ---------------------------------------------------------------------------
// describeTool
// ---------------------------------------------------------------------------

// Safely extract the first text block from a bash tool's result. Returns
// undefined when there is no result, no content array, or no text block.
// biome-ignore lint/suspicious/noExplicitAny: duck-typed runtime tool object
// biome-ignore lint/suspicious/noExplicitAny: duck-typed runtime tool object, matches isFailedTool precedent
function getBashStdout(tool: any): string | undefined {
	const content = tool?.result?.content
	if (!Array.isArray(content)) return undefined
	// biome-ignore lint/suspicious/noExplicitAny: content blocks are untyped at runtime
	const block = content.find((b: any) => b?.type === "text")
	return typeof block?.text === "string" ? block.text : undefined
}

// Matches `[branch sha]` at the start of a line. Git commit stdout looks like:
//   [main abc1234] commit message
const GIT_COMMIT_SHA_RE = /^\[[^\s]+\s+([0-9a-f]{7,40})\]/m

// Matches `<old>..<new>  ref -> ref` — capture group 2 is the NEW sha.
const GIT_PUSH_SHA_RE = /([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})\s+\S+ -> \S+/

/**
 * Produce a short human description of a completed tool call, when one can be
 * inferred from its output. Returns `undefined` for in-progress tools, non-bash
 * tools, or bash commands whose output cannot be parsed.
 *
 * Currently describes `git commit` ("committed <sha>") and `git push"
 * ("pushed <new-sha>"). The `rtk ` prefix is handled consistently with
 * `classifyTool`.
 */
export function describeTool(tool: object): string | undefined {
	if (!isToolLike(tool)) return undefined
	if (tool.isPartial === true) return undefined
	// biome-ignore lint/suspicious/noExplicitAny: duck-typed runtime result, matches getBashStdout/isFailedTool precedent
	if ((tool as any).result?.isError === true) return undefined
	if (tool.toolName !== "bash") return undefined

	const command = typeof tool.args.command === "string" ? tool.args.command.trim() : ""
	const words = command.split(/\s+/)
	const firstWord = words[0] ?? ""
	// rtk wraps known tools: "rtk git commit ..." — treat like "git commit ..."
	const effectiveWord = firstWord === "rtk" ? (words[1] ?? "") : firstWord
	if (effectiveWord !== "git") return undefined

	const subcommand = words[firstWord === "rtk" ? 2 : 1] ?? ""
	if (subcommand !== "commit" && subcommand !== "push") return undefined

	const stdout = getBashStdout(tool)
	if (stdout === undefined) return undefined

	if (subcommand === "commit") {
		const match = stdout.match(GIT_COMMIT_SHA_RE)
		return match ? `committed ${match[1]}` : undefined
	}
	// subcommand === "push"
	const match = stdout.match(GIT_PUSH_SHA_RE)
	return match ? `pushed ${match[2]}` : undefined
}

// ---------------------------------------------------------------------------
// buildCurrentToolLine
// ---------------------------------------------------------------------------

export function buildCurrentToolLine(tool: object): string {
	if (!isToolLike(tool)) return "…"
	const { toolName, args } = tool
	switch (toolName) {
		case "bash": {
			const cmd = typeof args.command === "string" ? args.command.slice(0, 60) : ""
			return `$ ${cmd}`
		}
		case "read": {
			const path = typeof args.path === "string" ? args.path : ""
			return `reading ${path}`
		}
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : ""
			return `searching "${pattern}"`
		}
		case "ls": {
			const path = typeof args.path === "string" ? args.path : "."
			return `ls ${path}`
		}
		default:
			return `${toolName} …`
	}
}

// ---------------------------------------------------------------------------
// buildGroupView
// ---------------------------------------------------------------------------

const GROUP_RENDER_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-render")

// biome-ignore lint/suspicious/noExplicitAny: theme comes from untyped external package
export function buildGroupView(run: object[], theme: any): ToolBlockView {
	const view = new ToolBlockView()
	// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on unknown object
	const last = run[run.length - 1] as any
	const isInProgress = last?.isPartial === true
	const summaryText = buildGroupSummaryText(run, isInProgress)

	const startedAt = last?.rendererState?._executionStartedAt
	const endedAt = last?.rendererState?._executionEndedAt
	const elapsedMs = startedAt ? (endedAt ?? Date.now()) - startedAt : 0
	const timer = formatToolTimer(elapsedMs)
	const right = timer
		? (theme?.fg?.("dim", `(ctrl+o to expand) • ${timer}`) ?? `(ctrl+o to expand) • ${timer}`)
		: (theme?.fg?.("dim", "(ctrl+o to expand)") ?? "(ctrl+o to expand)")

	if (isInProgress) {
		const icon = theme?.fg?.("accent", "⟳") ?? "⟳"
		view.setHeader(`${icon} ${summaryText}…`, right)
		view.setBranchMode((s: string) => theme?.fg?.("borderMuted", s) ?? s)
		view.setExtra([theme?.fg?.("dim", buildCurrentToolLine(last)) ?? buildCurrentToolLine(last)])
	} else {
		const icon = theme?.fg?.("success", "✓") ?? "✓"
		view.setHeader(`${icon} ${summaryText}`, right)
		view.hideDivider()
		view.setFooter("", "")
		view.setExtra([])
	}

	return view
}

// ---------------------------------------------------------------------------
// patchToolGroupRendering
// ---------------------------------------------------------------------------

// Symbol key for the render cache managed by tool-rendering.ts — we need to
// bust it when we inject a temporary group view so the real content isn't
// evicted from the cache and the injected lines don't persist across renders.
const TOOL_RENDER_CACHE_KEY = Symbol.for("pi-claude-style-tools:tool-render-cache")

export function patchToolGroupRendering(): void {
	// biome-ignore lint/suspicious/noExplicitAny: prototype patching requires runtime property access
	const proto = ToolExecutionComponent.prototype as any
	if (proto[GROUP_RENDER_PATCH_FLAG]) return

	// originalRender resolves via the prototype chain to Container.prototype.render,
	// which has already been patched by tool-rendering.ts to apply the ▍ stroke
	// (via contentBox / Box) and the spacing/border wrapper.  Calling it with a
	// temporarily-swapped contentBox lets us reuse that full pipeline.
	const originalRender = proto.render

	proto.render = function patchedGroupRender(width: number): string[] {
		const parent = getParent(this)
		if (!parent) return originalRender.call(this, width)

		const run = findToolGroup(this, parent.children)
		// Collapse when there are 2+ groupable tools, OR when there is exactly 1
		// tool AND it is describable (describeTool returns a non-undefined string).
		// A lone git commit should render as "committed abc1234", not the full block.
		const isDescribableSingle = run.length === 1 && describeTool(run[0]) !== undefined
		if (run.length < 2 && !isDescribableSingle) return originalRender.call(this, width)

		// ctrl+o wires to component.setExpanded() on ALL tools globally.
		// Use the last tool's .expanded field as the group's expand state.
		// biome-ignore lint/suspicious/noExplicitAny: runtime duck-typing on ToolExecutionComponent instance
		const lastTool = run[run.length - 1] as any
		if (lastTool.expanded === true) return originalRender.call(this, width)

		if (lastTool !== this) return []

		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const theme = (this as any).ui?.theme
		const groupView = buildGroupView(run, theme)

		// Inject groupView into contentBox so the full render pipeline applies the
		// ▍ stroke (Box) and spacing/border wrapper (patchedContainerRender).
		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const contentBox = (this as any).contentBox
		// biome-ignore lint/suspicious/noExplicitAny: accessing private fields of untyped prototype
		const usingSelf = typeof (this as any).getRenderShell === "function" && (this as any).getRenderShell() === "self"

		if (!contentBox || usingSelf) {
			// Fallback: no contentBox available — return raw lines without stroke.
			return groupView.render(width)
		}

		const isInProgress = lastTool.isPartial === true
		const savedChildren = contentBox.children.slice() as object[]
		const savedBgFn = contentBox.bgFn as unknown
		const savedPaddingY = contentBox.paddingY as number

		// Swap in group view with the appropriate accent color and no vertical padding
		// so the group summary takes a single content line instead of three.
		contentBox.children = [groupView]
		contentBox.bgFn = isInProgress
			? (s: string) => theme?.fg?.("accent", s) ?? s
			: (s: string) => theme?.fg?.("success", s) ?? s
		contentBox.paddingY = 0

		// Bypass render caches so the patched Container render actually runs.
		// biome-ignore lint/suspicious/noExplicitAny: Symbol-keyed cache busting on untyped prototype
		delete (this as any)[TOOL_RENDER_CACHE_KEY]
		contentBox.invalidate()

		const result = originalRender.call(this, width)

		// Restore original state and bust caches again so the next real render
		// goes through a full re-render instead of serving our injected lines.
		contentBox.children = savedChildren
		contentBox.bgFn = savedBgFn
		contentBox.paddingY = savedPaddingY
		contentBox.invalidate()
		// biome-ignore lint/suspicious/noExplicitAny: Symbol-keyed cache busting on untyped prototype
		delete (this as any)[TOOL_RENDER_CACHE_KEY]

		return result
	}

	proto[GROUP_RENDER_PATCH_FLAG] = true
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function registerToolGrouping(_pi: ExtensionAPI): void {
	patchAddChild()
	patchToolGroupRendering()
}
