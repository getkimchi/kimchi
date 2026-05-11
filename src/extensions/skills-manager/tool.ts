import { Type } from "typebox"
import type { Static } from "typebox"
import type { SkillManageResult, SkillManager } from "./skill-manager.js"
import type { UsageEntry, UsageTracker } from "./usage.js"

export const SkillManageSchema = Type.Object({
	action: Type.String({
		description: "Action to perform: create, edit, patch, delete, write_file, remove_file, pin, list",
	}),
	name: Type.Optional(Type.String({ description: "Skill name" })),
	content: Type.Optional(Type.String({ description: "Full content for create or edit" })),
	category: Type.Optional(Type.String()),
	old_string: Type.Optional(Type.String()),
	new_string: Type.Optional(Type.String()),
	file_path: Type.Optional(Type.String()),
	file_content: Type.Optional(Type.String()),
	absorbed_into: Type.Optional(Type.String()),
	pin: Type.Optional(Type.Boolean()),
})

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
			// Per-action argument validators. The flat schema (see comment on
			// SkillManageSchema above) cannot encode "action X requires fields Y, Z",
			// so we enforce that at runtime here and return a friendly error rather
			// than letting the handler crash on an undefined dereference.
			const requireString = (
				value: string | undefined,
				field: string,
				action: string,
			): { ok: true; value: string } | { ok: false; error: string } =>
				value === undefined ? { ok: false, error: `Action '${action}' requires '${field}'.` } : { ok: true, value }
			const requireBoolean = (
				value: boolean | undefined,
				field: string,
				action: string,
			): { ok: true; value: boolean } | { ok: false; error: string } =>
				value === undefined ? { ok: false, error: `Action '${action}' requires '${field}'.` } : { ok: true, value }

			try {
				switch (params.action) {
					case "create": {
						const nameArg = requireString(params.name, "name", "create")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const contentArg = requireString(params.content, "content", "create")
						if (!contentArg.ok) return wrapResult({ success: false, error: contentArg.error })
						const r = await manager.create(nameArg.value, contentArg.value, params.category)
						if (r.success) await tracker.bumpCreate(nameArg.value, isSessionReview)
						return wrapResult(r)
					}
					case "edit": {
						const nameArg = requireString(params.name, "name", "edit")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const contentArg = requireString(params.content, "content", "edit")
						if (!contentArg.ok) return wrapResult({ success: false, error: contentArg.error })
						const pinErr = await pinnedGuard(nameArg.value, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(nameArg.value, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.edit(nameArg.value, contentArg.value)
						if (r.success) await tracker.bumpPatch(nameArg.value)
						return wrapResult(r)
					}
					case "patch": {
						const nameArg = requireString(params.name, "name", "patch")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const oldArg = requireString(params.old_string, "old_string", "patch")
						if (!oldArg.ok) return wrapResult({ success: false, error: oldArg.error })
						const newArg = requireString(params.new_string, "new_string", "patch")
						if (!newArg.ok) return wrapResult({ success: false, error: newArg.error })
						const pinErr = await pinnedGuard(nameArg.value, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(nameArg.value, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.patch(nameArg.value, oldArg.value, newArg.value, params.file_path)
						if (r.success) await tracker.bumpPatch(nameArg.value)
						return wrapResult(r)
					}
					case "delete": {
						const nameArg = requireString(params.name, "name", "delete")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const pinErr = await pinnedGuard(nameArg.value, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(nameArg.value, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.delete(nameArg.value, params.absorbed_into)
						if (r.success) await tracker.archive(nameArg.value, params.absorbed_into)
						return wrapResult(r)
					}
					case "write_file": {
						const nameArg = requireString(params.name, "name", "write_file")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const pathArg = requireString(params.file_path, "file_path", "write_file")
						if (!pathArg.ok) return wrapResult({ success: false, error: pathArg.error })
						const contentArg = requireString(params.file_content, "file_content", "write_file")
						if (!contentArg.ok) return wrapResult({ success: false, error: contentArg.error })
						const pinErr = await pinnedGuard(nameArg.value, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(nameArg.value, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.writeFile(nameArg.value, pathArg.value, contentArg.value)
						if (r.success) await tracker.bumpPatch(nameArg.value)
						return wrapResult(r)
					}
					case "remove_file": {
						const nameArg = requireString(params.name, "name", "remove_file")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const pathArg = requireString(params.file_path, "file_path", "remove_file")
						if (!pathArg.ok) return wrapResult({ success: false, error: pathArg.error })
						const pinErr = await pinnedGuard(nameArg.value, tracker)
						if (pinErr) return wrapResult({ success: false, error: pinErr })
						const reviewErr = await sessionReviewWriteGuard(nameArg.value, tracker)
						if (reviewErr) return wrapResult({ success: false, error: reviewErr })
						const r = await manager.removeFile(nameArg.value, pathArg.value)
						if (r.success) await tracker.bumpPatch(nameArg.value)
						return wrapResult(r)
					}
					case "pin": {
						const nameArg = requireString(params.name, "name", "pin")
						if (!nameArg.ok) return wrapResult({ success: false, error: nameArg.error })
						const pinArg = requireBoolean(params.pin, "pin", "pin")
						if (!pinArg.ok) return wrapResult({ success: false, error: pinArg.error })
						await tracker.setPin(nameArg.value, pinArg.value)
						return wrapResult({
							success: true,
							message: `Pin for '${nameArg.value}' set to ${pinArg.value}.`,
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
						return wrapResult({ success: false, error: `Unknown action: '${params.action}'.` })
					}
				}
			} catch (err) {
				return wrapResult({ success: false, error: String(err) })
			}
		},
	}
}
