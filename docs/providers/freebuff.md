# Freebuff Provider

> Opt-in provider that wraps the Codebuff Free Tier CLI (`freebuff.exe`)
> to expose Codebuff-backed models through OmniRoute's standard
> OpenAI / Anthropic-compatible APIs.

## ⚠️ Terms of Service — User Responsibility

Freebuff routes requests through a **reverse-engineered** integration of
the Codebuff Free Tier. By enabling this provider you acknowledge that:

- You are solely responsible for compliance with Codebuff's Terms of
  Service.
- The fingerprint-replication technique used to authenticate may
  constitute a ToS circumvention depending on your jurisdiction.
- Codebuff may change their binary format, OAuth endpoints, or anti-fraud
  detection at any time, which can break this provider without notice.
- This provider is **not affiliated with, endorsed by, or supported by**
  Codebuff.

If you are not comfortable with the above, do not enable this provider.

## Prerequisites

1. A **Codebuff account** (free tier is sufficient). Sign up at
   <https://codebuff.com>.
2. The **`freebuff` CLI installed locally** on the machine where
   OmniRoute runs. Install via npm:
   ```bash
   npm install -g freebuff
   ```
   This downloads the `freebuff` binary to
   `~/.config/manicode/freebuff[.exe]` and registers the `freebuff`
   command in your shell.
3. **One successful `freebuff login`** on that machine so the OAuth
   flow has produced an `authToken` + `fingerprintId` pair. This can be
   done either before or after enabling OmniRoute's provider (see
   "Authentication" below).

## Enable the provider

Freebuff is **on by default**. The provider card is exposed under
`/providers/freebuff` immediately after a fresh install. No environment
variable is required.

To disable the provider, set the following in `.env` and restart
OmniRoute:

```bash
# .env
FREEBUFF_ENABLED=0
```

## Authentication

You have two paths to authenticate OmniRoute with Codebuff. Both are
exposed on the `/providers/freebuff` dashboard page.

### Path A — PKCE flow (recommended)

1. Click **Login with Codebuff**. OmniRoute starts a PKCE flow and opens
   the Codebuff authorization URL in a new browser tab.
2. Approve the request in the browser. Codebuff redirects back to
   OmniRoute's callback URL.
3. OmniRoute polls the flow status and, on completion, encrypts the
   resulting `authToken` + `fingerprintId` into the local connection
   store.

This path requires OmniRoute to be reachable from your browser — works
out of the box on `localhost`, requires port forwarding for remote
hosts.

### Path B — Paste `credentials.json` (fallback)

If the PKCE flow fails (anti-VPN detection, fingerprint mismatch on a
containerised/cloud deployment, etc.):

1. On the machine where you ran `freebuff login`, locate
   `~/.config/manicode/credentials.json`.
2. Copy the file contents to your clipboard.
3. On the dashboard, expand **Paste credentials.json**, paste the JSON,
   and click **Submit**.

OmniRoute validates the JSON shape and stores it encrypted. This path
bypasses the browser round-trip and is the recommended fallback for
Docker / WSL / cloud deployments where the browser runs on a different
host than OmniRoute.

## Quota and session state

The dashboard polls `/api/v1/providers/freebuff/quota` every **30
seconds** and renders:

| Field | Meaning |
|---|---|
| `sessionsUsedToday` | Prompts sent so far in the current UTC day. |
| `sessionsRemainingToday` | Prompts still available before the daily reset. |
| `accessTier` | `limited` (free) or `full` (paid). |
| `waitingRoomPosition` | Queue position when Codebuff throttles you. `null` when not queued. |
| `resetAt` | ISO-8601 timestamp of the next quota reset. |

The **Streak** card surfaces the gamification state (`currentStreak`,
`longestStreak`, `lastCheckInAt`, optional `bonusCredits`). Streak data
is fetched on demand — click **Refresh**.

## Limitations

- **Anti-VPN detection.** Codebuff blocks requests from datacenter IPs.
  If your OmniRoute server sits in AWS / GCP / Azure / Oracle, you will
  hit `country_blocked` errors. Workarounds: route through a residential
  proxy, or use a self-hosted VPS on a residential IP range.
- **Fingerprint mismatch.** The fingerprint is computed from the host's
  hardware identifiers (CPU, MAC, machine-id, …). When OmniRoute runs
  in Docker or a cloud VM, the fingerprint will not match the one
  produced by your local `freebuff login`. Use **Path B** (paste
  credentials) to bypass this.
- **Single concurrent session.** The Codebuff binary uses a PID-file
  lock — only one process can hold an active session at a time. If you
  see `409 Conflict`, sign out from the dashboard or from another
  running `freebuff` instance.
- **Rate limits.** Codebuff applies soft rate limits on top of the daily
  quota. If you hit `429`, OmniRoute surfaces the error to the client
  without retrying.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `FREEBUFF_ENABLED=0` set, page says "not enabled" | Provider explicitly disabled | Unset / remove `FREEBUFF_ENABLED` and restart OmniRoute |
| `country_blocked` errors | Datacenter IP blocked by Codebuff | Route through residential proxy |
| `fingerprint mismatch` on first PKCE attempt | Running OmniRoute in Docker / cloud | Use **Path B** instead |
| `409 Conflict` on first request | Another `freebuff` instance is running | Sign out or kill the other instance |
| All routes return `501 Not Implemented` | Provider backend not yet wired for this endpoint | Check OmniRoute release notes for the provider backend status |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FREEBUFF_ENABLED` | `1` (on) | Master switch. Set to `0` to disable the provider. |
| `FREEBUFF_USE_FREE_TIER` | `1` | Restrict the model catalog to free-tier models when set to `1`. |
| `FREEBUFF_OAUTH_CLIENT_ID` | (unset) | OAuth client id registered with Codebuff. Defaults to the bundled id when unset. |
| `FREEBUFF_OAUTH_TIMEOUT_MS` | `300000` | Timeout (ms) for the OAuth PKCE round-trip. |

## See also

- [freebuff-api.md](./freebuff-api.md) — Developer reference for the
  HTTP endpoints and SSE wire formats.
