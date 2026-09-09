#!/usr/bin/env bash

# Resolve the credential required by a benchmark model route, rejecting routes
# outside the caller's allowlist. The caller owns whether the value is forwarded
# with --ae or only inherited by the Harbor host process (Claude Code adapters
# deliberately avoid exposing raw provider keys in the task container).
require_model_api_key() {
    local model="$1"
    shift

    case "$model" in
        moonshotai/*) MODEL_ROUTE="moonshotai"; MODEL_API_KEY_ENV="MOONSHOT_API_KEY" ;;
        zai/*) MODEL_ROUTE="zai"; MODEL_API_KEY_ENV="ZAI_API_KEY" ;;
        openrouter/*) MODEL_ROUTE="openrouter"; MODEL_API_KEY_ENV="OPENROUTER_API_KEY" ;;
        anthropic/*) MODEL_ROUTE="anthropic"; MODEL_API_KEY_ENV="ANTHROPIC_API_KEY" ;;
        openai/*) MODEL_ROUTE="openai"; MODEL_API_KEY_ENV="OPENAI_API_KEY" ;;
        kimchi-dev/*) MODEL_ROUTE="kimchi-dev"; MODEL_API_KEY_ENV="KIMCHI_API_KEY" ;;
        multi-model) MODEL_ROUTE="multi-model"; MODEL_API_KEY_ENV="KIMCHI_API_KEY" ;;
        *)
            echo "unsupported model route: $model" >&2
            return 1
            ;;
    esac

    local allowed_route
    local route_allowed=false
    for allowed_route in "$@"; do
        if [[ "$MODEL_ROUTE" == "$allowed_route" ]]; then
            route_allowed=true
            break
        fi
    done
    if [[ "$route_allowed" != true ]]; then
        echo "model route $MODEL_ROUTE is not supported by this runner: $model" >&2
        return 1
    fi

    if [[ -z "${!MODEL_API_KEY_ENV:-}" ]]; then
        echo "$MODEL_API_KEY_ENV is required for $model" >&2
        return 1
    fi
}
