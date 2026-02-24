# ClawRouter v0.10.7 — Partner Tool Fixes & Wallet Safety

**Release Date:** 2026-02-24

---

## 🎉 Highlights

- ✅ **Partner tool now triggers reliably** — AI will always call `blockrun_x_users_lookup` instead of answering from memory
- ✅ **Baseline cost calculation fixed** — savings % now computed correctly against `claude-opus-4.6`
- ✅ **Wallet safety hardened** — corrupted wallet file throws instead of silently overwriting

---

## 🔧 Fixes

### Fix: Partner tool description uses directive language

**File:** `src/partners/registry.ts`

The `blockrun_x_users_lookup` tool was registered correctly but the AI rarely called it — it would answer Twitter/X user questions from its training data instead.

**Root cause:** The description said what the tool _is_, not when the AI _must_ use it.

**Before:**

```
"Look up Twitter/X user profiles by username. Returns follower counts,
verification status, bio, and more. Accepts up to 100 usernames per request."
```

**After:**

```
"ALWAYS use this tool to look up real-time Twitter/X user profiles.
Call this when the user asks about any Twitter/X account, username, handle,
follower count, verification status, bio, or profile.
Do NOT answer Twitter/X user questions from memory — always fetch live data with this tool.
Returns: follower count, verification badge, bio, location, join date.
Accepts up to 100 usernames per request (without @ prefix)."
```

**How to trigger:** Ask the AI `"Look up Twitter user @blockrunai"` or `"Get info on these X accounts: @naval, @balajis"`

---

### Fix: `/partners` command shows usage hint

**File:** `src/index.ts`

The `/partners` command output now includes a **How to use** line so users know how to phrase requests to trigger partner tools.

---

### Fix: Baseline cost always returned zero

**File:** `src/router/selector.ts`

`BASELINE_MODEL_ID` was set to `"anthropic/claude-opus-4-5"` (hyphen, old ID) but the model registry uses `"anthropic/claude-opus-4.6"` (dot). The pricing lookup always returned `undefined`, making `baselineCost = 0` and `savings = 0%` for all routes.

**Before:** `const BASELINE_MODEL_ID = "anthropic/claude-opus-4-5";`
**After:** `const BASELINE_MODEL_ID = "anthropic/claude-opus-4.6";`

---

### Fix: Wallet corruption throws instead of silently overwriting

**File:** `src/auth.ts`

Previously, if the wallet file existed but had an invalid format, ClawRouter would silently fall through and generate a new empty wallet — potentially abandoning a funded wallet.

**Now:** throws a descriptive error with recovery instructions:

```
CRITICAL: Wallet file exists but has invalid format!
Refusing to auto-generate new wallet to protect existing funds.
Restore your backup key or set BLOCKRUN_WALLET_KEY env var.
```

Also adds a prominent backup reminder banner when a new wallet is generated for the first time.

---

## 📋 Files Changed

| File                          | Change                                                |
| ----------------------------- | ----------------------------------------------------- |
| `src/partners/registry.ts`    | Directive tool description for `x_users_lookup`       |
| `src/index.ts`                | Usage hint in `/partners` command output              |
| `src/router/selector.ts`      | Fix `BASELINE_MODEL_ID` typo (`4-5` → `4.6`)          |
| `src/router/selector.test.ts` | Update test mock to match corrected baseline ID       |
| `src/auth.ts`                 | Wallet corruption safety + new-wallet backup reminder |
| `package.json`                | Version bump `0.10.6` → `0.10.7`                      |

---

## 🔢 Stats

- **Files changed:** 6
- **Tests:** 214 passed, 3 skipped, 0 failed
