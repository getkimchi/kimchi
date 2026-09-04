from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_GITHUB_REPO = "getkimchi/kimchi"


class KimchiAgentConfig(BaseSettings):
    """Validated config resolved from the host environment at agent construction time."""

    model_config = SettingsConfigDict(extra="ignore")

    binary_path: Path | None = Field(
        default=None,
        validation_alias="KIMCHI_CODE_BINARY",
        description=(
            "Host path to a prebuilt linux kimchi binary (e.g. dist/bin/kimchi). "
            "The agent uploads the binary's grandparent directory so share/kimchi/ auxiliary files travel with it. "
            "If unset, the latest GitHub release is fetched."
        ),
    )
    github_token: str | None = Field(
        default=None,
        validation_alias="GITHUB_TOKEN",
        description="Optional GitHub token used when fetching release assets; lifts the 60/hr anonymous rate limit.",
    )
    github_repo: str = DEFAULT_GITHUB_REPO

    @field_validator("binary_path", mode="before")
    @classmethod
    def _expand_path(cls, v: str | Path | None) -> Path | None:
        if v is None or v == "":
            return None
        return Path(v).expanduser().resolve()

    @field_validator("binary_path")
    @classmethod
    def _must_exist(cls, v: Path | None) -> Path | None:
        if v is not None and not v.is_file():
            raise ValueError(f"KIMCHI_CODE_BINARY={v} does not exist or is not a regular file")
        return v
