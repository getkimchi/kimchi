import type { ElicitationAcceptAction, ElicitationSchema } from "@agentclientprotocol/sdk"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"

export const ACP_ELICIT_FORM = Symbol.for("kimchi.acp.elicitForm")

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
