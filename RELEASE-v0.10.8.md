# ClawRouter v0.10.8 — Fix Partner Tool OpenClaw API Contract

**Release Date:** 2026-02-24

---

## 🐛 Bug Fix: Partner Tools Now Work Correctly in OpenClaw

Three API contract mismatches between ClawRouter and OpenClaw's tool execution interface, discovered and reported by a user.

### Bug 1: `inputSchema` → `parameters`

OpenClaw expects tool parameter schema under the key `parameters`, but ClawRouter was using `inputSchema`. The model had no way to know how to pass arguments.

### Bug 2: `execute(args)` → `execute(toolCallId, params)`

OpenClaw calls `execute(toolCallId, params)` — the first argument is the tool call ID, the second is the actual parameters. ClawRouter's `execute(args)` was receiving `toolCallId` as the parameter object and sending it to the upstream API.

### Bug 3: Return format

OpenClaw expects `{ content: [{ type: "text", text: "..." }], details: ... }`. ClawRouter was returning raw JSON, which OpenClaw couldn't display.

---

## 📋 File Changed

| File                    | Change                                      |
| ----------------------- | ------------------------------------------- |
| `src/partners/tools.ts` | Fix all 3 OpenClaw tool API contract issues |
| `package.json`          | Version bump `0.10.7` → `0.10.8`            |

---

## 🔢 Stats

- **Tests:** 214 passed, 3 skipped, 0 failed
