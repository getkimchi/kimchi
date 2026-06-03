import { createCommandHookAdapter } from "../hook-adapters/adapter.js"
import { CODEX_HOOK_ADAPTER_DEFINITION } from "./definition.js"

export const codexHooksAdapter = createCommandHookAdapter(CODEX_HOOK_ADAPTER_DEFINITION)

export default codexHooksAdapter
