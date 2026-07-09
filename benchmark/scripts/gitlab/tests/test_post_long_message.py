#!/usr/bin/env python3
"""Tests for _post_long_message — verifies chunking behavior for Discord's 2000-char limit."""

from __future__ import annotations

from unittest.mock import patch

from summarize_analysis import DISCORD_MAX_CHARS, _post_long_message


def _extract_content(call) -> str:
    """Extract the 'content' field from a _discord_post mock call."""
    # Call is (url, token, {"content": "..."})
    return call.args[2]["content"]


@patch("summarize_analysis._discord_post")
def test_short_message_single_chunk(mock_post):
    """Messages under 2000 chars are sent as a single message."""
    mock_post.return_value = {"id": "123"}
    _post_long_message("http://fake", "token", "short message")
    assert mock_post.call_count == 1
    assert _extract_content(mock_post.call_args_list[0]) == "short message"


@patch("summarize_analysis._discord_post")
def test_exactly_2000_chars_single_chunk(mock_post):
    """Exactly 2000 chars = one chunk, no splitting."""
    mock_post.return_value = {"id": "123"}
    content = "x" * DISCORD_MAX_CHARS
    _post_long_message("http://fake", "token", content)
    assert mock_post.call_count == 1


@patch("summarize_analysis._discord_post")
def test_2001_chars_splits_into_two(mock_post):
    """2001 chars must split into 2 chunks."""
    mock_post.return_value = {"id": "123"}
    content = "x" * (DISCORD_MAX_CHARS + 1)
    _post_long_message("http://fake", "token", content)
    assert mock_post.call_count == 2
    chunks = [_extract_content(c) for c in mock_post.call_args_list]
    assert "".join(chunks) == content
    # First chunk should be exactly 2000 (no split point found in all-x string)
    assert len(chunks[0]) == DISCORD_MAX_CHARS


@patch("summarize_analysis._discord_post")
def test_splits_on_paragraph_boundary(mock_post):
    """Long message with paragraph breaks should split at \\n, not mid-word."""
    mock_post.return_value = {"id": "123"}
    # Two paragraphs, each ~1500 chars, total ~3000
    para1 = "A" * 1500
    para2 = "B" * 1500
    content = f"{para1}\n\n{para2}"
    _post_long_message("http://fake", "token", content)
    assert mock_post.call_count == 2
    chunks = [_extract_content(c) for c in mock_post.call_args_list]
    # First chunk should include para1 and the paragraph break
    assert chunks[0].startswith(para1)
    # Second chunk should be just para2 (no leading whitespace)
    assert chunks[1] == para2
    # No content lost
    assert "".join(chunks) == content


@patch("summarize_analysis._discord_post")
def test_splits_on_sentence_when_no_paragraph(mock_post):
    """When no newline is found, falls back to splitting at sentence boundary."""
    mock_post.return_value = {"id": "123"}
    # One long line with sentences, no newlines
    sentences = ". ".join(["word" * 200 for _ in range(20)])
    assert len(sentences) > DISCORD_MAX_CHARS
    _post_long_message("http://fake", "token", sentences)
    assert mock_post.call_count >= 2
    chunks = [_extract_content(c) for c in mock_post.call_args_list]
    assert "".join(chunks) == sentences
    for chunk in chunks:
        assert len(chunk) <= DISCORD_MAX_CHARS


@patch("summarize_analysis._discord_post")
def test_many_paragraphs_split_correctly(mock_post):
    """Multiple paragraphs that together exceed 2000 chars split into proper chunks."""
    mock_post.return_value = {"id": "123"}
    # 5 paragraphs of 600 chars each = 3000+ total
    paragraphs = [chr(65 + i) * 600 for i in range(5)]
    content = "\n\n".join(paragraphs)
    _post_long_message("http://fake", "token", content)
    assert mock_post.call_count >= 2
    chunks = [_extract_content(c) for c in mock_post.call_args_list]
    assert "".join(chunks) == content
    for chunk in chunks:
        assert len(chunk) <= DISCORD_MAX_CHARS


@patch("summarize_analysis._discord_post")
def test_returns_false_on_post_failure(mock_post):
    """If any chunk fails to post, returns False immediately."""
    mock_post.return_value = None
    result = _post_long_message("http://fake", "token", "x" * 3000)
    assert result is False


@patch("summarize_analysis._discord_post")
def test_empty_message_single_chunk(mock_post):
    """Empty string is sent as a single message."""
    mock_post.return_value = {"id": "123"}
    _post_long_message("http://fake", "token", "")
    assert mock_post.call_count == 1


@patch("summarize_analysis._discord_post")
def test_falls_back_to_single_newline(mock_post):
    """When no \n\n is found, splits at single \n."""
    mock_post.return_value = {"id": "123"}
    line1 = "A" * 1500
    line2 = "B" * 1500
    content = f"{line1}\n{line2}"
    _post_long_message("http://fake", "token", content)
    assert mock_post.call_count == 2
    chunks = [_extract_content(c) for c in mock_post.call_args_list]
    assert chunks[0].startswith(line1)
    assert chunks[1] == line2
    assert "".join(chunks) == content
