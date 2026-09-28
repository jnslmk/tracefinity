from __future__ import annotations

import asyncio
import base64
import json

import pytest

from app.config import settings
from app.services.ai_tracer import AITracer

PNG_BYTES = b"\x89PNG\r\n\x1a\nmask-image"


class _SSEStream:
    def __init__(self, lines: list[str]):
        self.lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def raise_for_status(self):
        return None

    async def aiter_lines(self):
        for line in self.lines:
            yield line


def _events(events: list[dict]) -> list[str]:
    return [f"data: {json.dumps(event)}" for event in events] + ["data: [DONE]"]


def _completed_event(output: list[dict]) -> list[str]:
    return _events([{"type": "response.completed", "response": {"output": output}}])


def test_openrouter_responses_mask_decodes_completed_image(monkeypatch):
    output_item = {
        "type": "image_generation_call",
        "result": base64.b64encode(PNG_BYTES).decode("ascii"),
    }
    events = _events([
        {"type": "response.output_item.done", "item": output_item},
        {"type": "response.completed", "response": {"output": []}},
    ])
    requests = []

    def fake_stream(_client, method, url, **kwargs):
        requests.append((method, url, kwargs))
        return _SSEStream(events)

    monkeypatch.setattr("httpx.AsyncClient.stream", fake_stream)
    monkeypatch.setattr(settings, "openrouter_responses_url", "https://router.example/v1/responses")
    tracer = AITracer(openrouter_key="secret", openrouter_image_model="image-model")

    result = asyncio.run(tracer._mask_via_openrouter(b"source", "image/png", "make a mask"))

    assert result == PNG_BYTES
    method, url, request = requests[0]
    assert method == "POST"
    assert url == "https://router.example/v1/responses"
    assert request["json"] == {
        "model": "image-model",
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "make a mask"},
                {"type": "input_image", "image_url": "data:image/png;base64,c291cmNl"},
            ],
        }],
        "tools": [{"type": "image_generation", "model": "gpt-image-2.5-sunburst"}],
        "tool_choice": "required",
        "stream": True,
    }


def test_openrouter_responses_mask_returns_none_without_image(monkeypatch):
    def fake_stream(_client, _method, _url, **_kwargs):
        return _SSEStream(_completed_event([{"type": "message", "content": []}]))

    monkeypatch.setattr("httpx.AsyncClient.stream", fake_stream)
    monkeypatch.setattr(settings, "openrouter_responses_url", "https://router.example/v1/responses")
    tracer = AITracer(openrouter_key="secret", openrouter_image_model="image-model")

    assert asyncio.run(tracer._mask_via_openrouter(b"source", "image/png", "make a mask")) is None


def test_openrouter_responses_surfaces_stream_failure(monkeypatch):
    def fake_stream(_client, _method, _url, **_kwargs):
        return _SSEStream(_events([
            {"type": "response.failed", "response": {"error": {"message": "provider failed"}}},
        ]))

    monkeypatch.setattr("httpx.AsyncClient.stream", fake_stream)
    monkeypatch.setattr(settings, "openrouter_responses_url", "https://router.example/v1/responses")
    tracer = AITracer(openrouter_key="secret", openrouter_image_model="image-model")

    with pytest.raises(RuntimeError, match="provider failed"):
        asyncio.run(tracer._mask_via_openrouter(b"source", "image/png", "make a mask"))
