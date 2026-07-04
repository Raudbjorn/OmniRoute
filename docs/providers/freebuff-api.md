# Freebuff Provider — API Reference

> Developer reference for the OmniRoute HTTP surface exposed by the
> Freebuff (Codebuff Free Tier) provider. Complements the
> [user guide](./freebuff.md).

## Overview

The Freebuff provider is **enabled by default**. OmniRoute exposes it
on the following routes:

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/v1/chat/completions` | POST | Bearer OmniRoute | OpenAI-compatible streaming chat |
| `/v1/messages` | POST | Bearer OmniRoute | Anthropic-compatible streaming chat |
| `/api/v1/providers/freebuff/quota` | GET | Bearer OmniRoute | Current quota state |
| `/api/v1/providers/freebuff/streak` | GET | Bearer OmniRoute | Gamification streak |
| `/api/v1/providers/freebuff/login/start` | POST | Bearer OmniRoute | Start PKCE flow |
| `/api/v1/providers/freebuff/login/status` | GET | Bearer OmniRoute | Poll PKCE flow status |
| `/api/v1/providers/freebuff/session` | DELETE | Bearer OmniRoute | Release active session |

All endpoints accept and return `application/json` unless noted
otherwise. The two chat endpoints return `text/event-stream` when
`stream: true` is set on the request.

## Chat completions — OpenAI wire format

```http
POST /v1/chat/completions
Authorization: Bearer <omniroute-api-key>
Content-Type: application/json

{
  "model": "mimo/mimo-v2.5",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": true
}
```

**Response (non-streaming):** standard OpenAI `chat.completion` object.

**Response (streaming):** `text/event-stream` of `chat.completion.chunk`
objects terminated by `data:n\n\n`.

Chunk shape:
```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion.chunk",
  "created": 1719700000,
  "model": "mimo/mimo-v2.5",
  "choices": [{
    "index": 0,
    "delta": { "role": "assistant", "content": "Hello" },
    "finish_reason": null
  }]
}
```

For reasoning models the delta carries `reasoning_content` in the
OpenAI o1-style:
```json
"delta": { "reasoning_content": "Let me think..." }
```

For tool calls the delta carries `tool_calls`:
```json
"delta": {
  "tool_calls": [{
    "index": 0,
    "id": "call_abc",
    "type": "function",
    "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" }
  }]
}
```

## Messages — Anthropic wire format

```http
POST /v1/messages
Authorization: Bearer <omniroute-api-key>
Content-Type: application/json
anthropic-version: 2023-06-01

{
  "model": "z-ai/glm-5.2",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

**Response (streaming):** `text/event-stream` of Anthropic message
events in the canonical order:

1. `message_start`
2. `content_block_start` (one or more — text, thinking, or tool_use)
3. `content_block_delta` (zero or more per block)
4. `content_block_stop` (one per opened block)
5. `message_delta` (carries `stop_reason` and final usage)
6. `message_stop`

For reasoning models the block is of type `thinking` with `thinking_delta`
events.

For tool calls the block is of type `tool_use` with `input_json_delta`
events.

## Meta endpoints

### GET `/api/v1/providers/freebuff/quota`

Returns:
```json
{
  "provider": "freebuff",
  "quota": {
    "sessionsUsedToday": 3,
    "sessionsRemainingToday": 7,
    "waitingRoomPosition": null,
    "resetAt": "2026-07-01T00:00:00.000Z",
    "accessTier": "limited"
  }
}
```

### GET `/api/v1/providers/freebuff/streak`

Returns:
```json
{
  "provider": "freebuff",
  "streak": {
    "currentStreak": 5,
    "longestStreak": 12,
    "lastCheckInAt": "2026-06-29T18:00:00.000Z",
    "bonusCredits": 2
  }
}
```

### POST `/api/v1/providers/freebuff/login/start`

Returns:
```json
{
  "provider": "freebuff",
  "login": {
    "flowId": "<uuid>",
    "loginUrl": "https://codebuff.com/oauth/authorize?...",
    "expiresAt": "2026-07-01T00:00:00.000Z"
  }
}
```

### GET `/api/v1/providers/freebuff/login/status?flowId=<uuid>`

Returns:
```json
{
  "provider": "freebuff",
  "login": {
    "flowId": "<uuid>",
    "status": "completed",
    "authToken": "<uuid>",
    "fingerprintId": "enhanced-...",
    "userId": "<uuid>",
    "userEmail": "user@example.com"
  }
}
```

`status` is one of `pending`, `completed`, `expired`, `error`. When
`status === "error"` the response includes an `error` field with a
human-readable message.

### DELETE `/api/v1/providers/freebuff/session`

Releases the active session. Returns `204 No Content` on success.

## Custom headers

### Request headers

| Header | Effect |
|---|---|
| `x-omniroute-include-subagent-output: 1` | When set, `subagent-response-chunk` events are emitted as visible content (otherwise they are dropped from the stream and surfaced only in the `x-omniroute-subagent-trace` response header). |

### Response headers

| Header | Effect |
|---|---|
| `x-omniroute-subagent-trace` | Debug-only. Carries a JSON array of sub-agent chunks emitted during the stream, regardless of whether they were visible in the body. |

## Error responses

The transformer maps upstream Codebuff errors to clean client-facing
messages. Stack traces and internal codes are stripped.

| HTTP | When | Body shape |
|---|---|---|
| `400` | Invalid request body | `{"error": {"message": "...", "type": "validation_error", "issues": [...]}}` |
| `401` | Missing / invalid `Authorization` | `{"error": {"message": "Authentication required", "type": "auth_required"}}` |
| `429` | Codebuff rate limit | `{"error": {"message": "Codebuff rate limit reached. Wait a few seconds...", "type": "rate_limited"}}` |
| `451` | Region blocked by Codebuff | `{"error": {"message": "Request blocked by Codebuff for region: ...", "type": "country_blocked"}}` |
| `501` | Provider backend not yet wired | `{"error": {"message": "...", "type": "not_implemented", "code": "CHUNK_4_PENDING"}}` |
| `502` | Upstream Codebuff unreachable / failed | `{"error": {"message": "...", "type": "upstream_error"}}` |
| `500` | Unexpected internal error | `{"error": {"message": "Internal error", "type": "internal_error"}}` |

## Model catalog

The provider exposes the following models. See
`src/lib/providers/freebuff/models.ts` for the canonical source.

| ID | Tier | Premium | Notes |
|---|---|---|---|
| `mimo/mimo-v2.5` | standard | no | Default free model (128k context) |
| `mimo/mimo-v2.5-pro` | pro | yes | — |
| `minimax/minimax-m3` | pro | yes | Bedrock upstream |
| `moonshotai/kimi-k2.6` | standard | yes | Limited-tier accessible (explicit override) |
| `deepseek/deepseek-v4-flash` | lite | no | Text only |
| `deepseek/deepseek-v4-pro` | pro | yes | "Collects data for training" warning |
| `z-ai/glm-5.2` | pro | yes | Requires referral (1M context) |
| `minimax/minimax-m2.7` | lite | no | "WK" alias, LITE mode |

## See also

- [freebuff.md](./freebuff.md) — User guide with setup instructions.
- [`src/lib/providers/freebuff/metaService.ts`](../../src/lib/providers/freebuff/metaService.ts) — Response schemas (zod).
