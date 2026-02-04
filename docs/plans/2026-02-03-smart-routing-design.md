# Phase 2: Client-Side Smart Routing Design

## Problem

OpenClaw's #1 pain point ([#1594](https://github.com/openclaw/openclaw/issues/1594), 18 comments): token costs. Simple queries go to GPT-4o at $10/M output tokens when Gemini Flash could handle them at $0.60/M. No cost-aware model selection.

Phase 1 solved API key management (one wallet for 30+ models). Phase 2 solves cost optimization by routing queries to the cheapest capable model.

## Why Client-Side

Every existing smart router (OpenRouter, LiteLLM, etc.) runs server-side. The routing logic is proprietary — users can't see why a model was chosen or customize the rules.

BlockRun's structural advantage: **x402 per-model transparent pricing**. Each model has an independent price visible in the 402 response. This means the routing decision can live in the open-source plugin where it's inspectable, customizable, and auditable.

| | Server-side (OpenRouter) | Client-side (BlockRun) |
|---|---|---|
| Routing logic | Proprietary black box | Open-source in plugin |
| Pricing | Bundled, opaque | Per-model, transparent via x402 |
| Customization | None | Operators edit config |
| Trust model | "Trust us" | "Read the code" |

## Research Summary

Analyzed 9 open-source smart routing implementations. Three classification approaches emerged:

1. **Pure heuristic** (keyword + length + regex) — Zero cost, < 1ms, but brittle
2. **Small LLM classifier** (DistilBERT, Granite 350M, 8B model) — Better accuracy, 20-500ms overhead
3. **Hybrid** (rules first, LLM only for ambiguous cases) — Best of both worlds

The hybrid approach (from octoroute, smart-router) handles 70-80% of requests via rules in < 1ms, and only sends ambiguous cases to a cheap LLM classifier. This is what we'll implement.

## Architecture

```
pi-ai request
     |
     v
┌─────────────────────────────────────────────────┐
│              Plugin Router (src/router.ts)        │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │  Step 1: Rule-Based Classifier (< 1ms)      │ │
│  │  • Token count heuristic                     │ │
│  │  • Code detection (backticks, keywords)      │ │
│  │  • Reasoning markers                         │ │
│  │  • Length-based bucketing                     │ │
│  │  • Returns: tier or AMBIGUOUS                │ │
│  └─────────────────────┬───────────────────────┘ │
│                        |                          │
│          ┌─────────────┴──────────────┐          │
│          |                            |           │
│     tier found                   AMBIGUOUS        │
│          |                            |           │
│          |  ┌─────────────────────────┴────────┐ │
│          |  │  Step 2: LLM Classifier (~200ms) │ │
│          |  │  • Send to gemini-flash (cheapest)│ │
│          |  │  • "Classify: SIMPLE/MEDIUM/..."  │ │
│          |  │  • Cache classification result    │ │
│          |  └─────────────────────────┬────────┘ │
│          |                            |           │
│          └────────────┬───────────────┘           │
│                       |                           │
│  ┌────────────────────┴────────────────────────┐ │
│  │  Step 3: Tier → Model Selection             │ │
│  │  • Look up cheapest model for tier          │ │
│  │  • Check against routing_config.json        │ │
│  └────────────────────┬────────────────────────┘ │
│                       |                           │
│  ┌────────────────────┴────────────────────────┐ │
│  │  Step 4: RoutingDecision metadata           │ │
│  │  { model, tier, confidence, reasoning }     │ │
│  └────────────────────┬────────────────────────┘ │
│                       |                           │
└───────────────────────┼─────────────────────────┘
                        |
                        v
               BlockRun API (x402)
                        |
                        v
                  LLM Provider
```

## Classification Tiers

Four tiers, not three. The REASONING tier is distinct from COMPLEX because reasoning tasks need different models (o3, gemini-pro) than general complex tasks (gpt-4o, sonnet-4).

