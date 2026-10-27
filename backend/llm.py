"""LLM access without a vendor SDK.

Every provider is a plain streaming HTTP call, so the backend runs anywhere
with nothing but an API key. Keys come from the environment:

    OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
    LLM_API_KEY   (fallback used for whichever provider is selected)

A user can also point `provider: "local"` at any OpenAI-compatible server
(Ollama, LM Studio, vLLM, OpenRouter), configured per device in Settings.
"""
from __future__ import annotations

import json
import os
from typing import AsyncIterator, Optional

import httpx

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-latest",
    "gemini": "gemini-2.0-flash",
}

TIMEOUT = httpx.Timeout(180.0, connect=15.0)


class LLMError(RuntimeError):
    """A provider rejected the request or could not be reached."""


def api_key(provider: str) -> str:
    return (os.environ.get(f"{provider.upper()}_API_KEY")
            or os.environ.get("LLM_API_KEY")
            or "").strip()


def default_model(provider: str) -> str:
    return os.environ.get("LLM_MODEL") or DEFAULT_MODELS.get(provider, DEFAULT_MODELS["openai"])


async def _raise_for(r: httpx.Response, provider: str) -> None:
    if r.status_code < 400:
        return
    body = (await r.aread()).decode(errors="ignore")[:400]
    raise LLMError(f"{provider} error {r.status_code}: {body}")


async def _sse_json(lines: AsyncIterator[str]):
    """Yield the JSON payload of every `data:` line of an SSE stream."""
    async for line in lines:
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            if payload == "[DONE]":
                return
            continue
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


async def _openai_compatible(base_url: str, key: str, model: str, messages: list[dict],
                             provider: str) -> AsyncIterator[str]:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        async with hc.stream("POST", base_url.rstrip("/") + "/chat/completions",
                             headers=headers,
                             json={"model": model, "messages": messages, "stream": True}) as r:
            await _raise_for(r, provider)
            async for chunk in _sse_json(r.aiter_lines()):
                choices = chunk.get("choices") or [{}]
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta


async def _anthropic(key: str, model: str, system: str, messages: list[dict]) -> AsyncIterator[str]:
    body = {
        "model": model,
        "max_tokens": int(os.environ.get("LLM_MAX_TOKENS", 2048)),
        "stream": True,
        "messages": [m for m in messages if m["role"] != "system"],
    }
    if system:
        body["system"] = system
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        async with hc.stream("POST", "https://api.anthropic.com/v1/messages",
                             headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                      "content-type": "application/json"},
                             json=body) as r:
            await _raise_for(r, "anthropic")
            async for chunk in _sse_json(r.aiter_lines()):
                if chunk.get("type") == "content_block_delta":
                    text = (chunk.get("delta") or {}).get("text")
                    if text:
                        yield text


async def _gemini(key: str, model: str, system: str, messages: list[dict]) -> AsyncIterator[str]:
    contents = [{"role": "model" if m["role"] == "assistant" else "user",
                 "parts": [{"text": m["content"]}]} for m in messages if m["role"] != "system"]
    body: dict = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
           f"?alt=sse&key={key}")
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        async with hc.stream("POST", url, json=body) as r:
            await _raise_for(r, "gemini")
            async for chunk in _sse_json(r.aiter_lines()):
                for cand in chunk.get("candidates") or []:
                    for part in (cand.get("content") or {}).get("parts") or []:
                        if part.get("text"):
                            yield part["text"]


async def stream(system: str, messages: list[dict], provider: str = "openai",
                 model: Optional[str] = None) -> AsyncIterator[str]:
    """Yield text deltas for a cloud provider. `messages` excludes the system prompt."""
    model = (model or "").strip() or default_model(provider)
    key = api_key(provider)
    if not key:
        raise LLMError(
            f"No API key for '{provider}'. Set {provider.upper()}_API_KEY (or LLM_API_KEY) on the "
            f"backend, or switch to a local model in Settings.")
    if provider == "anthropic":
        gen = _anthropic(key, model, system, messages)
    elif provider == "gemini":
        gen = _gemini(key, model, system, messages)
    else:
        base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        payload = ([{"role": "system", "content": system}] if system else []) + messages
        gen = _openai_compatible(base, key, model, payload, "openai")
    async for delta in gen:
        yield delta


async def stream_local(base_url: str, model: str, key: str, system: str,
                       messages: list[dict]) -> AsyncIterator[str]:
    """Any OpenAI-compatible endpoint on the user's own machine or LAN."""
    if not base_url or not model:
        raise LLMError("Local LLM is not configured. Set the base URL and model in Settings.")
    payload = ([{"role": "system", "content": system}] if system else []) + messages
    async for delta in _openai_compatible(base_url, key, model, payload, "local"):
        yield delta


async def complete(system: str, messages: list[dict], provider: str = "openai",
                   model: Optional[str] = None) -> str:
    out = ""
    async for delta in stream(system, messages, provider, model):
        out += delta
    return out
