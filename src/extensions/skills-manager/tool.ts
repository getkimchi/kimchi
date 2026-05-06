import { Type } from "typebox"
import type { Static } from "typebox"
import type { SkillManageResult, SkillManager } from "./skill-manager.js"
import type { UsageTracker } from "./usage.js"

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

export const SkillManageSchema = Type.Union([
	CreateAction,
	EditAction,
	PatchAction,
	DeleteAction,
	WriteFileAction,
	RemoveFileAction,
	PinAction,
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

export function createSkillManageTool(manager: SkillManager, tracker: UsageTracker) {
	return {
		name: "skill_manage",
		label: "Skill Manager",
		description:
			"Create, edit, patch, delete, and manage Kimchi skills.\n\n" +
			"Actions: create (new skill), edit (rewrite SKILL.md), patch (strict find-replace), " +
			"delete (archive to .archive/), write_file, remove_file, pin.",
		parameters: SkillManageSchema,
		async execute(_toolCallId: string, params: SkillManageArgs) {
			try {
				switch (params.action) {
					case "create": {
						const r = await manager.create(params.name, params.content, params.category)
						if (r.success) await tracker.bumpCreate(params.name)
						return wrapResult(r)
					}
					case "edit": {
						const r = await manager.edit(params.name, params.content)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "patch": {
						const r = await manager.patch(params.name, params.old_string, params.new_string, params.file_path)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "delete": {
						const r = await manager.delete(params.name, params.absorbed_into)
						if (r.success) await tracker.archive(params.name, params.absorbed_into)
						return wrapResult(r)
					}
					case "write_file": {
						const r = await manager.writeFile(params.name, params.file_path, params.file_content)
						if (r.success) await tracker.bumpPatch(params.name)
						return wrapResult(r)
					}
					case "remove_file": {
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