| Tier | Description | Example Queries |
|------|-------------|-----------------|
| **SIMPLE** | Short factual Q&A, translations, definitions | "What's the capital of France?", "Translate hello to Spanish" |
| **MEDIUM** | Summaries, explanations, moderate code | "Summarize this article", "Write a Python function to sort a list" |
| **COMPLEX** | Multi-step code, system design, creative writing | "Build a React component with tests", "Design a REST API" |
| **REASONING** | Proofs, multi-step logic, mathematical reasoning | "Prove this theorem", "Solve step by step", "Debug this algorithm" |

## Rule-Based Classifier

The classifier scores each request across multiple dimensions, then maps the aggregate score to a tier. If the score falls in an ambiguous zone, it returns `null` to trigger the LLM classifier.

### Scoring Dimensions

| Dimension | Signal | Score Impact |
|-----------|--------|-------------|
| **Token count** | Estimated via `text.length / 4` | < 50 tokens: -2, > 500 tokens: +2 |
| **Code presence** | Backticks, `function`, `class`, `import`, `SELECT`, `{`, `}` | +2 if code detected |
| **Reasoning markers** | "prove", "step by step", "derive", "theorem", "why does", "chain of thought" | +3 (routes to REASONING) |
| **Technical terms** | "algorithm", "optimize", "architecture", "distributed", "kubernetes" | +1 per 2 matches |
| **Creative markers** | "write a story", "compose", "brainstorm", "generate ideas" | +1 |
| **Simple indicators** | "what is", "define", "translate", "yes or no", "hello" | -2 |
| **Multi-step patterns** | "first...then", numbered lists, "step 1" | +1 |
| **Question count** | Multiple `?` in input | > 3 questions: +1 |

### Score → Tier Mapping

```
Score <= 0     → SIMPLE     (confidence: 0.85-0.95)
Score 1-2      → AMBIGUOUS  (triggers LLM classifier)
Score 3-4      → MEDIUM     (confidence: 0.75-0.85)
Score 5-6      → COMPLEX    (confidence: 0.70-0.85)
Score 7+       → REASONING  (confidence: 0.70-0.80)
                 OR if reasoning markers detected directly → REASONING (confidence: 0.90)
```

The "ambiguous zone" (score 1-2) is where heuristics are unreliable. These requests get routed to the LLM classifier for a more accurate decision.

### Special Case Overrides (Before Scoring)

| Condition | Override | Reason |
|-----------|----------|--------|
| Explicit `model` in request | Skip routing entirely | User knows what they want |
| Input > 100K tokens | Force COMPLEX tier | Large context = expensive regardless |
| System prompt contains "JSON" or "structured" | Minimum MEDIUM tier | Structured output needs capable models |

## LLM Classifier (Fallback)

When the rule-based classifier returns AMBIGUOUS, we send a classification request to the cheapest available model.

### Classifier Prompt

```
You are a query complexity classifier. Classify the user's query into exactly one category.

Categories:
- SIMPLE: Factual Q&A, definitions, translations, short answers
- MEDIUM: Summaries, explanations, moderate code generation
- COMPLEX: Multi-step code, system design, creative writing, analysis
- REASONING: Mathematical proofs, formal logic, step-by-step problem solving

User query (first 500 chars):
{truncated_prompt}

Respond with ONLY one word: SIMPLE, MEDIUM, COMPLEX, or REASONING.
```

### Implementation Details

- **Model**: `google/gemini-2.5-flash` ($0.15/$0.60 per M tokens) — cheapest model available
- **Max tokens**: 10 (we only need one word)
- **Temperature**: 0 (deterministic classification)
- **Prompt truncation**: First 500 characters only (prevents prompt injection, keeps cost near zero)
- **Cost per classification**: ~$0.00003 (150 input tokens x $0.15/M + 1 output token x $0.60/M)
- **Latency**: ~200-400ms (acceptable — only triggered for ambiguous cases)
- **Parsing**: Word-boundary matching for SIMPLE/MEDIUM/COMPLEX/REASONING, with refusal detection
- **Fallback on parse failure**: Default to MEDIUM tier (safe middle ground)

