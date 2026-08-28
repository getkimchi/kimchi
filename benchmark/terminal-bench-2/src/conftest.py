import pytest

from kimchi_agent.openrouter import OpenRouterClient


@pytest.fixture(autouse=True)
def clear_openrouter_caches() -> None:
    """Isolate OpenRouter discovery between tests.

    The client caches /models and /endpoints on the class so concurrent trials
    share one fetch. Without clearing, one test's stubbed catalogue would be
    served to the next.
    """
    OpenRouterClient.clear_caches()
