export const GOAL_RESOURCE_ID = "experimental.goal"
export const GOAL_CUSTOM_ENTRY_TYPE = "kimchi_goal_state"
export const GOAL_CONTEXT_MESSAGE_TYPE = "kimchi_goal_context"
export const GOAL_CONTROL_MESSAGE_TYPE = "kimchi_goal_control"
export const GOAL_STATUS_KEY = "goal"

export const GET_GOAL_TOOL_NAME = "get_goal"
export const UPDATE_GOAL_TOOL_NAME = "update_goal"
export const GOAL_TOOL_NAMES = [GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME] as const
