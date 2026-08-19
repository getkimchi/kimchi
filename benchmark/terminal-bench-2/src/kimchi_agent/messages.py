from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BaseMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Cost(BaseMessage):
    total: float = 0.0


class Usage(BaseMessage):
    input: int = 0
    output: int = 0
    cache_read: int = Field(0, alias="cacheRead")
    cache_write: int = Field(0, alias="cacheWrite")
    cost: Cost = Field(default_factory=Cost)


class Message(BaseMessage):
    role: str = ""
    usage: Usage = Field(default_factory=Usage)


class GoalEvaluatorUsage(BaseMessage):
    """Matches kimchi's narrowed GoalEvaluatorUsage (src/extensions/goal/types.ts),
    not the full assistant-message Usage shape above: no nested cost object, no
    reasoning/cacheWrite1h breakdown."""

    input: int = 0
    output: int = 0
    cache_read: int = Field(0, alias="cacheRead")
    cache_write: int = Field(0, alias="cacheWrite")
    total_tokens: int = Field(0, alias="totalTokens")
    cost_usd: float = Field(0.0, alias="costUsd")


class SessionEntry(BaseMessage):
    type: str
    custom_type: str = Field("", alias="customType")
    # Left untyped: `data` carries a different shape per custom entry type.
    data: dict[str, Any] | None = None
    message: Message = Field(default_factory=Message)
