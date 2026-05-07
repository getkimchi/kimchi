import { Type } from "typebox"
import type { Static } from "typebox"
import type { SkillManageResult, SkillManager } from "./skill-manager.js"
import type { UsageEntry, UsageTracker } from "./usage.js"

const CreateAction = Type.Object({
	action: Type.Literal("create"),
	name: Type.String(),
	content: Type.String(),
	category: Type.Optional(Type.String()),
})

const EditAction = Type.Object({
	action: Type.Literal("edit"),
	name: Type.String(),
	content: Type.String(),
})

const PatchAction = Type.Object({
	action: Type.Literal("patch"),
	name: Type.String(),
	old_string: Type.String(),
	new_string: Type.String(),
	file_path: Type.Optional(Type.String()),
})

const DeleteAction = Type.Object({
	action: Type.Literal("delete"),
	name: Type.String(),
	absorbed_into: Type.Optional(Type.String()),
})

const WriteFileAction = Type.Object({
	action: Type.Literal("write_file"),
	name: Type.String(),
	file_path: Type.String(),
	file_content: Type.String(),
})

const RemoveFileAction = Type.Object({
	action: Type.Literal("remove_file"),
	name: Type.String(),
	file_path: Type.String(),
})

const PinAction = Type.Object({
	action: Type.Literal("pin"),
	name: Type.String(),
	pin: Type.Boolean(),
})

const ListAction = Type.Object({
	action: Type.Literal("list"),
})

export const SkillManageSchema = Type.Union([
	CreateAction,
	EditAction,
	PatchAction,
	DeleteAction,
	WriteFileAction,
	RemoveFileAction,
	PinAction,
	ListAction,
])

export type SkillManageArgs = Static<typeof SkillManageSchema>

function wrapResult(result: SkillManageResult): {
	content: [{ type: "text"; text: string }]
	details: SkillManageResult
} {
	return {
		content: [
			{
				type: "text",
				text: result.success ? (result.message ?? "Done") : (result.error ?? "Error"),
			},
		],
		details: result,
	}
}

async function pinnedGuard(name: string, tracker: UsageTracker): Promise<string | null> {
	try {
		const entries = await tracker.list()
		const entry = entries.find((e: UsageEntry) => e.name === name)
		if (entry?.pinned) {
			return `Skill '${name}' is pinned and cannot be modified. Unpin it first with: skill_manage action=pin name=${name} pin=false`
		}
	} catch {
		// best-effort — don't block if tracker unreadable
	}
	return null
}

async function sessionReviewWriteGuard(name: string, tracker: UsageTracker): Promise<string | null> {
	if (process.env.KIMCHI_SESSION_REVIEW !== "1") return null
	try {
		const entries = await tracker.list()
		const entry = entries.find((e: UsageEntry) => e.name === name)
		if (!entry?.agent_created) {
			return `Session review cannot modify '${name}': only agent-created skills may be edited by background review.`
		}
	} catch {
		// best-effort — don't block if tracker unreadable
	}
	return null
}

export function createSkillViewTool(manager: SkillManager, tracker: UsageTracker) {
	return {
		name: "skill_view",
		label: "Skill View",
		description:
			"Load a skill's full content. First call (no file_path) returns SKILL.md plus a linked_files map of available references/templates/scripts/assets. " +
			"To read a linked file, call again with file_path (e.g. 'references/api.md').",
		parameters: Type.Object({
			name: Type.String({ description: "Skill name (use skill_manage action=list to discover)" }),
			file_path: Type.Optional(
				Type.String({
					description: "Path to a linked file within the skill, e.g. 'references/api.md'. Omit for main SKILL.md.",
				}),
			),
		}),
		async execute(_toolCallId: string, params: { name: string; file_path?: string }) {
			const result = await manager.view(params.name, params.file_path)
			if (result.success) {
				void tracker.bumpUse(params.name)
			}
			const text = result.success
				? [
						result.content ?? "",
						result.linked_files ? `\nLinked files: ${JSON.stringify(result.linked_files)}` : "",
					].join("")
				: (result.error ?? "Error")
			return {
				content: [{ type: "text" as const, text }],
				details: result,
			}
		},
	}
}

export function createSkillManageTool(manager: SkillManager, tracker: UsageTracker) {
	const isSessionReview = process.env.KIMCHI_SESSION_REVIEW === "1"

	return {
		name: "skill_manage",
		label: "Skill Manager",
		description:
			"Create, edit, patch, delete, list, and manage Kimchi skills.\n\n" +
			"Actions: create, edit, patch, delete, list (inventory), write_file, remove_file, pin.\n\n" +
			"## Inline skill creation guidance\n" +
			"Create when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.\n" +
			"Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use.\n" +
			"After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating or deleting.",
		parameters: SkillManageSchema,
		async execute(_toolCallId: string, params: SkillManageArgs) {
			try {
				switch (params.action) {
					case "create": {
						const r = await manager.create(params.name, params.content, params.category)
						if (r.success) await tracker.bumpCreate(params.name, isSessionReview)
						return wrapResult(r)
					}
					case "edit": {
						const pinErr = await pinnedGuard(params.name, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(params.name, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.edit(params.name, params.content)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "patch": {
						const pinErr = await pinnedGuard(params.name, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(params.name, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.patch(params.name, params.old_string, params.new_string, params.file_path)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "delete": {
						const pinErr = await pinnedGuard(params.name, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(params.name, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.delete(params.name, params.absorbed_into)
						if (r.success) await tracker.archive(params.name, params.absorbed_into)
						return wrapResult(r)
					}
					case "write_file": {
						const pinErr = await pinnedGuard(params.name, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(params.name, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.writeFile(params.name, params.file_path, params.file_content)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "remove_file": {
						const pinErr = await pinnedGuard(params.name, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(params.name, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.removeFile(params.name, params.file_path)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "pin": {
						await tracker.setPin(params.name, params.pin)
						return wrapResult({
							success: true,
							message: `Pin for '${params.name}' set to ${params.pin}.`,
						})
					}
					case "list": {
						const inventory = await manager.listInventory()
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(inventory, null, 2),
								},
							],
							details: { success: true, message: `Found ${inventory.length} skills.` },
						}
					}
					default: {
						return wrapResult({ success: false, error: "Unknown action." })
					}
				}
			} catch (err) {
				return wrapResult({ success: false, error: String(err) })
			}
		},
	}
}
