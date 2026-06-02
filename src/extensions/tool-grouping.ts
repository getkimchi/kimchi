import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { Container, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { formatToolTimer } from "./tool-rendering.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = "file" | "pattern" | "directory" | "edit" | "command" | "operation"

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
			return "edit"
		case "bash": {
			const command = typeof args.command === "string" ? args.command.trim() : ""
			const words = command.split(/\s+/)
			const firstWord = words[0] ?? ""
			// rtk wraps known tools: "rtk grep ...", "rtk read ..." — classify by the wrapped tool
			const effectiveWord = firstWord === "rtk" ? (words[1] ?? "") : firstWord
			if (BASH_DIRECTORY_CMDS.has(effectiveWord)) return "directory"
			if (BASH_PATTERN_CMDS.has(effectiveWord)) return "pattern"
			if (BASH_FILE_CMDS.has(effectiveWord)) return "file"
			return "operation"
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
	edit: (n) => `made ${n} ${n === 1 ? "edit" : "edits"}`,
	command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
	operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

const CONTINUOUS: Record<Category, (n: number) => string> = {
	file: (n) => `reading ${n} ${n === 1 ? "file" : "files"}`,
	pattern: (n) => `searching for ${n} ${n === 1 ? "pattern" : "patterns"}`,
	directory: (n) => `listing ${n} ${n === 1 ? "directory" : "directories"}`,
	edit: (n) => `editing ${n} ${n === 1 ? "file" : "files"}`,
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
	const order: Category[] = []
	const counts = new Map<Category, number>()
	for (const tool of run) {
		if (!isToolLike(tool)) continue
		const cat = classifyTool(tool.toolName, tool.args)
		if (!counts.has(cat)) order.push(cat)
		counts.set(cat, (counts.get(cat) ?? 0) + 1)
	}
	const orderedCounts = new Map(order.map((cat) => [cat, counts.get(cat) ?? 0]))
	return formatSummary(orderedCounts, isInProgress)
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
		if (run.length < 2) return originalRender.call(this, width)

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
