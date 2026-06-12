import json
import os
from collections.abc import Iterable

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

KIMCHI_API = "https://llm.kimchi.dev"
KIMCHI_PROVIDER = "kimchi-dev"
KIMCHI_OPENAI_BASE_URL = f"{KIMCHI_API}/openai/v1"
KIMCHI_ANTHROPIC_BASE_URL = f"{KIMCHI_API}/anthropic"
KIMCHI_MODELS_METADATA_URL = f"{KIMCHI_API}/v1/models/metadata?include_in_cli=true"
KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"

FETCH_TIMEOUT_SEC = 20
FETCH_MAX_ATTEMPTS = 3
FETCH_RETRY_BACKOFF_SEC = 1
RETRYABLE_FETCH_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504, 524, 529})


class KimchiModelLimits(BaseModel):
    model_config = ConfigDict(extra="ignore")

    context_window: StrictInt = Field(gt=0)
    max_output_tokens: StrictInt = Field(gt=0)


class KimchiModelMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    slug: str = Field(min_length=1)
    display_name: str | None = None
    reasoning: StrictBool = False
    input_modalities: list[str] = Field(default_factory=lambda: ["text"])
    limits: KimchiModelLimits


class KimchiModelsMetadataResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    models: list[KimchiModelMetadata] = Field(min_length=1)


def _is_retryable_metadata_fetch_error(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_FETCH_STATUSES
    return False


class KimchiGatewayMixin:
    def _passthrough_env(
        self,
        *,
        prefixes: tuple[str, ...] = (),
        keys: Iterable[str] = (),
        blocked_prefixes: tuple[str, ...] = (),
        blocked_keys: Iterable[str] = (),
    ) -> dict[str, str]:
        allowed_keys = set(keys)
        denied_keys = set(blocked_keys)

        def allowed(key: str) -> bool:
            if key in denied_keys or key.startswith(blocked_prefixes):
                return False
            return key in allowed_keys or key.startswith(prefixes)

        env = {key: value for key, value in os.environ.items() if allowed(key)}
        env.update({key: value for key, value in self._extra_env.items() if allowed(key)})
        return env

    def _scrub_extra_env(
        self,
        *,
        keys: Iterable[str] = (),
        prefixes: tuple[str, ...] = (),
        allow_keys: Iterable[str] = (),
    ) -> None:
        scrub_keys = set(keys)
        allowed_keys = set(allow_keys)
        for key in list(self._extra_env):
            if key in allowed_keys:
                continue
            if key in scrub_keys or key.startswith(prefixes):
                self._extra_env.pop(key, None)

    def _split_model(self, model_name: str | None) -> tuple[str, str]:
        if not model_name or "/" not in model_name:
            raise ValueError("--model is required and must use provider/model format, e.g. kimchi-dev/kimi-k2.5")
        provider, model_id = model_name.split("/", 1)
        if provider != KIMCHI_PROVIDER:
            raise ValueError(
                f"{type(self).__name__} only supports {KIMCHI_PROVIDER}/<model-id> models; got {model_name!r}"
            )
        if not model_id:
            raise ValueError("--model must include a model id after kimchi-dev/")
        return provider, model_id

    def _required_kimchi_api_key(self) -> str:
        api_key = self._get_env(KIMCHI_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{KIMCHI_API_KEY_ENV} is required. Export it on the host and forward it with "
                f"`--ae {KIMCHI_API_KEY_ENV}=${KIMCHI_API_KEY_ENV}`."
            )
        return api_key

    @retry(
        retry=retry_if_exception(_is_retryable_metadata_fetch_error),
        stop=stop_after_attempt(FETCH_MAX_ATTEMPTS),
        wait=wait_exponential(
            multiplier=FETCH_RETRY_BACKOFF_SEC,
            min=FETCH_RETRY_BACKOFF_SEC,
            max=FETCH_RETRY_BACKOFF_SEC * (FETCH_MAX_ATTEMPTS - 1),
        ),
        reraise=True,
    )
    def _fetch_model_metadata_body(self, api_key: str) -> object:
        response = httpx.get(
            KIMCHI_MODELS_METADATA_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=FETCH_TIMEOUT_SEC,
        )
        response.raise_for_status()
        return response.json()

    def _fetch_model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        try:
            body = self._fetch_model_metadata_body(api_key)
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Failed to fetch Kimchi model metadata: HTTP {exc.response.status_code}") from exc
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise RuntimeError(
                f"Failed to fetch Kimchi model metadata after {FETCH_MAX_ATTEMPTS} attempts: {exc}"
            ) from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Failed to fetch Kimchi model metadata: {exc}") from exc

        try:
            metadata = KimchiModelsMetadataResponse.model_validate(body)
        except ValidationError as exc:
            raise RuntimeError(f"Failed to parse Kimchi model metadata: {exc}") from exc

        return metadata.models

    def _model_metadata(self, api_key: str) -> list[KimchiModelMetadata]:
        cache = getattr(self, "_kimchi_model_metadata_cache", None)
        if cache is None or cache[0] != api_key:
            cache = (api_key, self._fetch_model_metadata(api_key))
            self._kimchi_model_metadata_cache = cache
        return cache[1]

    def _model_metadata_for(self, api_key: str, model_name: str | None) -> KimchiModelMetadata:
        _, model_id = self._split_model(model_name)
        for model in self._model_metadata(api_key):
            if model.slug == model_id:
                return model
        raise ValueError(f"Model {model_name!r} was not returned by {KIMCHI_MODELS_METADATA_URL}")

    def _selected_model_metadata(self, api_key: str) -> KimchiModelMetadata:
        return self._model_metadata_for(api_key, self.model_name)
