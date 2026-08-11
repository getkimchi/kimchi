from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_GITHUB_REPO = "castai/kimchi"


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
    api_key: str = Field(
        validation_alias="KIMCHI_API_KEY",
        description="Kimchi LLM gateway API key forwarded to kimchi at runtime.",
    )
    github_token: str | None = Field(
        default=None,
        validation_alias="GITHUB_TOKEN",
        description="Optional GitHub token used when fetching release assets; lifts the 60/hr anonymous rate limit.",
    )
    github_repo: str = DEFAULT_GITHUB_REPO
    openviking_extension_dir: Path | None = Field(
        default=None,
        validation_alias="OPENVIKING_EXTENSION_DIR",
        description=(
            "Host path to the official OpenViking Pi extension directory. "
            "Required by the KimchiOpenViking benchmark agent."
        ),
    )

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

    @field_validator("openviking_extension_dir", mode="before")
    @classmethod
    def _expand_openviking_extension_dir(cls, v: str | Path | None) -> Path | None:
        if v is None or v == "":
            return None
        return Path(v).expanduser().resolve()

    @field_validator("openviking_extension_dir")
    @classmethod
    def _must_be_openviking_extension(cls, v: Path | None) -> Path | None:
        if v is None:
            return None
        if not v.is_dir() or not (v / "index.ts").is_file():
            raise ValueError(
                f"OPENVIKING_EXTENSION_DIR={v} must be a directory containing index.ts"
            )
        return v

    @field_validator("api_key")
    @classmethod
    def _api_key_non_empty(cls, v: str) -> str:
        if not v:
            raise ValueError(
                "KIMCHI_API_KEY is required to run kimchi. "
                "Export it on the host and forward it with `harbor run --ae KIMCHI_API_KEY=$KIMCHI_API_KEY`."
            )
        return v