### Classification Cache

Cache classification results keyed by a hash of the first 500 characters of the prompt. TTL: 1 hour. This prevents re-classifying identical or near-identical prompts.

```typescript
// Simple in-memory cache
const classificationCache = new Map<string, { tier: Tier; expires: number }>();
```

## Tier → Model Mapping

Each tier maps to a primary model and a fallback chain. All configurable via `routing_config.json`.

### Default Mapping

| Tier | Primary Model | Cost (input/output per M) | Fallback Chain |
|------|--------------|---------------------------|----------------|
| **SIMPLE** | `google/gemini-2.5-flash` | $0.15 / $0.60 | deepseek-chat → gpt-4o-mini |
| **MEDIUM** | `deepseek/deepseek-chat` | $0.28 / $0.42 | gemini-flash → gpt-4o-mini |
| **COMPLEX** | `anthropic/claude-sonnet-4` | $3.00 / $15.00 | openai/gpt-4o → google/gemini-2.5-pro |
| **REASONING** | `openai/o3` | $2.00 / $8.00 | google/gemini-2.5-pro → anthropic/claude-sonnet-4 |

### Cost Savings Estimate

Assuming a typical distribution of agent queries:

| Tier | % of Queries | Cost (per M output) | vs GPT-4o ($10/M) |
|------|-------------|--------------------|--------------------|
| SIMPLE | 40% | $0.60 | **94% savings** |
| MEDIUM | 30% | $0.42 | **96% savings** |
| COMPLEX | 20% | $15.00 | 50% more (but better quality) |
| REASONING | 10% | $8.00 | **20% savings** |
| **Weighted average** | | **$3.67/M** | **63% savings vs always GPT-4o** |

## RoutingDecision Object

Every routed request includes metadata about the routing decision. This is returned to the agent alongside the LLM response.

```typescript
type RoutingDecision = {
  model: string;           // "deepseek/deepseek-chat"
  tier: Tier;              // "MEDIUM"
  confidence: number;      // 0.85
  method: "rules" | "llm"; // How the decision was made
  reasoning: string;       // "Token count 120, no code detected, no reasoning markers"
  costEstimate: string;    // "$0.0004"
  baselineCost: string;    // "$0.0095" (what GPT-4o would have cost)
  savings: string;         // "95.8%"
};
```

This metadata can be logged, displayed in dashboards, or used by operators to tune routing behavior.

## Routing Config (routing_config.json)

All routing parameters are externalized to a JSON config file. Operators can customize without code changes.

```json
{
  "version": "1.0",

  "classifier": {
    "ambiguousZone": [1, 2],
    "llmModel": "google/gemini-2.5-flash",
    "llmMaxTokens": 10,
    "llmTemperature": 0,
    "promptTruncationChars": 500,
    "cacheTtlMs": 3600000
  },

  "scoring": {
    "tokenCountThresholds": { "simple": 50, "complex": 500 },
    "codeKeywords": ["function", "class", "import", "def", "SELECT", "async", "await"],
    "reasoningKeywords": ["prove", "theorem", "derive", "step by step", "chain of thought", "formally"],
    "simpleKeywords": ["what is", "define", "translate", "hello", "yes or no", "capital of"],
    "technicalKeywords": ["algorithm", "optimize", "architecture", "distributed", "kubernetes", "microservice"],
    "creativeKeywords": ["story", "poem", "compose", "brainstorm", "creative"]
  },

  "tiers": {
    "SIMPLE": {
      "primary": "google/gemini-2.5-flash",
      "fallback": ["deepseek/deepseek-chat", "openai/gpt-4o-mini"]
    },
    "MEDIUM": {
      "primary": "deepseek/deepseek-chat",
      "fallback": ["google/gemini-2.5-flash", "openai/gpt-4o-mini"]
    },
    "COMPLEX": {
      "primary": "anthropic/claude-sonnet-4",
      "fallback": ["openai/gpt-4o", "google/gemini-2.5-pro"]
    },
    "REASONING": {
      "primary": "openai/o3",
      "fallback": ["google/gemini-2.5-pro", "anthropic/claude-sonnet-4"]
    }
  },

  "overrides": {
    "maxTokensForceComplex": 100000,
    "structuredOutputMinTier": "MEDIUM"
  }
}
```

