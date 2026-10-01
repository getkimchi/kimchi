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


class SessionEntry(BaseMessage):
    type: str
    id: str | None = None
    parent_id: str | None = Field(None, alias="parentId")
    custom_type: str = Field("", alias="customType")
    data: dict[str, Any] | None = None
    message: Message = Field(default_factory=Message)
