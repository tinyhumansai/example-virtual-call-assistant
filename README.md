# example-virtual-call-assistant

This repository contains an example Electron + Next.js application (“VideoAgent”) that demonstrates how to integrate the TinyHumans Memory API SDK (`@tinyhumansai/neocortex`) for persistent memory and recall.

## What the TinyHumans SDK is used for

VideoAgent integrates the SDK to provide “memory” across calls by:

1. Inserting conversation artifacts into TinyHumans Memory
   - Finalized transcript segments are stored under a per-session namespace.
   - Meeting summaries are stored under a long-term meetings namespace.
   - Company knowledge-base document chunks are optionally mirrored into a long-term company-kb namespace.

2. Querying and recalling memory during AI generation
   - Before creating meeting insights or answering questions, the app retrieves relevant memory context (session + long-term + company-kb) and includes it in the LLM system prompt.

3. Cleaning up ephemeral session memory
   - When a session resets, the app deletes the per-session namespace to avoid keeping short-lived transcript data indefinitely.

If the TinyHumans configuration is not provided (no `MEMORY_API_TOKEN`), the app gracefully falls back to its local behavior (e.g., local KB retrieval).

## Namespaces and scopes

Memory is organized using a consistent namespace prefix (configured via `MEMORY_NAMESPACE_PREFIX`):

- Per-session transcript memory: `${prefix}:session:${sessionId}`
- Long-term meeting summaries: `${prefix}:meetings:longterm`
- Long-term company KB chunks: `${prefix}:company-kb:longterm`

## Where to look in the app code

- Memory client wrapper: `intelligent-videocall-assistant/electron/services/memory-store.ts`
- Memory-aware prompt building (query + recall): `intelligent-videocall-assistant/electron/services/ai-engine.ts`
- Transcript insertion lifecycle: `intelligent-videocall-assistant/electron/ipc/audio.ipc.ts`
- Session reset + post-meeting summary insertion: `intelligent-videocall-assistant/electron/ipc/ai.ipc.ts`
- Optional company KB mirroring into memory: `intelligent-videocall-assistant/electron/services/kb-service.ts`

## Required configuration

Set these environment variables (see `intelligent-videocall-assistant/.env.example`):

- `MEMORY_API_TOKEN` (required)
- `MEMORY_BASE_URL` (optional; SDK default is used if unset)
- `MEMORY_NAMESPACE_PREFIX` (optional; defaults to `video-agent`)

## App documentation

For running the app, UI behavior, and Electron/Next setup details, refer to:

`intelligent-videocall-assistant/README.md`