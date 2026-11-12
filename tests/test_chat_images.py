"""Unit tests for inline-image support in the concierge chat path.

Covers the pure helpers in chat.py that turn deep-chat's attached files into
Anthropic image content blocks and assemble the SDK user message. No agent /
`claude` CLI is spawned — these are string/dict transforms only."""

from __future__ import annotations

import sys

sys.path.insert(0, "packages/local-app")
import chat  # noqa: E402

# A 1x1 transparent PNG — smallest valid base64 image we can assert against.
PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
PNG_DATA_URL = f"data:image/png;base64,{PNG_1PX}"


def _user(text, files=None):
    msg = {"role": "user", "text": text}
    if files is not None:
        msg["files"] = files
    return msg


# ----------------------------------------------------- _image_blocks_from_message


def test_extracts_supported_base64_image():
    blocks = chat._image_blocks_from_message(
        _user("look", [{"src": PNG_DATA_URL, "type": "image"}])
    )
    assert blocks == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": PNG_1PX}}
    ]


def test_infers_image_when_type_missing():
    # deep-chat sometimes omits `type`; a base64 image/* data URL still counts.
    blocks = chat._image_blocks_from_message(_user("hi", [{"src": PNG_DATA_URL}]))
    assert len(blocks) == 1
    assert blocks[0]["source"]["media_type"] == "image/png"


def test_skips_remote_url_and_non_image_and_unsupported():
    files = [
        {"src": "https://example.com/cat.png", "type": "image"},  # not base64
        {"src": "data:application/pdf;base64,Zm9v", "type": "any"},  # non-image type
        {"src": "data:image/tiff;base64,Zm9v", "type": "image"},  # unsupported media
        {"src": "", "type": "image"},  # empty
    ]
    assert chat._image_blocks_from_message(_user("x", files)) == []


def test_skips_oversized_image():
    big = "A" * (8 * 1024 * 1024)  # ~6MB decoded, over the 5MB ceiling
    files = [{"src": f"data:image/png;base64,{big}", "type": "image"}]
    assert chat._image_blocks_from_message(_user("x", files)) == []


def test_no_files_is_empty():
    assert chat._image_blocks_from_message(_user("just text")) == []
    assert chat._image_blocks_from_message({}) == []


# ----------------------------------------------------- _latest_image_blocks


def test_latest_only_from_last_user_turn():
    messages = [
        _user("first", [{"src": PNG_DATA_URL, "type": "image"}]),  # earlier — ignored
        {"role": "ai", "text": "ok"},
        _user("second", [{"src": PNG_DATA_URL, "type": "image"}]),  # latest — used
    ]
    blocks = chat._latest_image_blocks(messages)
    assert len(blocks) == 1


def test_latest_empty_when_assistant_is_last():
    messages = [
        _user("q", [{"src": PNG_DATA_URL, "type": "image"}]),
        {"role": "ai", "text": "answer"},
    ]
    assert chat._latest_image_blocks(messages) == []


def test_latest_empty_for_no_messages():
    assert chat._latest_image_blocks([]) == []


# ----------------------------------------------------- _user_msg assembly


def test_user_msg_text_only_stays_a_string():
    msg = chat._user_msg("hello")
    assert msg == {"type": "user", "message": {"role": "user", "content": "hello"}}


def test_user_msg_text_plus_image_is_block_array():
    img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "x"}}
    msg = chat._user_msg("describe this", [img])
    assert msg["message"]["content"] == [{"type": "text", "text": "describe this"}, img]


def test_user_msg_image_only_omits_text_block():
    img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "x"}}
    msg = chat._user_msg("", [img])
    assert msg["message"]["content"] == [img]