## Fallback Behavior

When a model fails (rate limit, provider error, etc.), the router walks the fallback chain for that tier.

```
Request → Primary model → 429 rate limited
                          → Try fallback[0]
                          → 200 OK (response from fallback model)
```

The fallback is **per-tier**, not global. A COMPLEX query falls back to other capable models (gpt-4o, gemini-pro), not to cheap models that would produce poor results.

If all models in a tier's fallback chain fail, the router returns a structured error:

```json
{
  "error": {
    "message": "All models for COMPLEX tier unavailable. Tried: claude-sonnet-4, gpt-4o, gemini-2.5-pro",
    "type": "all_providers_unavailable",
    "tier": "COMPLEX",
    "attempted": ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-pro"]
  }
}
```

## File Structure

```
src/
├── index.ts              # Plugin entry (unchanged)
├── provider.ts           # Provider registration (unchanged)
├── proxy.ts              # x402 proxy (add routing hook)
├── models.ts             # Model definitions + pricing (unchanged)
├── auth.ts               # Wallet + keystore (unchanged)
├── types.ts              # Type definitions (add routing types)
├── router/
│   ├── index.ts          # Router entry — classify() and route()
│   ├── rules.ts          # Rule-based classifier
│   ├── llm-classifier.ts # LLM fallback classifier
│   ├── selector.ts       # Tier → model selection + fallback
│   └── types.ts          # RoutingDecision, Tier, ScoringResult
└── routing_config.json   # Declarative routing config
```

## Integration with Proxy

The router hooks into the existing proxy flow at `proxyRequest()` in `proxy.ts`:

```
Before (Phase 1):
  pi-ai → proxy → BlockRun API (with whatever model pi-ai specified)

After (Phase 2):
  pi-ai → proxy → router.classify(prompt) → router.selectModel(tier)
                → BlockRun API (with router-selected model)
                → RoutingDecision metadata attached to response
```

When the user sets `model: "blockrun/auto"`, the proxy invokes the router. When the user pins a specific model (e.g., `openai/gpt-4o`), the proxy skips routing and forwards directly.

## Cost Savings UX

The plugin logs routing decisions on each request:

```
[BlockRun] Routed to deepseek-chat (MEDIUM, confidence: 0.85)
           Cost: $0.0004 | Baseline: $0.0095 | Saved: 95.8%
```

The `openclaw blockrun status` command includes cumulative savings:

```
Wallet:    0xABC123...
Balance:   42.50 USDC (Base)
Today:     $3.21 spent  ($5.00 daily limit)
Routing:   Smart routing saved $8.42 today (72% vs always GPT-4o)
```

## Operator Customization

Operators can override any part of the routing:

```yaml
# openclaw.yaml
plugins:
  - id: "@blockrun/openclaw"
    config:
      # Use smart routing
      model: "blockrun/auto"

      # Or customize routing
      routing:
        # Change the default COMPLEX model
        tiers:
          COMPLEX:
            primary: "openai/gpt-4o"
        # Add custom keywords
        scoring:
          reasoningKeywords: ["proof", "theorem", "formal verification"]
```

## What This Does NOT Include (Future)

- **Semantic caching** — Too heavy for client-side (needs embedding model + vector store). If added, goes server-side.
- **Quality feedback loop** — Learning from past routing decisions to improve accuracy. Requires server-side analytics.
- **Real-time provider health** — Client can't monitor all providers. Server provides this via API.
- **Conversation context** — Current design is per-message. Future: track conversation complexity over time.
