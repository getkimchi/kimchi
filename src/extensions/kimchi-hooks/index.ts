import { createCommandHookAdapter } from "../hook-adapters/adapter.js"
import { KIMCHI_HOOKS_ADAPTER_DEFINITION } from "./definition.js"

export const kimchiHooksAdapter = createCommandHookAdapter(KIMCHI_HOOKS_ADAPTER_DEFINITION)

export default kimchiHooksAdapter
