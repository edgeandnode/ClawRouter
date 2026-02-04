# @blockrun/openclaw

LLM cost optimization for OpenClaw. One wallet, 30+ models, smart routing, spend controls. Pay per request with x402 USDC micropayments — no account needed.

## The Problem

OpenClaw operators are bleeding money on LLM costs.

The #1 complaint in the OpenClaw community ([#1594](https://github.com/openclaw/openclaw/issues/1594), 18 comments): users on $100/month plans hit their limits in 30 minutes. Context accumulates, token costs explode, and operators have zero visibility into where the money goes.

The related pain points:
- **Silent failures burn money** ([#2202](https://github.com/openclaw/openclaw/issues/2202)) — When rate limits hit, the system retries in a loop, each retry burning tokens. No error message, no fallback.
- **API key hell** ([#3713](https://github.com/openclaw/openclaw/issues/3713), [#7916](https://github.com/openclaw/openclaw/issues/7916)) — Operators juggle keys from OpenAI, Anthropic, Google, DeepSeek. Each with different billing, different limits, different dashboards.
- **No smart routing** ([#4658](https://github.com/openclaw/openclaw/issues/4658)) — Simple queries go to GPT-4o at $10/M output tokens when Gemini Flash could handle them at $0.60/M. No cost-aware model selection.

## The Solution

BlockRun gives OpenClaw operators one wallet for 30+ models with automatic cost optimization. No account, no API key — your wallet signs a USDC micropayment on Base for each request.

```bash
# Install the provider plugin
openclaw plugin install @blockrun/openclaw

# That's it — plugin auto-generates a wallet on first run
# Or bring your own:
export BLOCKRUN_WALLET_KEY=0x...

# Set your model (or let smart routing choose)
openclaw config set model blockrun/auto
```

### What You Get

| Feature | What It Does |
|---------|-------------|
| **One wallet, 30+ models** | OpenAI, Anthropic, Google, DeepSeek, xAI — all through one wallet |
| **Smart routing** | Auto-routes queries to the cheapest model that can handle them |
| **Spend controls** | Set daily/weekly/monthly budgets. Hard stop when limit hit — no surprise bills |
| **Graceful fallback** | When one provider rate-limits, auto-switches to another. No silent failures |
| **Usage analytics** | Know exactly where every dollar goes — by model, by day, by conversation |

## Why BlockRun (vs OpenRouter, LiteLLM, etc.)

OpenRouter and LiteLLM are built for developers — you create an account, get an API key, prepay a balance, and manage it through a dashboard.

BlockRun is built for **agents**. The difference matters:

| | OpenRouter / LiteLLM | BlockRun |
|---|---|---|
| **Onboarding** | Human creates account, gets API key | Agent generates wallet on first run |
| **Payment** | Prepaid balance (custodial) | Per-request micropayment (non-custodial) |
| **Auth** | API key (shared secret) | Wallet signature (cryptographic proof) |
| **Custody** | Provider holds your money | USDC stays in YOUR wallet until spent |
| **Spend control** | Dashboard limits | On-chain balance + server-side budgets |
| **Smart routing** | Proprietary / closed | Open-source (RouteLLM-based) |

The thesis: as AI agents become autonomous, they need financial infrastructure designed for machines, not humans. An agent shouldn't need a human to sign up for OpenRouter and paste an API key. It should generate a wallet, receive USDC, and pay per request — all programmatically.

BlockRun is the payment layer agents use when they need to call LLMs.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Operator's OpenClaw Agent                    │
│                                                                 │
│  Agent sends standard OpenAI-format request                     │
│  (doesn't know about BlockRun)                                  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  @blockrun/openclaw provider plugin                       │  │
│  │  • Intercepts LLM requests                                │  │
│  │  • Smart routing: classifies query, picks cheapest model  │  │
│  │  • Forwards to BlockRun API with selected model           │  │
│  │  • Handles x402 micropayment                               │  │
│  │  • Streams response back                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     BlockRun API                                │
│                                                                 │
│  1. Verify x402 payment                                         │
│  2. Enforce spend limits                                        │
│  3. Forward to provider (OpenAI, Anthropic, Google, etc.)       │
│  4. Stream response back                                        │
│  5. Log usage + cost                                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

The plugin runs a local proxy between OpenClaw's LLM engine (pi-ai) and BlockRun's API. Pi-ai sees a standard OpenAI-compatible endpoint at `localhost`. It doesn't know about routing, payments, or spend limits — that's all handled transparently.

Smart routing runs **client-side in the plugin** (open-source, inspectable), not server-side behind a black box. The plugin classifies each query, picks the cheapest capable model, and sends the request to BlockRun API with that specific model. The per-model price is transparent in the x402 402 response — you see exactly what you're paying before your wallet signs.

## Smart Routing

When model is set to `blockrun/auto`, the plugin classifies each request **client-side** and routes to the cheapest model that can handle it:

```
Simple query ("What's 2+2?")
  → gemini-2.5-flash ($0.15/$0.60 per M tokens)

Medium query ("Summarize this article")
  → deepseek-chat ($0.28/$0.42 per M tokens)

Complex query ("Write a React component with tests")
  → gpt-4o or claude-sonnet-4 ($2.50-3.00/$10-15 per M tokens)

Reasoning task ("Prove this theorem")
  → o3 or gemini-2.5-pro ($1.25-2.00/$8-10 per M tokens)
```

### How It Routes

The plugin uses a **hybrid rules-first approach** — heuristic rules handle 70-80% of requests in < 1ms with zero cost. Only ambiguous cases fall through to a cheap LLM classifier.

```
Request → Rule-based scorer (< 1ms, free)
            ├── Clear classification → pick model → done
            └── Ambiguous (score 1-2) → LLM classifier (~200ms, ~$0.00003)
                                          └── classification → pick model → done
```

**Rule-based scorer** checks: token count, code presence (backticks, `function`, `class`), reasoning markers ("prove", "step by step"), technical terms, question count, and length. Each dimension adds/subtracts from a score that maps to a tier.

**LLM classifier** sends a truncated prompt (first 500 chars) to `gemini-2.5-flash` with `max_tokens: 10` and asks for one word: SIMPLE, MEDIUM, COMPLEX, or REASONING. Cost per classification: ~$0.00003.

Every routed request includes metadata:

```
[BlockRun] Routed to deepseek-chat (MEDIUM, confidence: 0.85)
           Cost: $0.0004 | Baseline: $0.0095 | Saved: 95.8%
```

### Estimated Savings

| Tier | % of Queries | Output Cost (per M) | vs Always GPT-4o ($10/M) |
|------|-------------|---------------------|--------------------------|
| SIMPLE | 40% | $0.60 | **94% savings** |
| MEDIUM | 30% | $0.42 | **96% savings** |
| COMPLEX | 20% | $15.00 | 50% more (but better quality) |
| REASONING | 10% | $8.00 | **20% savings** |
| **Weighted avg** | | **$3.67/M** | **63% savings** |

### Customization

All routing parameters live in `routing_config.json` — operators customize without code changes:

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/openclaw"
    config:
      model: "blockrun/auto"
      routing:
        tiers:
          COMPLEX:
            primary: "openai/gpt-4o"    # Override default model
        scoring:
          reasoningKeywords: ["proof", "theorem", "formal verification"]
```

Operators can also pin a specific model (`openclaw config set model openai/gpt-4o`) and still get spend controls + analytics.

## Payment

No account needed. Payment IS authentication via [x402](https://www.x402.org/).

### Auto-Generated Wallet

On first run, the plugin generates a wallet and saves the key locally:

```
$ openclaw plugin install @blockrun/openclaw
BlockRun wallet created: 0xABC123...
Fund with USDC on Base to start. Wallet key saved to ~/.openclaw/blockrun.key
```

Fund the printed address with USDC on Base:
- **Coinbase Onramp** — credit card → USDC on Base in one step
- **CEX withdraw** — send USDC from Coinbase/Binance to Base
- **Bridge** — move USDC from any chain to Base

### Bring Your Own Wallet

Already have a funded wallet? Set it directly:

```bash
export BLOCKRUN_WALLET_KEY=0x...your_private_key...
```

### How Pricing Works

Each request is priced upfront based on input tokens (known) + estimated max output tokens:

```
Price = (input_tokens × input_rate) + (max_output_tokens × output_rate)
```

The `max_output_tokens` comes from your request's `max_tokens` parameter (or the model's default). You pay for the worst case — if the actual response is shorter, the difference covers BlockRun's operating costs. No hidden fees, no surprise charges. The price is shown in the 402 response before your wallet signs anything.

### How Payment Works

The plugin handles x402 micropayments transparently:

```
Request → 402 (price: $0.003) → sign USDC → retry with payment → stream response
```

No signup, no dashboard, no credit card. Your wallet balance IS your account.

### Wallet Security

**Auto-generated wallets** are encrypted with a password and saved to `~/.openclaw/blockrun.keystore` (Foundry-style encrypted keystore). You'll be prompted for a password on first run. Set `BLOCKRUN_KEYSTORE_PASSWORD` env var for unattended operation.

**Bring-your-own wallets** via `BLOCKRUN_WALLET_KEY` are stored in plaintext — this is your responsibility to secure. For production, prefer the encrypted keystore or a hardware wallet.

## Spend Controls

Two layers of protection:

1. **Wallet balance** — hard ceiling enforced by the blockchain. You can't spend more USDC than you have.
2. **Operator budgets** — configurable limits enforced server-side by BlockRun API per wallet address. Prevents a runaway agent from draining your wallet.

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/openclaw"
    config:
      # Budget limits (enforced server-side by BlockRun API)
      dailyBudget: "5.00"      # Max $5/day
      monthlyBudget: "50.00"   # Max $50/month

      # Per-request limits
      maxCostPerRequest: "0.50" # No single request over $0.50
```

Budget config is synced to BlockRun API on plugin startup. When a limit is hit, the API returns a clear error:

```json
{
  "error": {
    "message": "Daily budget exceeded: $5.02 spent, limit $5.00",
    "type": "budget_exceeded",
    "code": 400
  }
}
```

The plugin surfaces this to the agent as a structured error instead of silently failing or retrying in a loop.

## Wallet Status

Check your wallet balance and spend:

```bash
openclaw blockrun status
```

```
Wallet:    0xABC123...
Balance:   42.50 USDC (Base)
Today:     $3.21 spent  ($5.00 daily limit)
This month: $28.40 spent ($50.00 monthly limit)
```

The plugin also logs balance on startup so you always know where you stand.

## Error Handling

Every failure returns a clear, structured error — no silent retries, no money burned.

| Scenario | Error Type | What Happens |
|----------|-----------|--------------|
| Wallet empty | `insufficient_funds` | "Insufficient USDC balance. Fund wallet 0xABC... on Base." |
| Daily budget hit | `budget_exceeded` | "Daily budget exceeded: $5.02 spent, limit $5.00" |
| Provider rate limit | `rate_limited` | Auto-fallback to another provider (if enabled) |
| Provider down | `provider_error` | Auto-fallback or clear error with provider name |
| Invalid model | `invalid_model` | "Model 'foo/bar' not available. See blockrun.ai/models" |

## Available Models

| Model | Input ($/1M tokens) | Output ($/1M tokens) | Context |
|-------|---------------------|----------------------|---------|
| **OpenAI** | | | |
| openai/gpt-5.2 | $1.75 | $14.00 | 400K |
| openai/gpt-5-mini | $0.25 | $2.00 | 200K |
| openai/gpt-4o | $2.50 | $10.00 | 128K |
| openai/o3 | $2.00 | $8.00 | 200K |
| **Anthropic** | | | |
| anthropic/claude-opus-4.5 | $15.00 | $75.00 | 200K |
| anthropic/claude-sonnet-4 | $3.00 | $15.00 | 200K |
| anthropic/claude-haiku-4.5 | $1.00 | $5.00 | 200K |
| **Google** | | | |
| google/gemini-2.5-pro | $1.25 | $10.00 | 1M |
| google/gemini-2.5-flash | $0.15 | $0.60 | 1M |
| **DeepSeek** | | | |
| deepseek/deepseek-chat | $0.28 | $0.42 | 128K |
| **xAI** | | | |
| xai/grok-3 | $3.00 | $15.00 | 131K |

Full list: 30+ models across 5 providers. See `src/models.ts`.

## Architecture

### Plugin (Open Source)

The OpenClaw provider plugin. Runs a local HTTP proxy with client-side smart routing between pi-ai and BlockRun's API.

```
src/
├── index.ts              # Plugin entry — register() and activate() lifecycle
├── provider.ts           # Registers "blockrun" provider in OpenClaw
├── proxy.ts              # Local HTTP proxy with x402 payment handling
├── models.ts             # Model definitions and pricing
├── auth.ts               # Wallet auto-generation, keystore, and key resolution
├── types.ts              # Type definitions
├── router/
│   ├── index.ts          # Router entry — classify() and route()
│   ├── rules.ts          # Rule-based classifier (heuristic scoring)
│   ├── llm-classifier.ts # LLM fallback classifier (gemini-flash)
│   ├── selector.ts       # Tier → model selection + fallback chains
│   └── types.ts          # RoutingDecision, Tier, ScoringResult
└── routing_config.json   # Declarative routing config (all thresholds + model assignments)
```

The plugin handles two things: **smart routing** (open-source, client-side, inspectable) and **x402 payment** (sign-per-request). Spend enforcement lives server-side in the BlockRun API where it can't be bypassed.

### BlockRun API (Closed Source)

The backend that handles billing, spend enforcement, and provider forwarding. Already exists — this plugin connects to it.

```
POST /api/v1/chat/completions    — OpenAI-compatible chat endpoint
GET  /api/v1/models              — List available models
GET  /api/v1/usage               — Usage analytics
GET  /api/v1/budget              — Current spend vs. limits
GET  /api/v1/balance             — Wallet balance + spend summary
```

## Market Context

- **OpenClaw**: 156K GitHub stars, most active open-source AI agent framework
- **#1 pain point**: Token costs ([#1594](https://github.com/openclaw/openclaw/issues/1594), 18 comments) — users hitting $100/month limits in 30 minutes
- **#2 pain point**: Silent failures burning money ([#2202](https://github.com/openclaw/openclaw/issues/2202), 7 comments)
- **#3 pain point**: API key management across multiple providers ([#3713](https://github.com/openclaw/openclaw/issues/3713))
- **#4 pain point**: No cost-aware model routing ([#4658](https://github.com/openclaw/openclaw/issues/4658))
- **Maintainer stance**: Payment and billing features should be third-party extensions ([#3465](https://github.com/openclaw/openclaw/issues/3465))

## Quick Start

```bash
# Install (auto-generates wallet on first run)
openclaw plugin install @blockrun/openclaw

# Fund the wallet with USDC on Base (address printed on install)
# Or bring your own:
export BLOCKRUN_WALLET_KEY=0x...

# Use smart routing
openclaw config set model blockrun/auto

# Or pick a specific model
openclaw config set model openai/gpt-4o
```

## Development

```bash
npm install
npm run build
npm run dev        # Watch mode
npm run typecheck
```

## Roadmap

- [x] Phase 1: Provider plugin — one wallet, 30+ models, x402 payment proxy
- [ ] Phase 2: Smart routing — client-side hybrid classifier, 4-tier model selection, 63% cost savings
- [ ] Phase 3: Graceful fallback — per-tier fallback chains, auto-switch on rate limit or provider error
- [ ] Phase 4: Spend controls — daily/monthly budgets, per-request limits, server-side enforcement
- [ ] Phase 5: Usage analytics — cost tracking dashboard at blockrun.ai
- [ ] Phase 6: Community launch — npm publish, OpenClaw PR, awesome-list

## License

MIT
