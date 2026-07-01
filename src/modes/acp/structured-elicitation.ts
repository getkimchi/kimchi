import type { ElicitationAcceptAction, ElicitationSchema } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"

export const ACP_ELICIT_FORM = Symbol.for("kimchi.acp.elicitForm")

export interface ElicitationChoiceOption {
	id: string
	label: string
}

export type AcpElicitForm = (
	title: string,
	message: string | undefined,
	requestedSchema: ElicitationSchema,
	signal: AbortSignal | undefined,
) => Promise<NonNullable<ElicitationAcceptAction["content"]> | "aborted" | undefined>

export type AcpElicitationUIContext = ExtensionUIContext & {
	[ACP_ELICIT_FORM]: AcpElicitForm
}

export function getAcpElicitForm(ui: ExtensionUIContext): AcpElicitForm | undefined {
	const candidate = (ui as unknown as Record<typeof ACP_ELICIT_FORM, unknown>)[ACP_ELICIT_FORM]
	return typeof candidate === "function" ? (candidate as AcpElicitForm) : undefined
}

export function choiceSchema(
	options: readonly ElicitationChoiceOption[],
	required: boolean,
	multi: boolean,
): ElicitationSchema {
	return {
		type: "object",
		properties: {
			value: multi
				? {
						type: "array",
						items: {
							anyOf: options.map((option) => ({ const: option.id, title: option.label })),
						},
						...(required ? { minItems: 1 } : {}),
					}
				: {
						type: "string",
						oneOf: options.map((option) => ({ const: option.id, title: option.label })),
					},
		},
		required: required ? ["value"] : [],
	}
}

export function freeTextSchema(required: boolean, description?: string): ElicitationSchema {
	return {
		type: "object",
		properties: {
			value: {
				type: "string",
				...(description !== undefined ? { description } : {}),
			},
		},
		required: required ? ["value"] : [],
	}
}

export function confirmSchema(): ElicitationSchema {
	return {
		type: "object",
		properties: {
			confirmed: {
				type: "boolean",
				// Default is always false as Pi has no way of distinguishing
				// a confirm result as cancelled (e.g. user didn't select explicitly)
				default: false,
			},
		},
		required: ["confirmed"],
	}
}
