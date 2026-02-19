#!/usr/bin/env node

// src/proxy.ts
import { createServer } from "http";
import { finished } from "stream";
import { privateKeyToAccount as privateKeyToAccount2 } from "viem/accounts";

// src/x402.ts
import { signTypedData, privateKeyToAccount } from "viem/accounts";

// src/payment-cache.ts
var DEFAULT_TTL_MS = 36e5;
var PaymentCache = class {
  cache = /* @__PURE__ */ new Map();
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }
  /** Get cached payment params for an endpoint path. */
  get(endpointPath) {
    const entry = this.cache.get(endpointPath);
    if (!entry) return void 0;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(endpointPath);
      return void 0;
    }
    return entry;
  }
  /** Cache payment params from a 402 response. */
  set(endpointPath, params) {
    this.cache.set(endpointPath, { ...params, cachedAt: Date.now() });
  }
  /** Invalidate cache for an endpoint (e.g., if payTo changed). */
  invalidate(endpointPath) {
    this.cache.delete(endpointPath);
  }
};

// src/x402.ts
var BASE_CHAIN_ID = 8453;
var BASE_SEPOLIA_CHAIN_ID = 84532;
var DEFAULT_TOKEN_NAME = "USD Coin";
var DEFAULT_TOKEN_VERSION = "2";
var DEFAULT_NETWORK = "eip155:8453";
var DEFAULT_MAX_TIMEOUT_SECONDS = 300;
var TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};
function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function decodeBase64Json(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - normalized.length % 4) % 4;
  const padded = normalized + "=".repeat(padding);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(decoded);
}
function encodeBase64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
function parsePaymentRequired(headerValue) {
  return decodeBase64Json(headerValue);
}
function normalizeNetwork(network) {
  if (!network || network.trim().length === 0) {
    return DEFAULT_NETWORK;
  }
  return network.trim().toLowerCase();
}
function resolveChainId(network) {
  const eip155Match = network.match(/^eip155:(\d+)$/i);
  if (eip155Match) {
    const parsed = Number.parseInt(eip155Match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (network === "base") return BASE_CHAIN_ID;
  if (network === "base-sepolia") return BASE_SEPOLIA_CHAIN_ID;
  return BASE_CHAIN_ID;
}
function parseHexAddress(value) {
  if (!value) return void 0;
  const direct = value.match(/^0x[a-fA-F0-9]{40}$/);
  if (direct) {
    return direct[0];
  }
  const caipSuffix = value.match(/0x[a-fA-F0-9]{40}$/);
  if (caipSuffix) {
    return caipSuffix[0];
  }
  return void 0;
}
function requireHexAddress(value, field) {
  const parsed = parseHexAddress(value);
  if (!parsed) {
    throw new Error(`Invalid ${field} in payment requirements: ${String(value)}`);
  }
  return parsed;
}
function setPaymentHeaders(headers, payload) {
  headers.set("payment-signature", payload);
  headers.set("x-payment", payload);
}
async function createPaymentPayload(privateKey, fromAddress, option, amount, requestUrl, resource) {
  const network = normalizeNetwork(option.network);
  const chainId = resolveChainId(network);
  const recipient = requireHexAddress(option.payTo, "payTo");
  const verifyingContract = requireHexAddress(option.asset, "asset");
  const maxTimeoutSeconds = typeof option.maxTimeoutSeconds === "number" && option.maxTimeoutSeconds > 0 ? Math.floor(option.maxTimeoutSeconds) : DEFAULT_MAX_TIMEOUT_SECONDS;
  const now = Math.floor(Date.now() / 1e3);
  const validAfter = now - 600;
  const validBefore = now + maxTimeoutSeconds;
  const nonce = createNonce();
  const signature = await signTypedData({
    privateKey,
    domain: {
      name: option.extra?.name || DEFAULT_TOKEN_NAME,
      version: option.extra?.version || DEFAULT_TOKEN_VERSION,
      chainId,
      verifyingContract
    },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: fromAddress,
      to: recipient,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce
    }
  });
  const paymentData = {
    x402Version: 2,
    resource: {
      url: resource?.url || requestUrl,
      description: resource?.description || "BlockRun AI API call",
      mimeType: "application/json"
    },
    accepted: {
      scheme: option.scheme,
      network,
      amount,
      asset: option.asset,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      extra: option.extra
    },
    payload: {
      signature,
      authorization: {
        from: fromAddress,
        to: recipient,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce
      }
    },
    extensions: {}
  };
  return encodeBase64Json(paymentData);
}
function createPaymentFetch(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const walletAddress = account.address;
  const paymentCache = new PaymentCache();
  const payFetch = async (input, init, preAuth) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpointPath = new URL(url).pathname;
    const cached = paymentCache.get(endpointPath);
    if (cached && preAuth?.estimatedAmount) {
      const paymentPayload = await createPaymentPayload(
        privateKey,
        walletAddress,
        {
          scheme: cached.scheme,
          network: cached.network,
          asset: cached.asset,
          payTo: cached.payTo,
          maxTimeoutSeconds: cached.maxTimeoutSeconds,
          extra: cached.extra
        },
        preAuth.estimatedAmount,
        url,
        {
          url: cached.resourceUrl,
          description: cached.resourceDescription
        }
      );
      const preAuthHeaders = new Headers(init?.headers);
      setPaymentHeaders(preAuthHeaders, paymentPayload);
      const response2 = await fetch(input, { ...init, headers: preAuthHeaders });
      if (response2.status !== 402) {
        return response2;
      }
      const paymentHeader2 = response2.headers.get("x-payment-required");
      if (paymentHeader2) {
        return handle402(input, init, url, endpointPath, paymentHeader2);
      }
      paymentCache.invalidate(endpointPath);
      const cleanResponse = await fetch(input, init);
      if (cleanResponse.status !== 402) {
        return cleanResponse;
      }
      const cleanHeader = cleanResponse.headers.get("x-payment-required");
      if (!cleanHeader) {
        throw new Error("402 response missing x-payment-required header");
      }
      return handle402(input, init, url, endpointPath, cleanHeader);
    }
    const response = await fetch(input, init);
    if (response.status !== 402) {
      return response;
    }
    const paymentHeader = response.headers.get("x-payment-required");
    if (!paymentHeader) {
      throw new Error("402 response missing x-payment-required header");
    }
    return handle402(input, init, url, endpointPath, paymentHeader);
  };
  async function handle402(input, init, url, endpointPath, paymentHeader) {
    const paymentRequired = parsePaymentRequired(paymentHeader);
    const option = paymentRequired.accepts?.[0];
    if (!option) {
      throw new Error("No payment options in 402 response");
    }
    const amount = option.amount || option.maxAmountRequired;
    if (!amount) {
      throw new Error("No amount in payment requirements");
    }
    paymentCache.set(endpointPath, {
      payTo: option.payTo,
      asset: option.asset,
      scheme: option.scheme,
      network: option.network,
      extra: option.extra,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      resourceUrl: paymentRequired.resource?.url,
      resourceDescription: paymentRequired.resource?.description
    });
    const paymentPayload = await createPaymentPayload(
      privateKey,
      walletAddress,
      option,
      amount,
      url,
      paymentRequired.resource
    );
    const retryHeaders = new Headers(init?.headers);
    setPaymentHeaders(retryHeaders, paymentPayload);
    return fetch(input, {
      ...init,
      headers: retryHeaders
    });
  }
  return { fetch: payFetch, cache: paymentCache };
}

// src/router/rules.ts
function scoreTokenCount(estimatedTokens, thresholds) {
  if (estimatedTokens < thresholds.simple) {
    return { name: "tokenCount", score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: "tokenCount", score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}
function scoreKeywordMatch(text, keywords, name, signalLabel, thresholds, scores) {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return {
      name,
      score: scores.high,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  if (matches.length >= thresholds.low) {
    return {
      name,
      score: scores.low,
      signal: `${signalLabel} (${matches.slice(0, 3).join(", ")})`
    };
  }
  return { name, score: scores.none, signal: null };
}
function scoreMultiStep(text) {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStepPatterns", score: 0.5, signal: "multi-step" };
  }
  return { name: "multiStepPatterns", score: 0, signal: null };
}
function scoreQuestionComplexity(prompt) {
  const count = (prompt.match(/\?/g) || []).length;
  if (count > 3) {
    return { name: "questionComplexity", score: 0.5, signal: `${count} questions` };
  }
  return { name: "questionComplexity", score: 0, signal: null };
}
function scoreAgenticTask(text, keywords) {
  let matchCount = 0;
  const signals = [];
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) {
      matchCount++;
      if (signals.length < 3) {
        signals.push(keyword);
      }
    }
  }
  if (matchCount >= 4) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 1,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 1
    };
  } else if (matchCount >= 3) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.6,
        signal: `agentic (${signals.join(", ")})`
      },
      agenticScore: 0.6
    };
  } else if (matchCount >= 1) {
    return {
      dimensionScore: {
        name: "agenticTask",
        score: 0.2,
        signal: `agentic-light (${signals.join(", ")})`
      },
      agenticScore: 0.2
    };
  }
  return {
    dimensionScore: { name: "agenticTask", score: 0, signal: null },
    agenticScore: 0
  };
}
function classifyByRules(prompt, systemPrompt, estimatedTokens, config) {
  const text = `${systemPrompt ?? ""} ${prompt}`.toLowerCase();
  const userText = prompt.toLowerCase();
  const dimensions = [
    // Original 8 dimensions
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(
      text,
      config.codeKeywords,
      "codePresence",
      "code",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 1 }
    ),
    // Reasoning markers use USER prompt only — system prompt "step by step" shouldn't trigger reasoning
    scoreKeywordMatch(
      userText,
      config.reasoningKeywords,
      "reasoningMarkers",
      "reasoning",
      { low: 1, high: 2 },
      { none: 0, low: 0.7, high: 1 }
    ),
    scoreKeywordMatch(
      text,
      config.technicalKeywords,
      "technicalTerms",
      "technical",
      { low: 2, high: 4 },
      { none: 0, low: 0.5, high: 1 }
    ),
    scoreKeywordMatch(
      text,
      config.creativeKeywords,
      "creativeMarkers",
      "creative",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config.simpleKeywords,
      "simpleIndicators",
      "simple",
      { low: 1, high: 2 },
      { none: 0, low: -1, high: -1 }
    ),
    scoreMultiStep(text),
    scoreQuestionComplexity(prompt),
    // 6 new dimensions
    scoreKeywordMatch(
      text,
      config.imperativeVerbs,
      "imperativeVerbs",
      "imperative",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config.constraintIndicators,
      "constraintCount",
      "constraints",
      { low: 1, high: 3 },
      { none: 0, low: 0.3, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config.outputFormatKeywords,
      "outputFormat",
      "format",
      { low: 1, high: 2 },
      { none: 0, low: 0.4, high: 0.7 }
    ),
    scoreKeywordMatch(
      text,
      config.referenceKeywords,
      "referenceComplexity",
      "references",
      { low: 1, high: 2 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config.negationKeywords,
      "negationComplexity",
      "negation",
      { low: 2, high: 3 },
      { none: 0, low: 0.3, high: 0.5 }
    ),
    scoreKeywordMatch(
      text,
      config.domainSpecificKeywords,
      "domainSpecificity",
      "domain-specific",
      { low: 1, high: 2 },
      { none: 0, low: 0.5, high: 0.8 }
    )
  ];
  const agenticResult = scoreAgenticTask(text, config.agenticTaskKeywords);
  dimensions.push(agenticResult.dimensionScore);
  const agenticScore = agenticResult.agenticScore;
  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal);
  const weights = config.dimensionWeights;
  let weightedScore = 0;
  for (const d of dimensions) {
    const w = weights[d.name] ?? 0;
    weightedScore += d.score * w;
  }
  const reasoningMatches = config.reasoningKeywords.filter(
    (kw) => userText.includes(kw.toLowerCase())
  );
  if (reasoningMatches.length >= 2) {
    const confidence2 = calibrateConfidence(
      Math.max(weightedScore, 0.3),
      // ensure positive for confidence calc
      config.confidenceSteepness
    );
    return {
      score: weightedScore,
      tier: "REASONING",
      confidence: Math.max(confidence2, 0.85),
      signals,
      agenticScore
    };
  }
  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier;
  let distanceFromBoundary;
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }
  const confidence = calibrateConfidence(distanceFromBoundary, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore };
}
function calibrateConfidence(distance, steepness) {
  return 1 / (1 + Math.exp(-steepness * distance));
}

// src/router/selector.ts
var BASELINE_MODEL_ID = "anthropic/claude-opus-4-5";
function selectModel(tier, confidence, method, reasoning, tierConfigs, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile) {
  const tierConfig = tierConfigs[tier];
  const model = tierConfig.primary;
  const pricing = modelPricing.get(model);
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = estimatedInputTokens / 1e6 * inputPrice;
  const outputCost = maxOutputTokens / 1e6 * outputPrice;
  const costEstimate = inputCost + outputCost;
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? 0;
  const opusOutputPrice = opusPricing?.outputPrice ?? 0;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return {
    model,
    tier,
    confidence,
    method,
    reasoning,
    costEstimate,
    baselineCost,
    savings
  };
}
function getFallbackChain(tier, tierConfigs) {
  const config = tierConfigs[tier];
  return [config.primary, ...config.fallback];
}
function calculateModelCost(model, modelPricing, estimatedInputTokens, maxOutputTokens, routingProfile) {
  const pricing = modelPricing.get(model);
  const inputPrice = pricing?.inputPrice ?? 0;
  const outputPrice = pricing?.outputPrice ?? 0;
  const inputCost = estimatedInputTokens / 1e6 * inputPrice;
  const outputCost = maxOutputTokens / 1e6 * outputPrice;
  const costEstimate = inputCost + outputCost;
  const opusPricing = modelPricing.get(BASELINE_MODEL_ID);
  const opusInputPrice = opusPricing?.inputPrice ?? 0;
  const opusOutputPrice = opusPricing?.outputPrice ?? 0;
  const baselineInput = estimatedInputTokens / 1e6 * opusInputPrice;
  const baselineOutput = maxOutputTokens / 1e6 * opusOutputPrice;
  const baselineCost = baselineInput + baselineOutput;
  const savings = routingProfile === "premium" ? 0 : baselineCost > 0 ? Math.max(0, (baselineCost - costEstimate) / baselineCost) : 0;
  return { costEstimate, baselineCost, savings };
}
function getFallbackChainFiltered(tier, tierConfigs, estimatedTotalTokens, getContextWindow) {
  const fullChain = getFallbackChain(tier, tierConfigs);
  const filtered = fullChain.filter((modelId) => {
    const contextWindow = getContextWindow(modelId);
    if (contextWindow === void 0) {
      return true;
    }
    return contextWindow >= estimatedTotalTokens * 1.1;
  });
  if (filtered.length === 0) {
    return fullChain;
  }
  return filtered;
}

// src/router/config.ts
var DEFAULT_ROUTING_CONFIG = {
  version: "2.0",
  classifier: {
    llmModel: "google/gemini-2.5-flash",
    llmMaxTokens: 10,
    llmTemperature: 0,
    promptTruncationChars: 500,
    cacheTtlMs: 36e5
    // 1 hour
  },
  scoring: {
    tokenCountThresholds: { simple: 50, complex: 500 },
    // Multilingual keywords: EN + ZH + JA + RU + DE + ES + PT + KO + AR
    codeKeywords: [
      // English
      "function",
      "class",
      "import",
      "def",
      "SELECT",
      "async",
      "await",
      "const",
      "let",
      "var",
      "return",
      "```",
      // Chinese
      "\u51FD\u6570",
      "\u7C7B",
      "\u5BFC\u5165",
      "\u5B9A\u4E49",
      "\u67E5\u8BE2",
      "\u5F02\u6B65",
      "\u7B49\u5F85",
      "\u5E38\u91CF",
      "\u53D8\u91CF",
      "\u8FD4\u56DE",
      // Japanese
      "\u95A2\u6570",
      "\u30AF\u30E9\u30B9",
      "\u30A4\u30F3\u30DD\u30FC\u30C8",
      "\u975E\u540C\u671F",
      "\u5B9A\u6570",
      "\u5909\u6570",
      // Russian
      "\u0444\u0443\u043D\u043A\u0446\u0438\u044F",
      "\u043A\u043B\u0430\u0441\u0441",
      "\u0438\u043C\u043F\u043E\u0440\u0442",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B",
      "\u0437\u0430\u043F\u0440\u043E\u0441",
      "\u0430\u0441\u0438\u043D\u0445\u0440\u043E\u043D\u043D\u044B\u0439",
      "\u043E\u0436\u0438\u0434\u0430\u0442\u044C",
      "\u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0430",
      "\u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F",
      "\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      // German
      "funktion",
      "klasse",
      "importieren",
      "definieren",
      "abfrage",
      "asynchron",
      "erwarten",
      "konstante",
      "variable",
      "zur\xFCckgeben",
      // Spanish
      "funci\xF3n",
      "clase",
      "importar",
      "definir",
      "consulta",
      "as\xEDncrono",
      "esperar",
      "constante",
      "variable",
      "retornar",
      // Portuguese
      "fun\xE7\xE3o",
      "classe",
      "importar",
      "definir",
      "consulta",
      "ass\xEDncrono",
      "aguardar",
      "constante",
      "vari\xE1vel",
      "retornar",
      // Korean
      "\uD568\uC218",
      "\uD074\uB798\uC2A4",
      "\uAC00\uC838\uC624\uAE30",
      "\uC815\uC758",
      "\uCFFC\uB9AC",
      "\uBE44\uB3D9\uAE30",
      "\uB300\uAE30",
      "\uC0C1\uC218",
      "\uBCC0\uC218",
      "\uBC18\uD658",
      // Arabic
      "\u062F\u0627\u0644\u0629",
      "\u0641\u0626\u0629",
      "\u0627\u0633\u062A\u064A\u0631\u0627\u062F",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u0627\u0633\u062A\u0639\u0644\u0627\u0645",
      "\u063A\u064A\u0631 \u0645\u062A\u0632\u0627\u0645\u0646",
      "\u0627\u0646\u062A\u0638\u0627\u0631",
      "\u062B\u0627\u0628\u062A",
      "\u0645\u062A\u063A\u064A\u0631",
      "\u0625\u0631\u062C\u0627\u0639"
    ],
    reasoningKeywords: [
      // English
      "prove",
      "theorem",
      "derive",
      "step by step",
      "chain of thought",
      "formally",
      "mathematical",
      "proof",
      "logically",
      // Chinese
      "\u8BC1\u660E",
      "\u5B9A\u7406",
      "\u63A8\u5BFC",
      "\u9010\u6B65",
      "\u601D\u7EF4\u94FE",
      "\u5F62\u5F0F\u5316",
      "\u6570\u5B66",
      "\u903B\u8F91",
      // Japanese
      "\u8A3C\u660E",
      "\u5B9A\u7406",
      "\u5C0E\u51FA",
      "\u30B9\u30C6\u30C3\u30D7\u30D0\u30A4\u30B9\u30C6\u30C3\u30D7",
      "\u8AD6\u7406\u7684",
      // Russian
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
      "\u0434\u043E\u043A\u0430\u0436\u0438",
      "\u0434\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C\u0441\u0442\u0432",
      "\u0442\u0435\u043E\u0440\u0435\u043C\u0430",
      "\u0432\u044B\u0432\u0435\u0441\u0442\u0438",
      "\u0448\u0430\u0433 \u0437\u0430 \u0448\u0430\u0433\u043E\u043C",
      "\u043F\u043E\u0448\u0430\u0433\u043E\u0432\u043E",
      "\u043F\u043E\u044D\u0442\u0430\u043F\u043D\u043E",
      "\u0446\u0435\u043F\u043E\u0447\u043A\u0430 \u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438\u0439",
      "\u0440\u0430\u0441\u0441\u0443\u0436\u0434\u0435\u043D\u0438",
      "\u0444\u043E\u0440\u043C\u0430\u043B\u044C\u043D\u043E",
      "\u043C\u0430\u0442\u0435\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438",
      "\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438",
      // German
      "beweisen",
      "beweis",
      "theorem",
      "ableiten",
      "schritt f\xFCr schritt",
      "gedankenkette",
      "formal",
      "mathematisch",
      "logisch",
      // Spanish
      "demostrar",
      "teorema",
      "derivar",
      "paso a paso",
      "cadena de pensamiento",
      "formalmente",
      "matem\xE1tico",
      "prueba",
      "l\xF3gicamente",
      // Portuguese
      "provar",
      "teorema",
      "derivar",
      "passo a passo",
      "cadeia de pensamento",
      "formalmente",
      "matem\xE1tico",
      "prova",
      "logicamente",
      // Korean
      "\uC99D\uBA85",
      "\uC815\uB9AC",
      "\uB3C4\uCD9C",
      "\uB2E8\uACC4\uBCC4",
      "\uC0AC\uACE0\uC758 \uC5F0\uC1C4",
      "\uD615\uC2DD\uC801",
      "\uC218\uD559\uC801",
      "\uB17C\uB9AC\uC801",
      // Arabic
      "\u0625\u062B\u0628\u0627\u062A",
      "\u0646\u0638\u0631\u064A\u0629",
      "\u0627\u0634\u062A\u0642\u0627\u0642",
      "\u062E\u0637\u0648\u0629 \u0628\u062E\u0637\u0648\u0629",
      "\u0633\u0644\u0633\u0644\u0629 \u0627\u0644\u062A\u0641\u0643\u064A\u0631",
      "\u0631\u0633\u0645\u064A\u0627\u064B",
      "\u0631\u064A\u0627\u0636\u064A",
      "\u0628\u0631\u0647\u0627\u0646",
      "\u0645\u0646\u0637\u0642\u064A\u0627\u064B"
    ],
    simpleKeywords: [
      // English
      "what is",
      "define",
      "translate",
      "hello",
      "yes or no",
      "capital of",
      "how old",
      "who is",
      "when was",
      // Chinese
      "\u4EC0\u4E48\u662F",
      "\u5B9A\u4E49",
      "\u7FFB\u8BD1",
      "\u4F60\u597D",
      "\u662F\u5426",
      "\u9996\u90FD",
      "\u591A\u5927",
      "\u8C01\u662F",
      "\u4F55\u65F6",
      // Japanese
      "\u3068\u306F",
      "\u5B9A\u7FA9",
      "\u7FFB\u8A33",
      "\u3053\u3093\u306B\u3061\u306F",
      "\u306F\u3044\u304B\u3044\u3044\u3048",
      "\u9996\u90FD",
      "\u8AB0",
      // Russian
      "\u0447\u0442\u043E \u0442\u0430\u043A\u043E\u0435",
      "\u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0438\u0435",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438",
      "\u043F\u0435\u0440\u0435\u0432\u0435\u0434\u0438",
      "\u043F\u0440\u0438\u0432\u0435\u0442",
      "\u0434\u0430 \u0438\u043B\u0438 \u043D\u0435\u0442",
      "\u0441\u0442\u043E\u043B\u0438\u0446\u0430",
      "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043B\u0435\u0442",
      "\u043A\u0442\u043E \u0442\u0430\u043A\u043E\u0439",
      "\u043A\u043E\u0433\u0434\u0430",
      "\u043E\u0431\u044A\u044F\u0441\u043D\u0438",
      // German
      "was ist",
      "definiere",
      "\xFCbersetze",
      "hallo",
      "ja oder nein",
      "hauptstadt",
      "wie alt",
      "wer ist",
      "wann",
      "erkl\xE4re",
      // Spanish
      "qu\xE9 es",
      "definir",
      "traducir",
      "hola",
      "s\xED o no",
      "capital de",
      "cu\xE1ntos a\xF1os",
      "qui\xE9n es",
      "cu\xE1ndo",
      // Portuguese
      "o que \xE9",
      "definir",
      "traduzir",
      "ol\xE1",
      "sim ou n\xE3o",
      "capital de",
      "quantos anos",
      "quem \xE9",
      "quando",
      // Korean
      "\uBB34\uC5C7",
      "\uC815\uC758",
      "\uBC88\uC5ED",
      "\uC548\uB155\uD558\uC138\uC694",
      "\uC608 \uB610\uB294 \uC544\uB2C8\uC624",
      "\uC218\uB3C4",
      "\uB204\uAD6C",
      "\uC5B8\uC81C",
      // Arabic
      "\u0645\u0627 \u0647\u0648",
      "\u062A\u0639\u0631\u064A\u0641",
      "\u062A\u0631\u062C\u0645",
      "\u0645\u0631\u062D\u0628\u0627",
      "\u0646\u0639\u0645 \u0623\u0648 \u0644\u0627",
      "\u0639\u0627\u0635\u0645\u0629",
      "\u0645\u0646 \u0647\u0648",
      "\u0645\u062A\u0649"
    ],
    technicalKeywords: [
      // English
      "algorithm",
      "optimize",
      "architecture",
      "distributed",
      "kubernetes",
      "microservice",
      "database",
      "infrastructure",
      // Chinese
      "\u7B97\u6CD5",
      "\u4F18\u5316",
      "\u67B6\u6784",
      "\u5206\u5E03\u5F0F",
      "\u5FAE\u670D\u52A1",
      "\u6570\u636E\u5E93",
      "\u57FA\u7840\u8BBE\u65BD",
      // Japanese
      "\u30A2\u30EB\u30B4\u30EA\u30BA\u30E0",
      "\u6700\u9069\u5316",
      "\u30A2\u30FC\u30AD\u30C6\u30AF\u30C1\u30E3",
      "\u5206\u6563",
      "\u30DE\u30A4\u30AF\u30ED\u30B5\u30FC\u30D3\u30B9",
      "\u30C7\u30FC\u30BF\u30D9\u30FC\u30B9",
      // Russian
      "\u0430\u043B\u0433\u043E\u0440\u0438\u0442\u043C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0430\u0446\u0438",
      "\u043E\u043F\u0442\u0438\u043C\u0438\u0437\u0438\u0440\u0443\u0439",
      "\u0430\u0440\u0445\u0438\u0442\u0435\u043A\u0442\u0443\u0440\u0430",
      "\u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D\u043D\u044B\u0439",
      "\u043C\u0438\u043A\u0440\u043E\u0441\u0435\u0440\u0432\u0438\u0441",
      "\u0431\u0430\u0437\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
      "\u0438\u043D\u0444\u0440\u0430\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430",
      // German
      "algorithmus",
      "optimieren",
      "architektur",
      "verteilt",
      "kubernetes",
      "mikroservice",
      "datenbank",
      "infrastruktur",
      // Spanish
      "algoritmo",
      "optimizar",
      "arquitectura",
      "distribuido",
      "microservicio",
      "base de datos",
      "infraestructura",
      // Portuguese
      "algoritmo",
      "otimizar",
      "arquitetura",
      "distribu\xEDdo",
      "microsservi\xE7o",
      "banco de dados",
      "infraestrutura",
      // Korean
      "\uC54C\uACE0\uB9AC\uC998",
      "\uCD5C\uC801\uD654",
      "\uC544\uD0A4\uD14D\uCC98",
      "\uBD84\uC0B0",
      "\uB9C8\uC774\uD06C\uB85C\uC11C\uBE44\uC2A4",
      "\uB370\uC774\uD130\uBCA0\uC774\uC2A4",
      "\uC778\uD504\uB77C",
      // Arabic
      "\u062E\u0648\u0627\u0631\u0632\u0645\u064A\u0629",
      "\u062A\u062D\u0633\u064A\u0646",
      "\u0628\u0646\u064A\u0629",
      "\u0645\u0648\u0632\u0639",
      "\u062E\u062F\u0645\u0629 \u0645\u0635\u063A\u0631\u0629",
      "\u0642\u0627\u0639\u062F\u0629 \u0628\u064A\u0627\u0646\u0627\u062A",
      "\u0628\u0646\u064A\u0629 \u062A\u062D\u062A\u064A\u0629"
    ],
    creativeKeywords: [
      // English
      "story",
      "poem",
      "compose",
      "brainstorm",
      "creative",
      "imagine",
      "write a",
      // Chinese
      "\u6545\u4E8B",
      "\u8BD7",
      "\u521B\u4F5C",
      "\u5934\u8111\u98CE\u66B4",
      "\u521B\u610F",
      "\u60F3\u8C61",
      "\u5199\u4E00\u4E2A",
      // Japanese
      "\u7269\u8A9E",
      "\u8A69",
      "\u4F5C\u66F2",
      "\u30D6\u30EC\u30A4\u30F3\u30B9\u30C8\u30FC\u30E0",
      "\u5275\u9020\u7684",
      "\u60F3\u50CF",
      // Russian
      "\u0438\u0441\u0442\u043E\u0440\u0438\u044F",
      "\u0440\u0430\u0441\u0441\u043A\u0430\u0437",
      "\u0441\u0442\u0438\u0445\u043E\u0442\u0432\u043E\u0440\u0435\u043D\u0438\u0435",
      "\u0441\u043E\u0447\u0438\u043D\u0438\u0442\u044C",
      "\u0441\u043E\u0447\u0438\u043D\u0438",
      "\u043C\u043E\u0437\u0433\u043E\u0432\u043E\u0439 \u0448\u0442\u0443\u0440\u043C",
      "\u0442\u0432\u043E\u0440\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u043F\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u0442\u044C",
      "\u043F\u0440\u0438\u0434\u0443\u043C\u0430\u0439",
      "\u043D\u0430\u043F\u0438\u0448\u0438",
      // German
      "geschichte",
      "gedicht",
      "komponieren",
      "brainstorming",
      "kreativ",
      "vorstellen",
      "schreibe",
      "erz\xE4hlung",
      // Spanish
      "historia",
      "poema",
      "componer",
      "lluvia de ideas",
      "creativo",
      "imaginar",
      "escribe",
      // Portuguese
      "hist\xF3ria",
      "poema",
      "compor",
      "criativo",
      "imaginar",
      "escreva",
      // Korean
      "\uC774\uC57C\uAE30",
      "\uC2DC",
      "\uC791\uACE1",
      "\uBE0C\uB808\uC778\uC2A4\uD1A0\uBC0D",
      "\uCC3D\uC758\uC801",
      "\uC0C1\uC0C1",
      "\uC791\uC131",
      // Arabic
      "\u0642\u0635\u0629",
      "\u0642\u0635\u064A\u062F\u0629",
      "\u062A\u0623\u0644\u064A\u0641",
      "\u0639\u0635\u0641 \u0630\u0647\u0646\u064A",
      "\u0625\u0628\u062F\u0627\u0639\u064A",
      "\u062A\u062E\u064A\u0644",
      "\u0627\u0643\u062A\u0628"
    ],
    // New dimension keyword lists (multilingual)
    imperativeVerbs: [
      // English
      "build",
      "create",
      "implement",
      "design",
      "develop",
      "construct",
      "generate",
      "deploy",
      "configure",
      "set up",
      // Chinese
      "\u6784\u5EFA",
      "\u521B\u5EFA",
      "\u5B9E\u73B0",
      "\u8BBE\u8BA1",
      "\u5F00\u53D1",
      "\u751F\u6210",
      "\u90E8\u7F72",
      "\u914D\u7F6E",
      "\u8BBE\u7F6E",
      // Japanese
      "\u69CB\u7BC9",
      "\u4F5C\u6210",
      "\u5B9F\u88C5",
      "\u8A2D\u8A08",
      "\u958B\u767A",
      "\u751F\u6210",
      "\u30C7\u30D7\u30ED\u30A4",
      "\u8A2D\u5B9A",
      // Russian
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043F\u043E\u0441\u0442\u0440\u043E\u0439",
      "\u0441\u043E\u0437\u0434\u0430\u0442\u044C",
      "\u0441\u043E\u0437\u0434\u0430\u0439",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0435\u0430\u043B\u0438\u0437\u0443\u0439",
      "\u0441\u043F\u0440\u043E\u0435\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C",
      "\u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0430\u0439",
      "\u0441\u043A\u043E\u043D\u0441\u0442\u0440\u0443\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
      "\u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
      "\u0440\u0430\u0437\u0432\u0435\u0440\u043D\u0438",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0438\u0442\u044C",
      "\u043D\u0430\u0441\u0442\u0440\u043E\u0439",
      // German
      "erstellen",
      "bauen",
      "implementieren",
      "entwerfen",
      "entwickeln",
      "konstruieren",
      "generieren",
      "bereitstellen",
      "konfigurieren",
      "einrichten",
      // Spanish
      "construir",
      "crear",
      "implementar",
      "dise\xF1ar",
      "desarrollar",
      "generar",
      "desplegar",
      "configurar",
      // Portuguese
      "construir",
      "criar",
      "implementar",
      "projetar",
      "desenvolver",
      "gerar",
      "implantar",
      "configurar",
      // Korean
      "\uAD6C\uCD95",
      "\uC0DD\uC131",
      "\uAD6C\uD604",
      "\uC124\uACC4",
      "\uAC1C\uBC1C",
      "\uBC30\uD3EC",
      "\uC124\uC815",
      // Arabic
      "\u0628\u0646\u0627\u0621",
      "\u0625\u0646\u0634\u0627\u0621",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u062A\u0635\u0645\u064A\u0645",
      "\u062A\u0637\u0648\u064A\u0631",
      "\u062A\u0648\u0644\u064A\u062F",
      "\u0646\u0634\u0631",
      "\u0625\u0639\u062F\u0627\u062F"
    ],
    constraintIndicators: [
      // English
      "under",
      "at most",
      "at least",
      "within",
      "no more than",
      "o(",
      "maximum",
      "minimum",
      "limit",
      "budget",
      // Chinese
      "\u4E0D\u8D85\u8FC7",
      "\u81F3\u5C11",
      "\u6700\u591A",
      "\u5728\u5185",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u9650\u5236",
      "\u9884\u7B97",
      // Japanese
      "\u4EE5\u4E0B",
      "\u6700\u5927",
      "\u6700\u5C0F",
      "\u5236\u9650",
      "\u4E88\u7B97",
      // Russian
      "\u043D\u0435 \u0431\u043E\u043B\u0435\u0435",
      "\u043D\u0435 \u043C\u0435\u043D\u0435\u0435",
      "\u043A\u0430\u043A \u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445",
      "\u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C",
      "\u043C\u0438\u043D\u0438\u043C\u0443\u043C",
      "\u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435",
      "\u0431\u044E\u0434\u0436\u0435\u0442",
      // German
      "h\xF6chstens",
      "mindestens",
      "innerhalb",
      "nicht mehr als",
      "maximal",
      "minimal",
      "grenze",
      "budget",
      // Spanish
      "como m\xE1ximo",
      "al menos",
      "dentro de",
      "no m\xE1s de",
      "m\xE1ximo",
      "m\xEDnimo",
      "l\xEDmite",
      "presupuesto",
      // Portuguese
      "no m\xE1ximo",
      "pelo menos",
      "dentro de",
      "n\xE3o mais que",
      "m\xE1ximo",
      "m\xEDnimo",
      "limite",
      "or\xE7amento",
      // Korean
      "\uC774\uD558",
      "\uC774\uC0C1",
      "\uCD5C\uB300",
      "\uCD5C\uC18C",
      "\uC81C\uD55C",
      "\uC608\uC0B0",
      // Arabic
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0643\u062B\u0631",
      "\u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644",
      "\u0636\u0645\u0646",
      "\u0644\u0627 \u064A\u0632\u064A\u062F \u0639\u0646",
      "\u0623\u0642\u0635\u0649",
      "\u0623\u062F\u0646\u0649",
      "\u062D\u062F",
      "\u0645\u064A\u0632\u0627\u0646\u064A\u0629"
    ],
    outputFormatKeywords: [
      // English
      "json",
      "yaml",
      "xml",
      "table",
      "csv",
      "markdown",
      "schema",
      "format as",
      "structured",
      // Chinese
      "\u8868\u683C",
      "\u683C\u5F0F\u5316\u4E3A",
      "\u7ED3\u6784\u5316",
      // Japanese
      "\u30C6\u30FC\u30D6\u30EB",
      "\u30D5\u30A9\u30FC\u30DE\u30C3\u30C8",
      "\u69CB\u9020\u5316",
      // Russian
      "\u0442\u0430\u0431\u043B\u0438\u0446\u0430",
      "\u0444\u043E\u0440\u043C\u0430\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043A\u0430\u043A",
      "\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439",
      // German
      "tabelle",
      "formatieren als",
      "strukturiert",
      // Spanish
      "tabla",
      "formatear como",
      "estructurado",
      // Portuguese
      "tabela",
      "formatar como",
      "estruturado",
      // Korean
      "\uD14C\uC774\uBE14",
      "\uD615\uC2DD",
      "\uAD6C\uC870\uD654",
      // Arabic
      "\u062C\u062F\u0648\u0644",
      "\u062A\u0646\u0633\u064A\u0642",
      "\u0645\u0646\u0638\u0645"
    ],
    referenceKeywords: [
      // English
      "above",
      "below",
      "previous",
      "following",
      "the docs",
      "the api",
      "the code",
      "earlier",
      "attached",
      // Chinese
      "\u4E0A\u9762",
      "\u4E0B\u9762",
      "\u4E4B\u524D",
      "\u63A5\u4E0B\u6765",
      "\u6587\u6863",
      "\u4EE3\u7801",
      "\u9644\u4EF6",
      // Japanese
      "\u4E0A\u8A18",
      "\u4E0B\u8A18",
      "\u524D\u306E",
      "\u6B21\u306E",
      "\u30C9\u30AD\u30E5\u30E1\u30F3\u30C8",
      "\u30B3\u30FC\u30C9",
      // Russian
      "\u0432\u044B\u0448\u0435",
      "\u043D\u0438\u0436\u0435",
      "\u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0438\u0439",
      "\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439",
      "\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430\u0446\u0438\u044F",
      "\u043A\u043E\u0434",
      "\u0440\u0430\u043D\u0435\u0435",
      "\u0432\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
      // German
      "oben",
      "unten",
      "vorherige",
      "folgende",
      "dokumentation",
      "der code",
      "fr\xFCher",
      "anhang",
      // Spanish
      "arriba",
      "abajo",
      "anterior",
      "siguiente",
      "documentaci\xF3n",
      "el c\xF3digo",
      "adjunto",
      // Portuguese
      "acima",
      "abaixo",
      "anterior",
      "seguinte",
      "documenta\xE7\xE3o",
      "o c\xF3digo",
      "anexo",
      // Korean
      "\uC704",
      "\uC544\uB798",
      "\uC774\uC804",
      "\uB2E4\uC74C",
      "\uBB38\uC11C",
      "\uCF54\uB4DC",
      "\uCCA8\uBD80",
      // Arabic
      "\u0623\u0639\u0644\u0627\u0647",
      "\u0623\u062F\u0646\u0627\u0647",
      "\u0627\u0644\u0633\u0627\u0628\u0642",
      "\u0627\u0644\u062A\u0627\u0644\u064A",
      "\u0627\u0644\u0648\u062B\u0627\u0626\u0642",
      "\u0627\u0644\u0643\u0648\u062F",
      "\u0645\u0631\u0641\u0642"
    ],
    negationKeywords: [
      // English
      "don't",
      "do not",
      "avoid",
      "never",
      "without",
      "except",
      "exclude",
      "no longer",
      // Chinese
      "\u4E0D\u8981",
      "\u907F\u514D",
      "\u4ECE\u4E0D",
      "\u6CA1\u6709",
      "\u9664\u4E86",
      "\u6392\u9664",
      // Japanese
      "\u3057\u306A\u3044\u3067",
      "\u907F\u3051\u308B",
      "\u6C7A\u3057\u3066",
      "\u306A\u3057\u3067",
      "\u9664\u304F",
      // Russian
      "\u043D\u0435 \u0434\u0435\u043B\u0430\u0439",
      "\u043D\u0435 \u043D\u0430\u0434\u043E",
      "\u043D\u0435\u043B\u044C\u0437\u044F",
      "\u0438\u0437\u0431\u0435\u0433\u0430\u0442\u044C",
      "\u043D\u0438\u043A\u043E\u0433\u0434\u0430",
      "\u0431\u0435\u0437",
      "\u043A\u0440\u043E\u043C\u0435",
      "\u0438\u0441\u043A\u043B\u044E\u0447\u0438\u0442\u044C",
      "\u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435",
      // German
      "nicht",
      "vermeide",
      "niemals",
      "ohne",
      "au\xDFer",
      "ausschlie\xDFen",
      "nicht mehr",
      // Spanish
      "no hagas",
      "evitar",
      "nunca",
      "sin",
      "excepto",
      "excluir",
      // Portuguese
      "n\xE3o fa\xE7a",
      "evitar",
      "nunca",
      "sem",
      "exceto",
      "excluir",
      // Korean
      "\uD558\uC9C0 \uB9C8",
      "\uD53C\uD558\uB2E4",
      "\uC808\uB300",
      "\uC5C6\uC774",
      "\uC81C\uC678",
      // Arabic
      "\u0644\u0627 \u062A\u0641\u0639\u0644",
      "\u062A\u062C\u0646\u0628",
      "\u0623\u0628\u062F\u0627\u064B",
      "\u0628\u062F\u0648\u0646",
      "\u0628\u0627\u0633\u062A\u062B\u0646\u0627\u0621",
      "\u0627\u0633\u062A\u0628\u0639\u0627\u062F"
    ],
    domainSpecificKeywords: [
      // English
      "quantum",
      "fpga",
      "vlsi",
      "risc-v",
      "asic",
      "photonics",
      "genomics",
      "proteomics",
      "topological",
      "homomorphic",
      "zero-knowledge",
      "lattice-based",
      // Chinese
      "\u91CF\u5B50",
      "\u5149\u5B50\u5B66",
      "\u57FA\u56E0\u7EC4\u5B66",
      "\u86CB\u767D\u8D28\u7EC4\u5B66",
      "\u62D3\u6251",
      "\u540C\u6001",
      "\u96F6\u77E5\u8BC6",
      "\u683C\u5BC6\u7801",
      // Japanese
      "\u91CF\u5B50",
      "\u30D5\u30A9\u30C8\u30CB\u30AF\u30B9",
      "\u30B2\u30CE\u30DF\u30AF\u30B9",
      "\u30C8\u30DD\u30ED\u30B8\u30AB\u30EB",
      // Russian
      "\u043A\u0432\u0430\u043D\u0442\u043E\u0432\u044B\u0439",
      "\u0444\u043E\u0442\u043E\u043D\u0438\u043A\u0430",
      "\u0433\u0435\u043D\u043E\u043C\u0438\u043A\u0430",
      "\u043F\u0440\u043E\u0442\u0435\u043E\u043C\u0438\u043A\u0430",
      "\u0442\u043E\u043F\u043E\u043B\u043E\u0433\u0438\u0447\u0435\u0441\u043A\u0438\u0439",
      "\u0433\u043E\u043C\u043E\u043C\u043E\u0440\u0444\u043D\u044B\u0439",
      "\u0441 \u043D\u0443\u043B\u0435\u0432\u044B\u043C \u0440\u0430\u0437\u0433\u043B\u0430\u0448\u0435\u043D\u0438\u0435\u043C",
      "\u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0435 \u0440\u0435\u0448\u0451\u0442\u043E\u043A",
      // German
      "quanten",
      "photonik",
      "genomik",
      "proteomik",
      "topologisch",
      "homomorph",
      "zero-knowledge",
      "gitterbasiert",
      // Spanish
      "cu\xE1ntico",
      "fot\xF3nica",
      "gen\xF3mica",
      "prote\xF3mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Portuguese
      "qu\xE2ntico",
      "fot\xF4nica",
      "gen\xF4mica",
      "prote\xF4mica",
      "topol\xF3gico",
      "homom\xF3rfico",
      // Korean
      "\uC591\uC790",
      "\uD3EC\uD1A0\uB2C9\uC2A4",
      "\uC720\uC804\uCCB4\uD559",
      "\uC704\uC0C1",
      "\uB3D9\uD615",
      // Arabic
      "\u0643\u0645\u064A",
      "\u0636\u0648\u0626\u064A\u0627\u062A",
      "\u062C\u064A\u0646\u0648\u0645\u064A\u0627\u062A",
      "\u0637\u0648\u0628\u0648\u0644\u0648\u062C\u064A",
      "\u062A\u0645\u0627\u062B\u0644\u064A"
    ],
    // Agentic task keywords - file ops, execution, multi-step, iterative work
    // Pruned: removed overly common words like "then", "first", "run", "test", "build"
    agenticTaskKeywords: [
      // English - File operations (clearly agentic)
      "read file",
      "read the file",
      "look at",
      "check the",
      "open the",
      "edit",
      "modify",
      "update the",
      "change the",
      "write to",
      "create file",
      // English - Execution (specific commands only)
      "execute",
      "deploy",
      "install",
      "npm",
      "pip",
      "compile",
      // English - Multi-step patterns (specific only)
      "after that",
      "and also",
      "once done",
      "step 1",
      "step 2",
      // English - Iterative work
      "fix",
      "debug",
      "until it works",
      "keep trying",
      "iterate",
      "make sure",
      "verify",
      "confirm",
      // Chinese (keep specific ones)
      "\u8BFB\u53D6\u6587\u4EF6",
      "\u67E5\u770B",
      "\u6253\u5F00",
      "\u7F16\u8F91",
      "\u4FEE\u6539",
      "\u66F4\u65B0",
      "\u521B\u5EFA",
      "\u6267\u884C",
      "\u90E8\u7F72",
      "\u5B89\u88C5",
      "\u7B2C\u4E00\u6B65",
      "\u7B2C\u4E8C\u6B65",
      "\u4FEE\u590D",
      "\u8C03\u8BD5",
      "\u76F4\u5230",
      "\u786E\u8BA4",
      "\u9A8C\u8BC1",
      // Spanish
      "leer archivo",
      "editar",
      "modificar",
      "actualizar",
      "ejecutar",
      "desplegar",
      "instalar",
      "paso 1",
      "paso 2",
      "arreglar",
      "depurar",
      "verificar",
      // Portuguese
      "ler arquivo",
      "editar",
      "modificar",
      "atualizar",
      "executar",
      "implantar",
      "instalar",
      "passo 1",
      "passo 2",
      "corrigir",
      "depurar",
      "verificar",
      // Korean
      "\uD30C\uC77C \uC77D\uAE30",
      "\uD3B8\uC9D1",
      "\uC218\uC815",
      "\uC5C5\uB370\uC774\uD2B8",
      "\uC2E4\uD589",
      "\uBC30\uD3EC",
      "\uC124\uCE58",
      "\uB2E8\uACC4 1",
      "\uB2E8\uACC4 2",
      "\uB514\uBC84\uADF8",
      "\uD655\uC778",
      // Arabic
      "\u0642\u0631\u0627\u0621\u0629 \u0645\u0644\u0641",
      "\u062A\u062D\u0631\u064A\u0631",
      "\u062A\u0639\u062F\u064A\u0644",
      "\u062A\u062D\u062F\u064A\u062B",
      "\u062A\u0646\u0641\u064A\u0630",
      "\u0646\u0634\u0631",
      "\u062A\u062B\u0628\u064A\u062A",
      "\u0627\u0644\u062E\u0637\u0648\u0629 1",
      "\u0627\u0644\u062E\u0637\u0648\u0629 2",
      "\u0625\u0635\u0644\u0627\u062D",
      "\u062A\u0635\u062D\u064A\u062D",
      "\u062A\u062D\u0642\u0642"
    ],
    // Dimension weights (sum to 1.0)
    dimensionWeights: {
      tokenCount: 0.08,
      codePresence: 0.15,
      reasoningMarkers: 0.18,
      technicalTerms: 0.1,
      creativeMarkers: 0.05,
      simpleIndicators: 0.02,
      // Reduced from 0.12 to make room for agenticTask
      multiStepPatterns: 0.12,
      questionComplexity: 0.05,
      imperativeVerbs: 0.03,
      constraintCount: 0.04,
      outputFormat: 0.03,
      referenceComplexity: 0.02,
      negationComplexity: 0.01,
      domainSpecificity: 0.02,
      agenticTask: 0.04
      // Reduced - agentic signals influence tier selection, not dominate it
    },
    // Tier boundaries on weighted score axis
    tierBoundaries: {
      simpleMedium: 0,
      mediumComplex: 0.3,
      // Raised from 0.18 - prevent simple tasks from reaching expensive COMPLEX tier
      complexReasoning: 0.5
      // Raised from 0.4 - reserve for true reasoning tasks
    },
    // Sigmoid steepness for confidence calibration
    confidenceSteepness: 12,
    // Below this confidence → ambiguous (null tier)
    confidenceThreshold: 0.7
  },
  // Auto (balanced) tier configs - current default smart routing
  tiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // $0.60/$3.00 - best quality/price for simple tasks
      fallback: [
        "google/gemini-2.5-flash-lite",
        // 1M context, ultra cheap ($0.10/$0.40)
        "nvidia/gpt-oss-120b",
        // FREE fallback
        "deepseek/deepseek-chat"
      ]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      // Code specialist, $0.20/$1.50
      fallback: [
        "google/gemini-2.5-flash-lite",
        // 1M context, ultra cheap ($0.10/$0.40)
        "deepseek/deepseek-chat",
        "xai/grok-4-1-fast-non-reasoning"
        // Upgraded Grok 4.1
      ]
    },
    COMPLEX: {
      primary: "google/gemini-3.1-pro-preview",
      // Newest Gemini 3.1 - upgraded from 3.0
      fallback: [
        "google/gemini-2.5-flash-lite",
        // CRITICAL: 1M context, ultra-cheap failsafe ($0.10/$0.40)
        "google/gemini-3-pro-preview",
        // 3.0 fallback
        "google/gemini-2.5-pro",
        "deepseek/deepseek-chat",
        "xai/grok-4-0709",
        "openai/gpt-5.2",
        // Newer and cheaper input than gpt-4o
        "openai/gpt-4o",
        "anthropic/claude-sonnet-4.6"
      ]
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning",
      // Upgraded Grok 4.1 reasoning $0.20/$0.50
      fallback: [
        "deepseek/deepseek-reasoner",
        // Cheap reasoning model
        "openai/o4-mini",
        // Newer and cheaper than o3 ($1.10 vs $2.00)
        "openai/o3"
      ]
    }
  },
  // Eco tier configs - absolute cheapest (blockrun/eco)
  ecoTiers: {
    SIMPLE: {
      primary: "nvidia/gpt-oss-120b",
      // FREE! $0.00/$0.00
      fallback: ["google/gemini-2.5-flash-lite", "deepseek/deepseek-chat"]
    },
    MEDIUM: {
      primary: "google/gemini-2.5-flash-lite",
      // $0.10/$0.40 - cheapest capable with 1M context
      fallback: ["deepseek/deepseek-chat", "nvidia/gpt-oss-120b"]
    },
    COMPLEX: {
      primary: "google/gemini-2.5-flash-lite",
      // $0.10/$0.40 - 1M context handles complexity
      fallback: ["google/gemini-2.5-flash", "deepseek/deepseek-chat", "xai/grok-4-0709"]
    },
    REASONING: {
      primary: "xai/grok-4-1-fast-reasoning",
      // $0.20/$0.50
      fallback: ["deepseek/deepseek-reasoner"]
    }
  },
  // Premium tier configs - best quality (blockrun/premium)
  // codex=complex coding, kimi=simple coding, sonnet=reasoning/instructions, opus=architecture/PM/audits
  premiumTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // $0.60/$3.00 - good for simple coding
      fallback: [
        "anthropic/claude-haiku-4.5",
        "google/gemini-2.5-flash-lite",
        "xai/grok-code-fast-1"
      ]
    },
    MEDIUM: {
      primary: "openai/gpt-5.2-codex",
      // $2.50/$10 - strong coding for medium tasks
      fallback: [
        "moonshot/kimi-k2.5",
        "google/gemini-2.5-pro",
        "xai/grok-4-0709",
        "anthropic/claude-sonnet-4.6"
      ]
    },
    COMPLEX: {
      primary: "anthropic/claude-opus-4.6",
      // Best quality for complex tasks
      fallback: [
        "openai/gpt-5.2-codex",
        "anthropic/claude-opus-4.6",
        "anthropic/claude-sonnet-4.6",
        "google/gemini-3.1-pro-preview",
        // Newest Gemini
        "google/gemini-3-pro-preview",
        "moonshot/kimi-k2.5"
      ]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6",
      // $3/$15 - best for reasoning/instructions
      fallback: [
        "anthropic/claude-opus-4.6",
        "anthropic/claude-opus-4.6",
        "openai/o4-mini",
        // Newer and cheaper than o3 ($1.10 vs $2.00)
        "openai/o3",
        "xai/grok-4-1-fast-reasoning"
      ]
    }
  },
  // Agentic tier configs - models that excel at multi-step autonomous tasks
  agenticTiers: {
    SIMPLE: {
      primary: "moonshot/kimi-k2.5",
      // Cheaper than Haiku ($0.5/$2.4 vs $1/$5), larger context
      fallback: [
        "anthropic/claude-haiku-4.5",
        "xai/grok-4-1-fast-non-reasoning",
        "openai/gpt-4o-mini"
      ]
    },
    MEDIUM: {
      primary: "xai/grok-code-fast-1",
      // Code specialist for agentic coding
      fallback: ["moonshot/kimi-k2.5", "anthropic/claude-haiku-4.5", "claude-sonnet-4"]
    },
    COMPLEX: {
      primary: "anthropic/claude-sonnet-4.6",
      fallback: [
        "anthropic/claude-opus-4.6",
        // Latest Opus - best agentic
        "openai/gpt-5.2",
        "google/gemini-3.1-pro-preview",
        // Newest Gemini
        "google/gemini-3-pro-preview",
        "xai/grok-4-0709"
      ]
    },
    REASONING: {
      primary: "anthropic/claude-sonnet-4.6",
      // Strong tool use + reasoning for agentic tasks
      fallback: [
        "anthropic/claude-opus-4.6",
        "xai/grok-4-1-fast-reasoning",
        "deepseek/deepseek-reasoner"
      ]
    }
  },
  overrides: {
    maxTokensForceComplex: 1e5,
    structuredOutputMinTier: "MEDIUM",
    ambiguousDefaultTier: "MEDIUM",
    agenticMode: false
  }
};

// src/router/index.ts
function route(prompt, systemPrompt, maxOutputTokens, options) {
  const { config, modelPricing } = options;
  const fullText = `${systemPrompt ?? ""} ${prompt}`;
  const estimatedTokens = Math.ceil(fullText.length / 4);
  const ruleResult = classifyByRules(prompt, systemPrompt, estimatedTokens, config.scoring);
  const { routingProfile } = options;
  let tierConfigs;
  let profileSuffix = "";
  if (routingProfile === "eco" && config.ecoTiers) {
    tierConfigs = config.ecoTiers;
    profileSuffix = " | eco";
  } else if (routingProfile === "premium" && config.premiumTiers) {
    tierConfigs = config.premiumTiers;
    profileSuffix = " | premium";
  } else {
    const agenticScore = ruleResult.agenticScore ?? 0;
    const isAutoAgentic = agenticScore >= 0.5;
    const isExplicitAgentic = config.overrides.agenticMode ?? false;
    const useAgenticTiers = (isAutoAgentic || isExplicitAgentic) && config.agenticTiers != null;
    tierConfigs = useAgenticTiers ? config.agenticTiers : config.tiers;
    profileSuffix = useAgenticTiers ? " | agentic" : "";
  }
  if (estimatedTokens > config.overrides.maxTokensForceComplex) {
    return selectModel(
      "COMPLEX",
      0.95,
      "rules",
      `Input exceeds ${config.overrides.maxTokensForceComplex} tokens${profileSuffix}`,
      tierConfigs,
      modelPricing,
      estimatedTokens,
      maxOutputTokens,
      routingProfile
    );
  }
  const hasStructuredOutput = systemPrompt ? /json|structured|schema/i.test(systemPrompt) : false;
  let tier;
  let confidence;
  const method = "rules";
  let reasoning = `score=${ruleResult.score.toFixed(2)} | ${ruleResult.signals.join(", ")}`;
  if (ruleResult.tier !== null) {
    tier = ruleResult.tier;
    confidence = ruleResult.confidence;
  } else {
    tier = config.overrides.ambiguousDefaultTier;
    confidence = 0.5;
    reasoning += ` | ambiguous -> default: ${tier}`;
  }
  if (hasStructuredOutput) {
    const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
    const minTier = config.overrides.structuredOutputMinTier;
    if (tierRank[tier] < tierRank[minTier]) {
      reasoning += ` | upgraded to ${minTier} (structured output)`;
      tier = minTier;
    }
  }
  reasoning += profileSuffix;
  return selectModel(
    tier,
    confidence,
    method,
    reasoning,
    tierConfigs,
    modelPricing,
    estimatedTokens,
    maxOutputTokens,
    routingProfile
  );
}

// src/models.ts
var MODEL_ALIASES = {
  // Claude - use newest versions (4.6)
  claude: "anthropic/claude-sonnet-4.6",
  sonnet: "anthropic/claude-sonnet-4.6",
  "sonnet-4": "anthropic/claude-sonnet-4.6",
  "sonnet-4.6": "anthropic/claude-sonnet-4.6",
  "sonnet-4-6": "anthropic/claude-sonnet-4.6",
  opus: "anthropic/claude-opus-4.6",
  "opus-4": "anthropic/claude-opus-4.6",
  "opus-4.6": "anthropic/claude-opus-4.6",
  "opus-4-6": "anthropic/claude-opus-4.6",
  haiku: "anthropic/claude-haiku-4.5",
  // Claude - provider/shortname patterns (common in agent frameworks)
  "anthropic/sonnet": "anthropic/claude-sonnet-4.6",
  "anthropic/opus": "anthropic/claude-opus-4.6",
  "anthropic/haiku": "anthropic/claude-haiku-4.5",
  "anthropic/claude": "anthropic/claude-sonnet-4.6",
  // Backward compatibility - map all variants to 4.6
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4-6": "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5": "anthropic/claude-opus-4.6",
  "anthropic/claude-haiku-4": "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  // OpenAI
  gpt: "openai/gpt-4o",
  gpt4: "openai/gpt-4o",
  gpt5: "openai/gpt-5.2",
  codex: "openai/gpt-5.2-codex",
  mini: "openai/gpt-4o-mini",
  o1: "openai/o1",
  o3: "openai/o3",
  // DeepSeek
  deepseek: "deepseek/deepseek-chat",
  reasoner: "deepseek/deepseek-reasoner",
  // Kimi / Moonshot
  kimi: "moonshot/kimi-k2.5",
  // Google
  gemini: "google/gemini-2.5-pro",
  flash: "google/gemini-2.5-flash",
  // xAI
  grok: "xai/grok-3",
  "grok-fast": "xai/grok-4-fast-reasoning",
  "grok-code": "xai/grok-code-fast-1",
  // NVIDIA
  nvidia: "nvidia/gpt-oss-120b",
  "gpt-120b": "nvidia/gpt-oss-120b",
  // MiniMax
  minimax: "minimax/minimax-m2.5",
  // Routing profile aliases (common variations)
  "auto-router": "auto",
  router: "auto"
  // Note: auto, free, eco, premium are virtual routing profiles registered in BLOCKRUN_MODELS
  // They don't need aliases since they're already top-level model IDs
};
function resolveModelAlias(model) {
  const normalized = model.trim().toLowerCase();
  const resolved = MODEL_ALIASES[normalized];
  if (resolved) return resolved;
  if (normalized.startsWith("blockrun/")) {
    const withoutPrefix = normalized.slice("blockrun/".length);
    const resolvedWithoutPrefix = MODEL_ALIASES[withoutPrefix];
    if (resolvedWithoutPrefix) return resolvedWithoutPrefix;
    return withoutPrefix;
  }
  return model;
}
var BLOCKRUN_MODELS = [
  // Smart routing meta-models — proxy replaces with actual model
  // NOTE: Model IDs are WITHOUT provider prefix (OpenClaw adds "blockrun/" automatically)
  {
    id: "auto",
    name: "Auto (Smart Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 105e4,
    maxOutput: 128e3
  },
  {
    id: "free",
    name: "Free (NVIDIA GPT-OSS-120B only)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128e3,
    maxOutput: 4096
  },
  {
    id: "eco",
    name: "Eco (Smart Router - Cost Optimized)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 105e4,
    maxOutput: 128e3
  },
  {
    id: "premium",
    name: "Premium (Smart Router - Best Quality)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 2e6,
    maxOutput: 2e5
  },
  // OpenAI GPT-5 Family
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14,
    contextWindow: 4e5,
    maxOutput: 128e3,
    reasoning: true,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 Mini",
    version: "5.0",
    inputPrice: 0.25,
    outputPrice: 2,
    contextWindow: 2e5,
    maxOutput: 65536
  },
  {
    id: "openai/gpt-5-nano",
    name: "GPT-5 Nano",
    version: "5.0",
    inputPrice: 0.05,
    outputPrice: 0.4,
    contextWindow: 128e3,
    maxOutput: 32768
  },
  {
    id: "openai/gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    version: "5.2",
    inputPrice: 21,
    outputPrice: 168,
    contextWindow: 4e5,
    maxOutput: 128e3,
    reasoning: true
  },
  // OpenAI Codex Family
  {
    id: "openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    version: "5.2",
    inputPrice: 1.75,
    outputPrice: 14,
    contextWindow: 128e3,
    maxOutput: 32e3,
    agentic: true
  },
  // OpenAI GPT-4 Family
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    version: "4.1",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 128e3,
    maxOutput: 16384,
    vision: true
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    version: "4.1",
    inputPrice: 0.4,
    outputPrice: 1.6,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    version: "4.1",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    version: "4o",
    inputPrice: 2.5,
    outputPrice: 10,
    contextWindow: 128e3,
    maxOutput: 16384,
    vision: true,
    agentic: true
  },
  {
    id: "openai/gpt-4o-mini",
    name: "GPT-4o Mini",
    version: "4o-mini",
    inputPrice: 0.15,
    outputPrice: 0.6,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  // OpenAI O-series (Reasoning)
  {
    id: "openai/o1",
    name: "o1",
    version: "1",
    inputPrice: 15,
    outputPrice: 60,
    contextWindow: 2e5,
    maxOutput: 1e5,
    reasoning: true
  },
  {
    id: "openai/o1-mini",
    name: "o1-mini",
    version: "1-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128e3,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "openai/o3",
    name: "o3",
    version: "3",
    inputPrice: 2,
    outputPrice: 8,
    contextWindow: 2e5,
    maxOutput: 1e5,
    reasoning: true
  },
  {
    id: "openai/o3-mini",
    name: "o3-mini",
    version: "3-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128e3,
    maxOutput: 65536,
    reasoning: true
  },
  {
    id: "openai/o4-mini",
    name: "o4-mini",
    version: "4-mini",
    inputPrice: 1.1,
    outputPrice: 4.4,
    contextWindow: 128e3,
    maxOutput: 65536,
    reasoning: true
  },
  // Anthropic - all Claude models excel at agentic workflows
  // Use newest versions (4.6) with full provider prefix
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    version: "4.5",
    inputPrice: 1,
    outputPrice: 5,
    contextWindow: 2e5,
    maxOutput: 8192,
    agentic: true
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    version: "4.6",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 2e5,
    maxOutput: 64e3,
    reasoning: true,
    agentic: true
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    version: "4.6",
    inputPrice: 5,
    outputPrice: 25,
    contextWindow: 2e5,
    maxOutput: 32e3,
    reasoning: true,
    agentic: true
  },
  // Google
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    version: "3.1",
    inputPrice: 2,
    outputPrice: 12,
    contextWindow: 105e4,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    version: "3.0",
    inputPrice: 2,
    outputPrice: 12,
    contextWindow: 105e4,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    version: "3.0",
    inputPrice: 0.5,
    outputPrice: 3,
    contextWindow: 1e6,
    maxOutput: 65536,
    vision: true
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    version: "2.5",
    inputPrice: 1.25,
    outputPrice: 10,
    contextWindow: 105e4,
    maxOutput: 65536,
    reasoning: true,
    vision: true
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    version: "2.5",
    inputPrice: 0.3,
    outputPrice: 2.5,
    contextWindow: 1e6,
    maxOutput: 65536
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    version: "2.5",
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextWindow: 1e6,
    maxOutput: 65536
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek V3.2 Chat",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128e3,
    maxOutput: 8192
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek V3.2 Reasoner",
    version: "3.2",
    inputPrice: 0.28,
    outputPrice: 0.42,
    contextWindow: 128e3,
    maxOutput: 8192,
    reasoning: true
  },
  // Moonshot / Kimi - optimized for agentic workflows
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.6,
    outputPrice: 3,
    contextWindow: 262144,
    maxOutput: 8192,
    reasoning: true,
    vision: true,
    agentic: true
  },
  // xAI / Grok
  {
    id: "xai/grok-3",
    name: "Grok 3",
    version: "3",
    inputPrice: 3,
    outputPrice: 15,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  // grok-3-fast removed - too expensive ($5/$25), use grok-4-fast instead
  {
    id: "xai/grok-3-mini",
    name: "Grok 3 Mini",
    version: "3-mini",
    inputPrice: 0.3,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  // xAI Grok 4 Family - Ultra-cheap fast models
  {
    id: "xai/grok-4-fast-reasoning",
    name: "Grok 4 Fast Reasoning",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-fast-non-reasoning",
    name: "Grok 4 Fast",
    version: "4",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-4-1-fast-reasoning",
    name: "Grok 4.1 Fast Reasoning",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-4-1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    version: "4.1",
    inputPrice: 0.2,
    outputPrice: 0.5,
    contextWindow: 131072,
    maxOutput: 16384
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    version: "1",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    agentic: true
    // Good for coding tasks
  },
  {
    id: "xai/grok-4-0709",
    name: "Grok 4 (0709)",
    version: "4-0709",
    inputPrice: 0.2,
    outputPrice: 1.5,
    contextWindow: 131072,
    maxOutput: 16384,
    reasoning: true
  },
  {
    id: "xai/grok-2-vision",
    name: "Grok 2 Vision",
    version: "2",
    inputPrice: 2,
    outputPrice: 10,
    contextWindow: 131072,
    maxOutput: 16384,
    vision: true
  },
  // MiniMax
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    version: "m2.5",
    inputPrice: 0.3,
    outputPrice: 1.2,
    contextWindow: 204800,
    maxOutput: 16384,
    reasoning: true,
    agentic: true
  },
  // NVIDIA - Free/cheap models
  {
    id: "nvidia/gpt-oss-120b",
    name: "NVIDIA GPT-OSS 120B",
    version: "120b",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128e3,
    maxOutput: 16384
  },
  {
    id: "nvidia/kimi-k2.5",
    name: "NVIDIA Kimi K2.5",
    version: "k2.5",
    inputPrice: 0.55,
    outputPrice: 2.5,
    contextWindow: 262144,
    maxOutput: 16384
  }
];
function toOpenClawModel(m) {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput
  };
}
var ALIAS_MODELS = Object.entries(MODEL_ALIASES).map(([alias, targetId]) => {
  const target = BLOCKRUN_MODELS.find((m) => m.id === targetId);
  if (!target) return null;
  return toOpenClawModel({ ...target, id: alias, name: `${alias} \u2192 ${target.name}` });
}).filter((m) => m !== null);
var OPENCLAW_MODELS = [
  ...BLOCKRUN_MODELS.map(toOpenClawModel),
  ...ALIAS_MODELS
];
function getModelContextWindow(modelId) {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.contextWindow;
}
function isReasoningModel(modelId) {
  const normalized = modelId.replace("blockrun/", "");
  const model = BLOCKRUN_MODELS.find((m) => m.id === normalized);
  return model?.reasoning ?? false;
}

// src/logger.ts
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
var LOG_DIR = join(homedir(), ".openclaw", "blockrun", "logs");
var dirReady = false;
async function ensureDir() {
  if (dirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  dirReady = true;
}
async function logUsage(entry) {
  try {
    await ensureDir();
    const date = entry.timestamp.slice(0, 10);
    const file = join(LOG_DIR, `usage-${date}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch {
  }
}

// src/stats.ts
import { readdir } from "fs/promises";

// src/fs-read.ts
import { open } from "fs/promises";
import { openSync, readSync, closeSync, fstatSync } from "fs";
async function readTextFile(filePath) {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc((await fh.stat()).size);
    await fh.read(buf, 0, buf.length, 0);
    return buf.toString("utf-8");
  } finally {
    await fh.close();
  }
}

// src/stats.ts
import { join as join3 } from "path";
import { homedir as homedir2 } from "os";

// src/version.ts
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join as join2 } from "path";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var require2 = createRequire(import.meta.url);
var pkg = require2(join2(__dirname, "..", "package.json"));
var VERSION = pkg.version;
var USER_AGENT = `clawrouter/${VERSION}`;

// src/stats.ts
var LOG_DIR2 = join3(homedir2(), ".openclaw", "blockrun", "logs");
async function parseLogFile(filePath) {
  try {
    const content = await readTextFile(filePath);
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      const entry = JSON.parse(line);
      return {
        timestamp: entry.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
        model: entry.model || "unknown",
        tier: entry.tier || "UNKNOWN",
        cost: entry.cost || 0,
        baselineCost: entry.baselineCost || entry.cost || 0,
        savings: entry.savings || 0,
        latencyMs: entry.latencyMs || 0
      };
    });
  } catch {
    return [];
  }
}
async function getLogFiles() {
  try {
    const files = await readdir(LOG_DIR2);
    return files.filter((f) => f.startsWith("usage-") && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
}
function aggregateDay(date, entries) {
  const byTier = {};
  const byModel = {};
  let totalLatency = 0;
  for (const entry of entries) {
    if (!byTier[entry.tier]) byTier[entry.tier] = { count: 0, cost: 0 };
    byTier[entry.tier].count++;
    byTier[entry.tier].cost += entry.cost;
    if (!byModel[entry.model]) byModel[entry.model] = { count: 0, cost: 0 };
    byModel[entry.model].count++;
    byModel[entry.model].cost += entry.cost;
    totalLatency += entry.latencyMs;
  }
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const totalBaselineCost = entries.reduce((sum, e) => sum + e.baselineCost, 0);
  return {
    date,
    totalRequests: entries.length,
    totalCost,
    totalBaselineCost,
    totalSavings: totalBaselineCost - totalCost,
    avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
    byTier,
    byModel
  };
}
async function getStats(days = 7) {
  const logFiles = await getLogFiles();
  const filesToRead = logFiles.slice(0, days);
  const dailyBreakdown = [];
  const allByTier = {};
  const allByModel = {};
  let totalRequests = 0;
  let totalCost = 0;
  let totalBaselineCost = 0;
  let totalLatency = 0;
  for (const file of filesToRead) {
    const date = file.replace("usage-", "").replace(".jsonl", "");
    const filePath = join3(LOG_DIR2, file);
    const entries = await parseLogFile(filePath);
    if (entries.length === 0) continue;
    const dayStats = aggregateDay(date, entries);
    dailyBreakdown.push(dayStats);
    totalRequests += dayStats.totalRequests;
    totalCost += dayStats.totalCost;
    totalBaselineCost += dayStats.totalBaselineCost;
    totalLatency += dayStats.avgLatencyMs * dayStats.totalRequests;
    for (const [tier, stats] of Object.entries(dayStats.byTier)) {
      if (!allByTier[tier]) allByTier[tier] = { count: 0, cost: 0 };
      allByTier[tier].count += stats.count;
      allByTier[tier].cost += stats.cost;
    }
    for (const [model, stats] of Object.entries(dayStats.byModel)) {
      if (!allByModel[model]) allByModel[model] = { count: 0, cost: 0 };
      allByModel[model].count += stats.count;
      allByModel[model].cost += stats.cost;
    }
  }
  const byTierWithPercentage = {};
  for (const [tier, stats] of Object.entries(allByTier)) {
    byTierWithPercentage[tier] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const byModelWithPercentage = {};
  for (const [model, stats] of Object.entries(allByModel)) {
    byModelWithPercentage[model] = {
      ...stats,
      percentage: totalRequests > 0 ? stats.count / totalRequests * 100 : 0
    };
  }
  const totalSavings = totalBaselineCost - totalCost;
  const savingsPercentage = totalBaselineCost > 0 ? totalSavings / totalBaselineCost * 100 : 0;
  let entriesWithBaseline = 0;
  for (const day of dailyBreakdown) {
    if (day.totalBaselineCost !== day.totalCost) {
      entriesWithBaseline += day.totalRequests;
    }
  }
  return {
    period: days === 1 ? "today" : `last ${days} days`,
    totalRequests,
    totalCost,
    totalBaselineCost,
    totalSavings,
    savingsPercentage,
    avgLatencyMs: totalRequests > 0 ? totalLatency / totalRequests : 0,
    avgCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
    byTier: byTierWithPercentage,
    byModel: byModelWithPercentage,
    dailyBreakdown: dailyBreakdown.reverse(),
    // Oldest first for charts
    entriesWithBaseline
    // How many entries have valid baseline tracking
  };
}

// src/dedup.ts
import { createHash } from "crypto";
var DEFAULT_TTL_MS2 = 3e4;
var MAX_BODY_SIZE = 1048576;
function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function stripTimestamps(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(stripTimestamps);
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "content" && typeof value === "string") {
      result[key] = value.replace(TIMESTAMP_PATTERN, "");
    } else {
      result[key] = stripTimestamps(value);
    }
  }
  return result;
}
var RequestDeduplicator = class {
  inflight = /* @__PURE__ */ new Map();
  completed = /* @__PURE__ */ new Map();
  ttlMs;
  constructor(ttlMs = DEFAULT_TTL_MS2) {
    this.ttlMs = ttlMs;
  }
  /** Hash request body to create a dedup key. */
  static hash(body) {
    let content = body;
    try {
      const parsed = JSON.parse(body.toString());
      const stripped = stripTimestamps(parsed);
      const canonical = canonicalize(stripped);
      content = Buffer.from(JSON.stringify(canonical));
    } catch {
    }
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }
  /** Check if a response is cached for this key. */
  getCached(key) {
    const entry = this.completed.get(key);
    if (!entry) return void 0;
    if (Date.now() - entry.completedAt > this.ttlMs) {
      this.completed.delete(key);
      return void 0;
    }
    return entry;
  }
  /** Check if a request with this key is currently in-flight. Returns a promise to wait on. */
  getInflight(key) {
    const entry = this.inflight.get(key);
    if (!entry) return void 0;
    return new Promise((resolve) => {
      entry.resolvers.push(resolve);
    });
  }
  /** Mark a request as in-flight. */
  markInflight(key) {
    this.inflight.set(key, {
      resolvers: []
    });
  }
  /** Complete an in-flight request — cache result and notify waiters. */
  complete(key, result) {
    if (result.body.length <= MAX_BODY_SIZE) {
      this.completed.set(key, result);
    }
    const entry = this.inflight.get(key);
    if (entry) {
      for (const resolve of entry.resolvers) {
        resolve(result);
      }
      this.inflight.delete(key);
    }
    this.prune();
  }
  /** Remove an in-flight entry on error (don't cache failures).
   *  Also rejects any waiters so they can retry independently. */
  removeInflight(key) {
    const entry = this.inflight.get(key);
    if (entry) {
      const errorBody = Buffer.from(
        JSON.stringify({
          error: { message: "Original request failed, please retry", type: "dedup_origin_failed" }
        })
      );
      for (const resolve of entry.resolvers) {
        resolve({
          status: 503,
          headers: { "content-type": "application/json" },
          body: errorBody,
          completedAt: Date.now()
        });
      }
      this.inflight.delete(key);
    }
  }
  /** Prune expired completed entries. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.completed) {
      if (now - entry.completedAt > this.ttlMs) {
        this.completed.delete(key);
      }
    }
  }
};

// src/response-cache.ts
import { createHash as createHash2 } from "crypto";
var DEFAULT_CONFIG = {
  maxSize: 200,
  defaultTTL: 600,
  maxItemSize: 1048576,
  // 1MB
  enabled: true
};
function canonicalize2(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize2);
  }
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize2(obj[key]);
  }
  return sorted;
}
var TIMESTAMP_PATTERN2 = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/;
function normalizeForCache(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (["stream", "user", "request_id", "x-request-id"].includes(key)) {
      continue;
    }
    if (key === "messages" && Array.isArray(value)) {
      result[key] = value.map((msg) => {
        if (typeof msg === "object" && msg !== null) {
          const m = msg;
          if (typeof m.content === "string") {
            return { ...m, content: m.content.replace(TIMESTAMP_PATTERN2, "") };
          }
        }
        return msg;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}
var ResponseCache = class {
  cache = /* @__PURE__ */ new Map();
  expirationHeap = [];
  config;
  // Stats for monitoring
  stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };
  constructor(config = {}) {
    const filtered = Object.fromEntries(
      Object.entries(config).filter(([, v]) => v !== void 0)
    );
    this.config = { ...DEFAULT_CONFIG, ...filtered };
  }
  /**
   * Generate cache key from request body.
   * Hashes: model + messages + temperature + max_tokens + other params
   */
  static generateKey(body) {
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      const normalized = normalizeForCache(parsed);
      const canonical = canonicalize2(normalized);
      const keyContent = JSON.stringify(canonical);
      return createHash2("sha256").update(keyContent).digest("hex").slice(0, 32);
    } catch {
      const content = typeof body === "string" ? body : body.toString();
      return createHash2("sha256").update(content).digest("hex").slice(0, 32);
    }
  }
  /**
   * Check if caching is enabled for this request.
   * Respects cache control headers and request params.
   */
  shouldCache(body, headers) {
    if (!this.config.enabled) return false;
    if (headers?.["cache-control"]?.includes("no-cache")) {
      return false;
    }
    try {
      const parsed = JSON.parse(typeof body === "string" ? body : body.toString());
      if (parsed.cache === false || parsed.no_cache === true) {
        return false;
      }
    } catch {
    }
    return true;
  }
  /**
   * Get cached response if available and not expired.
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return void 0;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return void 0;
    }
    this.stats.hits++;
    return entry;
  }
  /**
   * Cache a response with optional custom TTL.
   */
  set(key, response, ttlSeconds) {
    if (!this.config.enabled || this.config.maxSize <= 0) return;
    if (response.body.length > this.config.maxItemSize) {
      console.log(`[ResponseCache] Skipping cache - item too large: ${response.body.length} bytes`);
      return;
    }
    if (response.status >= 400) {
      return;
    }
    if (this.cache.size >= this.config.maxSize) {
      this.evict();
    }
    const now = Date.now();
    const ttl = ttlSeconds ?? this.config.defaultTTL;
    const expiresAt = now + ttl * 1e3;
    const entry = {
      ...response,
      cachedAt: now,
      expiresAt
    };
    this.cache.set(key, entry);
    this.expirationHeap.push({ expiresAt, key });
  }
  /**
   * Evict expired and oldest entries to make room.
   */
  evict() {
    const now = Date.now();
    this.expirationHeap.sort((a, b) => a.expiresAt - b.expiresAt);
    while (this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap[0];
      const entry = this.cache.get(oldest.key);
      if (!entry || entry.expiresAt !== oldest.expiresAt) {
        this.expirationHeap.shift();
        continue;
      }
      if (oldest.expiresAt <= now) {
        this.cache.delete(oldest.key);
        this.expirationHeap.shift();
        this.stats.evictions++;
      } else {
        break;
      }
    }
    while (this.cache.size >= this.config.maxSize && this.expirationHeap.length > 0) {
      const oldest = this.expirationHeap.shift();
      if (this.cache.has(oldest.key)) {
        this.cache.delete(oldest.key);
        this.stats.evictions++;
      }
    }
  }
  /**
   * Get cache statistics.
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(1) + "%" : "0%";
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate
    };
  }
  /**
   * Clear all cached entries.
   */
  clear() {
    this.cache.clear();
    this.expirationHeap = [];
  }
  /**
   * Check if cache is enabled.
   */
  isEnabled() {
    return this.config.enabled;
  }
};

// src/balance.ts
import { createPublicClient, http, erc20Abi } from "viem";
import { base } from "viem/chains";

// src/errors.ts
var RpcError = class extends Error {
  code = "RPC_ERROR";
  originalError;
  constructor(message, originalError) {
    super(`RPC error: ${message}. Check network connectivity.`);
    this.name = "RpcError";
    this.originalError = originalError;
  }
};

// src/balance.ts
var USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
var CACHE_TTL_MS = 3e4;
var BALANCE_THRESHOLDS = {
  /** Low balance warning threshold: $1.00 */
  LOW_BALANCE_MICROS: 1000000n,
  /** Effectively zero threshold: $0.0001 (covers dust/rounding) */
  ZERO_THRESHOLD: 100n
};
var BalanceMonitor = class {
  client;
  walletAddress;
  /** Cached balance (null = not yet fetched) */
  cachedBalance = null;
  /** Timestamp when cache was last updated */
  cachedAt = 0;
  constructor(walletAddress) {
    this.walletAddress = walletAddress;
    this.client = createPublicClient({
      chain: base,
      transport: http(void 0, {
        timeout: 1e4
        // 10 second timeout to prevent hanging on slow RPC
      })
    });
  }
  /**
   * Check current USDC balance.
   * Uses cache if valid, otherwise fetches from RPC.
   */
  async checkBalance() {
    const now = Date.now();
    if (this.cachedBalance !== null && now - this.cachedAt < CACHE_TTL_MS) {
      return this.buildInfo(this.cachedBalance);
    }
    const balance = await this.fetchBalance();
    this.cachedBalance = balance;
    this.cachedAt = now;
    return this.buildInfo(balance);
  }
  /**
   * Check if balance is sufficient for an estimated cost.
   *
   * @param estimatedCostMicros - Estimated cost in USDC smallest unit (6 decimals)
   */
  async checkSufficient(estimatedCostMicros) {
    const info = await this.checkBalance();
    if (info.balance >= estimatedCostMicros) {
      return { sufficient: true, info };
    }
    const shortfall = estimatedCostMicros - info.balance;
    return {
      sufficient: false,
      info,
      shortfall: this.formatUSDC(shortfall)
    };
  }
  /**
   * Optimistically deduct estimated cost from cached balance.
   * Call this after a successful payment to keep cache accurate.
   *
   * @param amountMicros - Amount to deduct in USDC smallest unit
   */
  deductEstimated(amountMicros) {
    if (this.cachedBalance !== null && this.cachedBalance >= amountMicros) {
      this.cachedBalance -= amountMicros;
    }
  }
  /**
   * Invalidate cache, forcing next checkBalance() to fetch from RPC.
   * Call this after a payment failure to get accurate balance.
   */
  invalidate() {
    this.cachedBalance = null;
    this.cachedAt = 0;
  }
  /**
   * Force refresh balance from RPC (ignores cache).
   */
  async refresh() {
    this.invalidate();
    return this.checkBalance();
  }
  /**
   * Format USDC amount (in micros) as "$X.XX".
   */
  formatUSDC(amountMicros) {
    const dollars = Number(amountMicros) / 1e6;
    return `$${dollars.toFixed(2)}`;
  }
  /**
   * Get the wallet address being monitored.
   */
  getWalletAddress() {
    return this.walletAddress;
  }
  /** Fetch balance from RPC */
  async fetchBalance() {
    try {
      const balance = await this.client.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.walletAddress]
      });
      return balance;
    } catch (error) {
      throw new RpcError(error instanceof Error ? error.message : "Unknown error", error);
    }
  }
  /** Build BalanceInfo from raw balance */
  buildInfo(balance) {
    return {
      balance,
      balanceUSD: this.formatUSDC(balance),
      isLow: balance < BALANCE_THRESHOLDS.LOW_BALANCE_MICROS,
      isEmpty: balance < BALANCE_THRESHOLDS.ZERO_THRESHOLD,
      walletAddress: this.walletAddress
    };
  }
};

// src/compression/types.ts
var DEFAULT_COMPRESSION_CONFIG = {
  enabled: true,
  preserveRaw: true,
  layers: {
    deduplication: true,
    // Safe: removes duplicate messages
    whitespace: true,
    // Safe: normalizes whitespace
    dictionary: false,
    // DISABLED: requires model to understand codebook
    paths: false,
    // DISABLED: requires model to understand path codes
    jsonCompact: true,
    // Safe: just removes JSON whitespace
    observation: false,
    // DISABLED: may lose important context
    dynamicCodebook: false
    // DISABLED: requires model to understand codes
  },
  dictionary: {
    maxEntries: 50,
    minPhraseLength: 15,
    includeCodebookHeader: false
    // No codebook header needed
  }
};

// src/compression/layers/deduplication.ts
import crypto2 from "crypto";
function hashMessage(message) {
  let contentStr = "";
  if (typeof message.content === "string") {
    contentStr = message.content;
  } else if (Array.isArray(message.content)) {
    contentStr = JSON.stringify(message.content);
  }
  const parts = [message.role, contentStr, message.tool_call_id || "", message.name || ""];
  if (message.tool_calls) {
    parts.push(
      JSON.stringify(
        message.tool_calls.map((tc) => ({
          name: tc.function.name,
          args: tc.function.arguments
        }))
      )
    );
  }
  const content = parts.join("|");
  return crypto2.createHash("md5").update(content).digest("hex");
}
function deduplicateMessages(messages) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  let duplicatesRemoved = 0;
  const referencedToolCallIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      referencedToolCallIds.add(message.tool_call_id);
    }
  }
  for (const message of messages) {
    if (message.role === "system") {
      result.push(message);
      continue;
    }
    if (message.role === "user") {
      result.push(message);
      continue;
    }
    if (message.role === "tool") {
      result.push(message);
      continue;
    }
    if (message.role === "assistant" && message.tool_calls) {
      const hasReferencedToolCall = message.tool_calls.some(
        (tc) => referencedToolCallIds.has(tc.id)
      );
      if (hasReferencedToolCall) {
        result.push(message);
        continue;
      }
    }
    const hash = hashMessage(message);
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(message);
    } else {
      duplicatesRemoved++;
    }
  }
  return {
    messages: result,
    duplicatesRemoved,
    originalCount: messages.length
  };
}

// src/compression/layers/whitespace.ts
function normalizeWhitespace(content) {
  if (!content || typeof content !== "string") return content;
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").replace(/([^\n]) {2,}/g, "$1 ").replace(/^[ ]{8,}/gm, (match) => "  ".repeat(Math.ceil(match.length / 4))).replace(/\t/g, "  ").trim();
}
function normalizeMessagesWhitespace(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const originalLength = message.content.length;
    const normalizedContent = normalizeWhitespace(message.content);
    charsSaved += originalLength - normalizedContent.length;
    return {
      ...message,
      content: normalizedContent
    };
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/codebook.ts
var STATIC_CODEBOOK = {
  // High-impact: OpenClaw/Agent system prompt patterns (very common)
  $OC01: "unbrowse_",
  // Common prefix in tool names
  $OC02: "<location>",
  $OC03: "</location>",
  $OC04: "<name>",
  $OC05: "</name>",
  $OC06: "<description>",
  $OC07: "</description>",
  $OC08: "(may need login)",
  $OC09: "API skill for OpenClaw",
  $OC10: "endpoints",
  // Skill/tool markers
  $SK01: "<available_skills>",
  $SK02: "</available_skills>",
  $SK03: "<skill>",
  $SK04: "</skill>",
  // Schema patterns (very common in tool definitions)
  $T01: 'type: "function"',
  $T02: '"type": "function"',
  $T03: '"type": "string"',
  $T04: '"type": "object"',
  $T05: '"type": "array"',
  $T06: '"type": "boolean"',
  $T07: '"type": "number"',
  // Common descriptions
  $D01: "description:",
  $D02: '"description":',
  // Common instructions
  $I01: "You are a personal assistant",
  $I02: "Tool names are case-sensitive",
  $I03: "Call tools exactly as listed",
  $I04: "Use when",
  $I05: "without asking",
  // Safety phrases
  $S01: "Do not manipulate or persuade",
  $S02: "Prioritize safety and human oversight",
  $S03: "unless explicitly requested",
  // JSON patterns
  $J01: '"required": ["',
  $J02: '"properties": {',
  $J03: '"additionalProperties": false',
  // Heartbeat patterns
  $H01: "HEARTBEAT_OK",
  $H02: "Read HEARTBEAT.md if it exists",
  // Role markers
  $R01: '"role": "system"',
  $R02: '"role": "user"',
  $R03: '"role": "assistant"',
  $R04: '"role": "tool"',
  // Common endings/phrases
  $E01: "would you like to",
  $E02: "Let me know if you",
  $E03: "internal APIs",
  $E04: "session cookies",
  // BlockRun model aliases (common in prompts)
  $M01: "blockrun/",
  $M02: "openai/",
  $M03: "anthropic/",
  $M04: "google/",
  $M05: "xai/"
};
function getInverseCodebook() {
  const inverse = {};
  for (const [code, phrase] of Object.entries(STATIC_CODEBOOK)) {
    inverse[phrase] = code;
  }
  return inverse;
}
function generateCodebookHeader(usedCodes, pathMap = {}) {
  if (usedCodes.size === 0 && Object.keys(pathMap).length === 0) {
    return "";
  }
  const parts = [];
  if (usedCodes.size > 0) {
    const codeEntries = Array.from(usedCodes).map((code) => `${code}=${STATIC_CODEBOOK[code]}`).join(", ");
    parts.push(`[Dict: ${codeEntries}]`);
  }
  if (Object.keys(pathMap).length > 0) {
    const pathEntries = Object.entries(pathMap).map(([code, path]) => `${code}=${path}`).join(", ");
    parts.push(`[Paths: ${pathEntries}]`);
  }
  return parts.join("\n");
}

// src/compression/layers/dictionary.ts
function encodeContent(content, inverseCodebook) {
  if (!content || typeof content !== "string") {
    return { encoded: content, substitutions: 0, codes: /* @__PURE__ */ new Set(), charsSaved: 0 };
  }
  let encoded = content;
  let substitutions = 0;
  let charsSaved = 0;
  const codes = /* @__PURE__ */ new Set();
  const phrases = Object.keys(inverseCodebook).sort((a, b) => b.length - a.length);
  for (const phrase of phrases) {
    const code = inverseCodebook[phrase];
    const regex = new RegExp(escapeRegex(phrase), "g");
    const matches = encoded.match(regex);
    if (matches && matches.length > 0) {
      encoded = encoded.replace(regex, code);
      substitutions += matches.length;
      charsSaved += matches.length * (phrase.length - code.length);
      codes.add(code);
    }
  }
  return { encoded, substitutions, codes, charsSaved };
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function encodeMessages(messages) {
  const inverseCodebook = getInverseCodebook();
  let totalSubstitutions = 0;
  let totalCharsSaved = 0;
  const allUsedCodes = /* @__PURE__ */ new Set();
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    const { encoded, substitutions, codes, charsSaved } = encodeContent(
      message.content,
      inverseCodebook
    );
    totalSubstitutions += substitutions;
    totalCharsSaved += charsSaved;
    codes.forEach((code) => allUsedCodes.add(code));
    return {
      ...message,
      content: encoded
    };
  });
  return {
    messages: result,
    substitutionCount: totalSubstitutions,
    usedCodes: allUsedCodes,
    charsSaved: totalCharsSaved
  };
}

// src/compression/layers/paths.ts
var PATH_REGEX = /(?:\/[\w.-]+){3,}/g;
function extractPaths(messages) {
  const paths = [];
  for (const message of messages) {
    if (!message.content || typeof message.content !== "string") continue;
    const matches = message.content.match(PATH_REGEX);
    if (matches) {
      paths.push(...matches);
    }
  }
  return paths;
}
function findFrequentPrefixes(paths) {
  const prefixCounts = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 2; i < parts.length; i++) {
      const prefix = "/" + parts.slice(0, i).join("/") + "/";
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }
  return Array.from(prefixCounts.entries()).filter(([, count]) => count >= 3).sort((a, b) => b[0].length - a[0].length).slice(0, 5).map(([prefix]) => prefix);
}
function shortenPaths(messages) {
  const allPaths = extractPaths(messages);
  if (allPaths.length < 5) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const prefixes = findFrequentPrefixes(allPaths);
  if (prefixes.length === 0) {
    return {
      messages,
      pathMap: {},
      charsSaved: 0
    };
  }
  const pathMap = {};
  prefixes.forEach((prefix, i) => {
    pathMap[`$P${i + 1}`] = prefix;
  });
  let charsSaved = 0;
  const result = messages.map((message) => {
    if (!message.content || typeof message.content !== "string") return message;
    let content = message.content;
    const originalLength = content.length;
    for (const [code, prefix] of Object.entries(pathMap)) {
      content = content.split(prefix).join(code + "/");
    }
    charsSaved += originalLength - content.length;
    return {
      ...message,
      content
    };
  });
  return {
    messages: result,
    pathMap,
    charsSaved
  };
}

// src/compression/layers/json-compact.ts
function compactJson(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    return JSON.stringify(parsed);
  } catch {
    return jsonString;
  }
}
function looksLikeJson(str) {
  const trimmed = str.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]");
}
function compactToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    ...tc,
    function: {
      ...tc.function,
      arguments: compactJson(tc.function.arguments)
    }
  }));
}
function compactMessagesJson(messages) {
  let charsSaved = 0;
  const result = messages.map((message) => {
    const newMessage = { ...message };
    if (message.tool_calls && message.tool_calls.length > 0) {
      const originalLength = JSON.stringify(message.tool_calls).length;
      newMessage.tool_calls = compactToolCalls(message.tool_calls);
      const newLength = JSON.stringify(newMessage.tool_calls).length;
      charsSaved += originalLength - newLength;
    }
    if (message.role === "tool" && message.content && typeof message.content === "string" && looksLikeJson(message.content)) {
      const originalLength = message.content.length;
      const compacted = compactJson(message.content);
      charsSaved += originalLength - compacted.length;
      newMessage.content = compacted;
    }
    return newMessage;
  });
  return {
    messages: result,
    charsSaved
  };
}

// src/compression/layers/observation.ts
var TOOL_RESULT_THRESHOLD = 500;
var COMPRESSED_RESULT_MAX = 300;
function compressToolResult(content) {
  if (!content || content.length <= TOOL_RESULT_THRESHOLD) {
    return content;
  }
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const errorLines = lines.filter(
    (l) => /error|exception|failed|denied|refused|timeout|invalid/i.test(l) && l.length < 200
  );
  const statusLines = lines.filter(
    (l) => /success|complete|created|updated|found|result|status|total|count/i.test(l) && l.length < 150
  );
  const jsonMatches = [];
  const jsonPattern = /"(id|name|status|error|message|count|total|url|path)":\s*"?([^",}\n]+)"?/gi;
  let match;
  while ((match = jsonPattern.exec(content)) !== null) {
    jsonMatches.push(`${match[1]}: ${match[2].slice(0, 50)}`);
  }
  const firstLine = lines[0]?.slice(0, 100);
  const lastLine = lines.length > 1 ? lines[lines.length - 1]?.slice(0, 100) : "";
  const parts = [];
  if (errorLines.length > 0) {
    parts.push("[ERR] " + errorLines.slice(0, 3).join(" | "));
  }
  if (statusLines.length > 0) {
    parts.push(statusLines.slice(0, 3).join(" | "));
  }
  if (jsonMatches.length > 0) {
    parts.push(jsonMatches.slice(0, 5).join(", "));
  }
  if (parts.length === 0) {
    parts.push(firstLine || "");
    if (lines.length > 2) {
      parts.push(`[...${lines.length - 2} lines...]`);
    }
    if (lastLine && lastLine !== firstLine) {
      parts.push(lastLine);
    }
  }
  let result = parts.join("\n");
  if (result.length > COMPRESSED_RESULT_MAX) {
    result = result.slice(0, COMPRESSED_RESULT_MAX - 20) + "\n[...truncated]";
  }
  return result;
}
function deduplicateLargeBlocks(messages) {
  const blockHashes = /* @__PURE__ */ new Map();
  let charsSaved = 0;
  const result = messages.map((msg, idx) => {
    if (!msg.content || typeof msg.content !== "string" || msg.content.length < 500) {
      return msg;
    }
    const blockKey = msg.content.slice(0, 200);
    if (blockHashes.has(blockKey)) {
      const firstIdx = blockHashes.get(blockKey);
      const original = msg.content;
      const compressed = `[See message #${firstIdx + 1} - same content]`;
      charsSaved += original.length - compressed.length;
      return { ...msg, content: compressed };
    }
    blockHashes.set(blockKey, idx);
    return msg;
  });
  return { messages: result, charsSaved };
}
function compressObservations(messages) {
  let charsSaved = 0;
  let observationsCompressed = 0;
  let result = messages.map((msg) => {
    if (msg.role !== "tool" || !msg.content || typeof msg.content !== "string") {
      return msg;
    }
    const original = msg.content;
    if (original.length <= TOOL_RESULT_THRESHOLD) {
      return msg;
    }
    const compressed = compressToolResult(original);
    const saved = original.length - compressed.length;
    if (saved > 50) {
      charsSaved += saved;
      observationsCompressed++;
      return { ...msg, content: compressed };
    }
    return msg;
  });
  const dedupResult = deduplicateLargeBlocks(result);
  result = dedupResult.messages;
  charsSaved += dedupResult.charsSaved;
  return {
    messages: result,
    charsSaved,
    observationsCompressed
  };
}

// src/compression/layers/dynamic-codebook.ts
var MIN_PHRASE_LENGTH = 20;
var MAX_PHRASE_LENGTH = 200;
var MIN_FREQUENCY = 3;
var MAX_ENTRIES = 100;
var CODE_PREFIX = "$D";
function findRepeatedPhrases(allContent) {
  const phrases = /* @__PURE__ */ new Map();
  const segments = allContent.split(/(?<=[.!?\n])\s+/);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  const lines = allContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length >= MIN_PHRASE_LENGTH && trimmed.length <= MAX_PHRASE_LENGTH) {
      phrases.set(trimmed, (phrases.get(trimmed) || 0) + 1);
    }
  }
  return phrases;
}
function buildDynamicCodebook(messages) {
  let allContent = "";
  for (const msg of messages) {
    if (msg.content && typeof msg.content === "string") {
      allContent += msg.content + "\n";
    }
  }
  const phrases = findRepeatedPhrases(allContent);
  const candidates = [];
  for (const [phrase, count] of phrases.entries()) {
    if (count >= MIN_FREQUENCY) {
      const codeLength = 4;
      const savings = (phrase.length - codeLength) * count;
      if (savings > 50) {
        candidates.push({ phrase, count, savings });
      }
    }
  }
  candidates.sort((a, b) => b.savings - a.savings);
  const topCandidates = candidates.slice(0, MAX_ENTRIES);
  const codebook = {};
  topCandidates.forEach((c, i) => {
    const code = `${CODE_PREFIX}${String(i + 1).padStart(2, "0")}`;
    codebook[code] = c.phrase;
  });
  return codebook;
}
function escapeRegex2(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function applyDynamicCodebook(messages) {
  const codebook = buildDynamicCodebook(messages);
  if (Object.keys(codebook).length === 0) {
    return {
      messages,
      charsSaved: 0,
      dynamicCodes: {},
      substitutions: 0
    };
  }
  const phraseToCode = {};
  for (const [code, phrase] of Object.entries(codebook)) {
    phraseToCode[phrase] = code;
  }
  const sortedPhrases = Object.keys(phraseToCode).sort((a, b) => b.length - a.length);
  let charsSaved = 0;
  let substitutions = 0;
  const result = messages.map((msg) => {
    if (!msg.content || typeof msg.content !== "string") return msg;
    let content = msg.content;
    for (const phrase of sortedPhrases) {
      const code = phraseToCode[phrase];
      const regex = new RegExp(escapeRegex2(phrase), "g");
      const matches = content.match(regex);
      if (matches) {
        content = content.replace(regex, code);
        charsSaved += (phrase.length - code.length) * matches.length;
        substitutions += matches.length;
      }
    }
    return { ...msg, content };
  });
  return {
    messages: result,
    charsSaved,
    dynamicCodes: codebook,
    substitutions
  };
}
function generateDynamicCodebookHeader(codebook) {
  if (Object.keys(codebook).length === 0) return "";
  const entries = Object.entries(codebook).slice(0, 20).map(([code, phrase]) => {
    const displayPhrase = phrase.length > 40 ? phrase.slice(0, 37) + "..." : phrase;
    return `${code}=${displayPhrase}`;
  }).join(", ");
  return `[DynDict: ${entries}]`;
}

// src/compression/index.ts
function calculateTotalChars(messages) {
  return messages.reduce((total, msg) => {
    let chars = 0;
    if (typeof msg.content === "string") {
      chars = msg.content.length;
    } else if (Array.isArray(msg.content)) {
      chars = JSON.stringify(msg.content).length;
    }
    if (msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }
    return total + chars;
  }, 0);
}
function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}
function prependCodebookHeader(messages, usedCodes, pathMap) {
  const header = generateCodebookHeader(usedCodes, pathMap);
  if (!header) return messages;
  const userIndex = messages.findIndex((m) => m.role === "user");
  if (userIndex === -1) {
    return [{ role: "system", content: header }, ...messages];
  }
  return messages.map((msg, i) => {
    if (i === userIndex) {
      if (typeof msg.content === "string") {
        return {
          ...msg,
          content: `${header}

${msg.content}`
        };
      }
    }
    return msg;
  });
}
async function compressContext(messages, config = {}) {
  const fullConfig = {
    ...DEFAULT_COMPRESSION_CONFIG,
    ...config,
    layers: {
      ...DEFAULT_COMPRESSION_CONFIG.layers,
      ...config.layers
    },
    dictionary: {
      ...DEFAULT_COMPRESSION_CONFIG.dictionary,
      ...config.dictionary
    }
  };
  if (!fullConfig.enabled) {
    const originalChars2 = calculateTotalChars(messages);
    return {
      messages,
      originalMessages: messages,
      originalChars: originalChars2,
      compressedChars: originalChars2,
      compressionRatio: 1,
      stats: {
        duplicatesRemoved: 0,
        whitespaceSavedChars: 0,
        dictionarySubstitutions: 0,
        pathsShortened: 0,
        jsonCompactedChars: 0,
        observationsCompressed: 0,
        observationCharsSaved: 0,
        dynamicSubstitutions: 0,
        dynamicCharsSaved: 0
      },
      codebook: {},
      pathMap: {},
      dynamicCodes: {}
    };
  }
  const originalMessages = fullConfig.preserveRaw ? cloneMessages(messages) : messages;
  const originalChars = calculateTotalChars(messages);
  const stats = {
    duplicatesRemoved: 0,
    whitespaceSavedChars: 0,
    dictionarySubstitutions: 0,
    pathsShortened: 0,
    jsonCompactedChars: 0,
    observationsCompressed: 0,
    observationCharsSaved: 0,
    dynamicSubstitutions: 0,
    dynamicCharsSaved: 0
  };
  let result = cloneMessages(messages);
  let usedCodes = /* @__PURE__ */ new Set();
  let pathMap = {};
  let dynamicCodes = {};
  if (fullConfig.layers.deduplication) {
    const dedupResult = deduplicateMessages(result);
    result = dedupResult.messages;
    stats.duplicatesRemoved = dedupResult.duplicatesRemoved;
  }
  if (fullConfig.layers.whitespace) {
    const wsResult = normalizeMessagesWhitespace(result);
    result = wsResult.messages;
    stats.whitespaceSavedChars = wsResult.charsSaved;
  }
  if (fullConfig.layers.dictionary) {
    const dictResult = encodeMessages(result);
    result = dictResult.messages;
    stats.dictionarySubstitutions = dictResult.substitutionCount;
    usedCodes = dictResult.usedCodes;
  }
  if (fullConfig.layers.paths) {
    const pathResult = shortenPaths(result);
    result = pathResult.messages;
    pathMap = pathResult.pathMap;
    stats.pathsShortened = Object.keys(pathMap).length;
  }
  if (fullConfig.layers.jsonCompact) {
    const jsonResult = compactMessagesJson(result);
    result = jsonResult.messages;
    stats.jsonCompactedChars = jsonResult.charsSaved;
  }
  if (fullConfig.layers.observation) {
    const obsResult = compressObservations(result);
    result = obsResult.messages;
    stats.observationsCompressed = obsResult.observationsCompressed;
    stats.observationCharsSaved = obsResult.charsSaved;
  }
  if (fullConfig.layers.dynamicCodebook) {
    const dynResult = applyDynamicCodebook(result);
    result = dynResult.messages;
    stats.dynamicSubstitutions = dynResult.substitutions;
    stats.dynamicCharsSaved = dynResult.charsSaved;
    dynamicCodes = dynResult.dynamicCodes;
  }
  if (fullConfig.dictionary.includeCodebookHeader && (usedCodes.size > 0 || Object.keys(pathMap).length > 0 || Object.keys(dynamicCodes).length > 0)) {
    result = prependCodebookHeader(result, usedCodes, pathMap);
    if (Object.keys(dynamicCodes).length > 0) {
      const dynHeader = generateDynamicCodebookHeader(dynamicCodes);
      if (dynHeader) {
        const systemIndex = result.findIndex((m) => m.role === "system");
        if (systemIndex >= 0 && typeof result[systemIndex].content === "string") {
          result[systemIndex] = {
            ...result[systemIndex],
            content: `${dynHeader}
${result[systemIndex].content}`
          };
        }
      }
    }
  }
  const compressedChars = calculateTotalChars(result);
  const compressionRatio = compressedChars / originalChars;
  const usedCodebook = {};
  usedCodes.forEach((code) => {
    usedCodebook[code] = STATIC_CODEBOOK[code];
  });
  return {
    messages: result,
    originalMessages,
    originalChars,
    compressedChars,
    compressionRatio,
    stats,
    codebook: usedCodebook,
    pathMap,
    dynamicCodes
  };
}
function shouldCompress(messages) {
  const chars = calculateTotalChars(messages);
  return chars > 5e3;
}

// src/session.ts
var DEFAULT_SESSION_CONFIG = {
  enabled: false,
  timeoutMs: 30 * 60 * 1e3,
  // 30 minutes
  headerName: "x-session-id"
};
var SessionStore = class {
  sessions = /* @__PURE__ */ new Map();
  config;
  cleanupInterval = null;
  constructor(config = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };
    if (this.config.enabled) {
      this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1e3);
    }
  }
  /**
   * Get the pinned model for a session, if any.
   */
  getSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return void 0;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return void 0;
    }
    const now = Date.now();
    if (now - entry.lastUsedAt > this.config.timeoutMs) {
      this.sessions.delete(sessionId);
      return void 0;
    }
    return entry;
  }
  /**
   * Pin a model to a session.
   */
  setSession(sessionId, model, tier) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const existing = this.sessions.get(sessionId);
    const now = Date.now();
    if (existing) {
      existing.lastUsedAt = now;
      existing.requestCount++;
      if (existing.model !== model) {
        existing.model = model;
        existing.tier = tier;
      }
    } else {
      this.sessions.set(sessionId, {
        model,
        tier,
        createdAt: now,
        lastUsedAt: now,
        requestCount: 1
      });
    }
  }
  /**
   * Touch a session to extend its timeout.
   */
  touchSession(sessionId) {
    if (!this.config.enabled || !sessionId) {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      entry.requestCount++;
    }
  }
  /**
   * Clear a specific session.
   */
  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }
  /**
   * Clear all sessions.
   */
  clearAll() {
    this.sessions.clear();
  }
  /**
   * Get session stats for debugging.
   */
  getStats() {
    const now = Date.now();
    const sessions = Array.from(this.sessions.entries()).map(([id, entry]) => ({
      id: id.slice(0, 8) + "...",
      model: entry.model,
      age: Math.round((now - entry.createdAt) / 1e3)
    }));
    return { count: this.sessions.size, sessions };
  }
  /**
   * Clean up expired sessions.
   */
  cleanup() {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.config.timeoutMs) {
        this.sessions.delete(id);
      }
    }
  }
  /**
   * Stop the cleanup interval.
   */
  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
};
function getSessionId(headers, headerName = DEFAULT_SESSION_CONFIG.headerName) {
  const value = headers[headerName] || headers[headerName.toLowerCase()];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return void 0;
}

// src/updater.ts
var NPM_REGISTRY = "https://registry.npmjs.org/@blockrun/clawrouter/latest";
var UPDATE_URL = "https://blockrun.ai/ClawRouter-update";
var CHECK_TIMEOUT_MS = 5e3;
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
async function checkForUpdates() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const res = await fetch(NPM_REGISTRY, {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();
    const latest = data.version;
    if (!latest) return;
    if (compareSemver(latest, VERSION) > 0) {
      console.log("");
      console.log(`\x1B[33m\u2B06\uFE0F  ClawRouter ${latest} available (you have ${VERSION})\x1B[0m`);
      console.log(`   Run: \x1B[36mcurl -fsSL ${UPDATE_URL} | bash\x1B[0m`);
      console.log("");
    }
  } catch {
  }
}

// src/config.ts
var DEFAULT_PORT = 8402;
var PROXY_PORT = (() => {
  const envPort = process["env"].BLOCKRUN_PROXY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
})();

// src/journal.ts
var DEFAULT_CONFIG2 = {
  maxEntries: 100,
  maxAgeMs: 24 * 60 * 60 * 1e3,
  // 24 hours
  maxEventsPerResponse: 5
};
var SessionJournal = class {
  journals = /* @__PURE__ */ new Map();
  config;
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG2, ...config };
  }
  /**
   * Extract key events from assistant response content.
   * Looks for patterns like "I created...", "I fixed...", "Successfully..."
   */
  extractEvents(content) {
    if (!content || typeof content !== "string") {
      return [];
    }
    const events = [];
    const seen = /* @__PURE__ */ new Set();
    const patterns = [
      // Creation patterns
      /I (?:also |then |have |)?(?:created|implemented|added|wrote|built|generated|set up|initialized) ([^.!?\n]{10,150})/gi,
      // Fix patterns
      /I (?:also |then |have |)?(?:fixed|resolved|solved|patched|corrected|addressed|debugged) ([^.!?\n]{10,150})/gi,
      // Completion patterns
      /I (?:also |then |have |)?(?:completed|finished|done with|wrapped up) ([^.!?\n]{10,150})/gi,
      // Update patterns
      /I (?:also |then |have |)?(?:updated|modified|changed|refactored|improved|enhanced|optimized) ([^.!?\n]{10,150})/gi,
      // Success patterns
      /Successfully ([^.!?\n]{10,150})/gi,
      // Tool usage patterns (when agent uses tools)
      /I (?:also |then |have |)?(?:ran|executed|called|invoked) ([^.!?\n]{10,100})/gi
    ];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const action = match[0].trim();
        const normalized = action.toLowerCase();
        if (seen.has(normalized)) {
          continue;
        }
        if (action.length >= 15 && action.length <= 200) {
          events.push(action);
          seen.add(normalized);
        }
        if (events.length >= this.config.maxEventsPerResponse) {
          break;
        }
      }
      if (events.length >= this.config.maxEventsPerResponse) {
        break;
      }
    }
    return events;
  }
  /**
   * Record events to the session journal.
   */
  record(sessionId, events, model) {
    if (!sessionId || !events.length) {
      return;
    }
    const journal = this.journals.get(sessionId) || [];
    const now = Date.now();
    for (const action of events) {
      journal.push({
        timestamp: now,
        action,
        model
      });
    }
    const cutoff = now - this.config.maxAgeMs;
    const trimmed = journal.filter((e) => e.timestamp > cutoff).slice(-this.config.maxEntries);
    this.journals.set(sessionId, trimmed);
  }
  /**
   * Check if the user message indicates a need for historical context.
   */
  needsContext(lastUserMessage) {
    if (!lastUserMessage || typeof lastUserMessage !== "string") {
      return false;
    }
    const lower = lastUserMessage.toLowerCase();
    const triggers = [
      // Direct questions about past work
      "what did you do",
      "what have you done",
      "what did we do",
      "what have we done",
      // Temporal references
      "earlier",
      "before",
      "previously",
      "this session",
      "today",
      "so far",
      // Summary requests
      "remind me",
      "summarize",
      "summary of",
      "recap",
      // Progress inquiries
      "your work",
      "your progress",
      "accomplished",
      "achievements",
      "completed tasks"
    ];
    return triggers.some((t) => lower.includes(t));
  }
  /**
   * Format the journal for injection into system message.
   * Returns null if journal is empty.
   */
  format(sessionId) {
    const journal = this.journals.get(sessionId);
    if (!journal?.length) {
      return null;
    }
    const lines = journal.map((e) => {
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
      });
      return `- ${time}: ${e.action}`;
    });
    return `[Session Memory - Key Actions]
${lines.join("\n")}`;
  }
  /**
   * Get the raw journal entries for a session (for debugging/testing).
   */
  getEntries(sessionId) {
    return this.journals.get(sessionId) || [];
  }
  /**
   * Clear journal for a specific session.
   */
  clear(sessionId) {
    this.journals.delete(sessionId);
  }
  /**
   * Clear all journals.
   */
  clearAll() {
    this.journals.clear();
  }
  /**
   * Get stats about the journal.
   */
  getStats() {
    let totalEntries = 0;
    for (const entries of this.journals.values()) {
      totalEntries += entries.length;
    }
    return {
      sessions: this.journals.size,
      totalEntries
    };
  }
};

// src/proxy.ts
var BLOCKRUN_API = "https://blockrun.ai/api";
var AUTO_MODEL = "blockrun/auto";
var ROUTING_PROFILES = /* @__PURE__ */ new Set([
  "blockrun/free",
  "free",
  "blockrun/eco",
  "eco",
  "blockrun/auto",
  "auto",
  "blockrun/premium",
  "premium"
]);
var FREE_MODEL = "nvidia/gpt-oss-120b";
var MAX_MESSAGES = 200;
var CONTEXT_LIMIT_KB = 5120;
var HEARTBEAT_INTERVAL_MS = 2e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 18e4;
var MAX_FALLBACK_ATTEMPTS = 5;
var HEALTH_CHECK_TIMEOUT_MS = 2e3;
var RATE_LIMIT_COOLDOWN_MS = 6e4;
var PORT_RETRY_ATTEMPTS = 5;
var PORT_RETRY_DELAY_MS = 1e3;
function transformPaymentError(errorBody) {
  try {
    const parsed = JSON.parse(errorBody);
    if (parsed.error === "Payment verification failed" && parsed.details) {
      const match = parsed.details.match(/Verification failed:\s*(\{.*\})/s);
      if (match) {
        const innerJson = JSON.parse(match[1]);
        if (innerJson.invalidReason === "insufficient_funds" && innerJson.invalidMessage) {
          const balanceMatch = innerJson.invalidMessage.match(
            /insufficient balance:\s*(\d+)\s*<\s*(\d+)/i
          );
          if (balanceMatch) {
            const currentMicros = parseInt(balanceMatch[1], 10);
            const requiredMicros = parseInt(balanceMatch[2], 10);
            const currentUSD = (currentMicros / 1e6).toFixed(6);
            const requiredUSD = (requiredMicros / 1e6).toFixed(6);
            const wallet = innerJson.payer || "unknown";
            const shortWallet = wallet.length > 12 ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : wallet;
            return JSON.stringify({
              error: {
                message: `Insufficient USDC balance. Current: $${currentUSD}, Required: ~$${requiredUSD}`,
                type: "insufficient_funds",
                wallet,
                current_balance_usd: currentUSD,
                required_usd: requiredUSD,
                help: `Fund wallet ${shortWallet} with USDC on Base, or use free model: /model free`
              }
            });
          }
        }
        if (innerJson.invalidReason === "invalid_payload") {
          return JSON.stringify({
            error: {
              message: "Payment signature invalid. This may be a temporary issue.",
              type: "invalid_payload",
              help: "Try again. If this persists, reinstall ClawRouter: curl -fsSL https://blockrun.ai/ClawRouter-update | bash"
            }
          });
        }
      }
    }
    if (parsed.error === "Settlement failed" || parsed.details?.includes("Settlement failed")) {
      const details = parsed.details || "";
      const gasError = details.includes("unable to estimate gas");
      return JSON.stringify({
        error: {
          message: gasError ? "Payment failed: network congestion or gas issue. Try again." : "Payment settlement failed. Try again in a moment.",
          type: "settlement_failed",
          help: "This is usually temporary. If it persists, try: /model free"
        }
      });
    }
  } catch {
  }
  return errorBody;
}
var rateLimitedModels = /* @__PURE__ */ new Map();
function isRateLimited(modelId) {
  const hitTime = rateLimitedModels.get(modelId);
  if (!hitTime) return false;
  const elapsed = Date.now() - hitTime;
  if (elapsed >= RATE_LIMIT_COOLDOWN_MS) {
    rateLimitedModels.delete(modelId);
    return false;
  }
  return true;
}
function markRateLimited(modelId) {
  rateLimitedModels.set(modelId, Date.now());
  console.log(`[ClawRouter] Model ${modelId} rate-limited, will deprioritize for 60s`);
}
function prioritizeNonRateLimited(models) {
  const available = [];
  const rateLimited = [];
  for (const model of models) {
    if (isRateLimited(model)) {
      rateLimited.push(model);
    } else {
      available.push(model);
    }
  }
  return [...available, ...rateLimited];
}
function canWrite(res) {
  return !res.writableEnded && !res.destroyed && res.socket !== null && !res.socket.destroyed && res.socket.writable;
}
function safeWrite(res, data) {
  if (!canWrite(res)) {
    return false;
  }
  return res.write(data);
}
var BALANCE_CHECK_BUFFER = 1.5;
function getProxyPort() {
  return PROXY_PORT;
}
async function checkExistingProxy(port) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data.status === "ok" && data.wallet) {
        return data.wallet;
      }
    }
    return void 0;
  } catch {
    clearTimeout(timeoutId);
    return void 0;
  }
}
var PROVIDER_ERROR_PATTERNS = [
  /billing/i,
  /insufficient.*balance/i,
  /credits/i,
  /quota.*exceeded/i,
  /rate.*limit/i,
  /model.*unavailable/i,
  /model.*not.*available/i,
  /service.*unavailable/i,
  /capacity/i,
  /overloaded/i,
  /temporarily.*unavailable/i,
  /api.*key.*invalid/i,
  /authentication.*failed/i,
  /request too large/i,
  /request.*size.*exceeds/i,
  /payload too large/i
];
var DEGRADED_RESPONSE_PATTERNS = [
  /the ai service is temporarily overloaded/i,
  /service is temporarily overloaded/i,
  /please try again in a moment/i
];
var DEGRADED_LOOP_PATTERNS = [
  /the boxed is the response\./i,
  /the response is the text\./i,
  /the final answer is the boxed\./i
];
function extractAssistantContent(payload) {
  if (!payload || typeof payload !== "object") return void 0;
  const record = payload;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return void 0;
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return void 0;
  const choice = firstChoice;
  const message = choice.message;
  if (!message || typeof message !== "object") return void 0;
  const content = message.content;
  return typeof content === "string" ? content : void 0;
}
function hasKnownLoopSignature(text) {
  const matchCount = DEGRADED_LOOP_PATTERNS.reduce(
    (count, pattern) => pattern.test(text) ? count + 1 : count,
    0
  );
  if (matchCount >= 2) return true;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 8) return false;
  const counts = /* @__PURE__ */ new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const maxRepeat = Math.max(...counts.values());
  const uniqueRatio = counts.size / lines.length;
  return maxRepeat >= 3 && uniqueRatio <= 0.45;
}
function detectDegradedSuccessResponse(body) {
  const trimmed = body.trim();
  if (!trimmed) return void 0;
  if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return "degraded response: overloaded placeholder";
  }
  if (hasKnownLoopSignature(trimmed)) {
    return "degraded response: repetitive loop output";
  }
  try {
    const parsed = JSON.parse(trimmed);
    const errorField = parsed.error;
    let errorText = "";
    if (typeof errorField === "string") {
      errorText = errorField;
    } else if (errorField && typeof errorField === "object") {
      const errObj = errorField;
      errorText = [
        typeof errObj.message === "string" ? errObj.message : "",
        typeof errObj.type === "string" ? errObj.type : "",
        typeof errObj.code === "string" ? errObj.code : ""
      ].filter(Boolean).join(" ");
    }
    if (errorText && PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
      return `degraded response: ${errorText.slice(0, 120)}`;
    }
    const assistantContent = extractAssistantContent(parsed);
    if (!assistantContent) return void 0;
    if (DEGRADED_RESPONSE_PATTERNS.some((pattern) => pattern.test(assistantContent))) {
      return "degraded response: overloaded assistant content";
    }
    if (hasKnownLoopSignature(assistantContent)) {
      return "degraded response: repetitive assistant loop";
    }
  } catch {
  }
  return void 0;
}
var FALLBACK_STATUS_CODES = [
  400,
  // Bad request - sometimes used for billing errors
  401,
  // Unauthorized - provider API key issues
  402,
  // Payment required - but from upstream, not x402
  403,
  // Forbidden - provider restrictions
  413,
  // Payload too large - request exceeds model's context limit
  429,
  // Rate limited
  500,
  // Internal server error
  502,
  // Bad gateway
  503,
  // Service unavailable
  504
  // Gateway timeout
];
function isProviderError(status, body) {
  if (!FALLBACK_STATUS_CODES.includes(status)) {
    return false;
  }
  if (status >= 500) {
    return true;
  }
  return PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(body));
}
var VALID_ROLES = /* @__PURE__ */ new Set(["system", "user", "assistant", "tool", "function"]);
var ROLE_MAPPINGS = {
  developer: "system",
  // OpenAI's newer API uses "developer" for system messages
  model: "assistant"
  // Some APIs use "model" instead of "assistant"
};
var VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return id;
  if (VALID_TOOL_ID_PATTERN.test(id)) return id;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function sanitizeToolIds(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const sanitized = messages.map((msg) => {
    const typedMsg = msg;
    let msgChanged = false;
    let newMsg = { ...msg };
    if (typedMsg.tool_calls && Array.isArray(typedMsg.tool_calls)) {
      const newToolCalls = typedMsg.tool_calls.map((tc) => {
        if (tc.id && typeof tc.id === "string") {
          const sanitized2 = sanitizeToolId(tc.id);
          if (sanitized2 !== tc.id) {
            msgChanged = true;
            return { ...tc, id: sanitized2 };
          }
        }
        return tc;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, tool_calls: newToolCalls };
      }
    }
    if (typedMsg.tool_call_id && typeof typedMsg.tool_call_id === "string") {
      const sanitized2 = sanitizeToolId(typedMsg.tool_call_id);
      if (sanitized2 !== typedMsg.tool_call_id) {
        msgChanged = true;
        newMsg = { ...newMsg, tool_call_id: sanitized2 };
      }
    }
    if (Array.isArray(typedMsg.content)) {
      const newContent = typedMsg.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        let blockChanged = false;
        let newBlock = { ...block };
        if (block.type === "tool_use" && block.id && typeof block.id === "string") {
          const sanitized2 = sanitizeToolId(block.id);
          if (sanitized2 !== block.id) {
            blockChanged = true;
            newBlock = { ...newBlock, id: sanitized2 };
          }
        }
        if (block.type === "tool_result" && block.tool_use_id && typeof block.tool_use_id === "string") {
          const sanitized2 = sanitizeToolId(block.tool_use_id);
          if (sanitized2 !== block.tool_use_id) {
            blockChanged = true;
            newBlock = { ...newBlock, tool_use_id: sanitized2 };
          }
        }
        if (blockChanged) {
          msgChanged = true;
          return newBlock;
        }
        return block;
      });
      if (msgChanged) {
        newMsg = { ...newMsg, content: newContent };
      }
    }
    if (msgChanged) {
      hasChanges = true;
      return newMsg;
    }
    return msg;
  });
  return hasChanges ? sanitized : messages;
}
function normalizeMessageRoles(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (VALID_ROLES.has(msg.role)) return msg;
    const mappedRole = ROLE_MAPPINGS[msg.role];
    if (mappedRole) {
      hasChanges = true;
      return { ...msg, role: mappedRole };
    }
    hasChanges = true;
    return { ...msg, role: "user" };
  });
  return hasChanges ? normalized : messages;
}
function normalizeMessagesForGoogle(messages) {
  if (!messages || messages.length === 0) return messages;
  let firstNonSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "system") {
      firstNonSystemIdx = i;
      break;
    }
  }
  if (firstNonSystemIdx === -1) return messages;
  const firstRole = messages[firstNonSystemIdx].role;
  if (firstRole === "user") return messages;
  if (firstRole === "assistant" || firstRole === "model") {
    const normalized = [...messages];
    normalized.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "(continuing conversation)"
    });
    return normalized;
  }
  return messages;
}
function isGoogleModel(modelId) {
  return modelId.startsWith("google/") || modelId.startsWith("gemini");
}
function normalizeMessagesForThinking(messages) {
  if (!messages || messages.length === 0) return messages;
  let hasChanges = false;
  const normalized = messages.map((msg) => {
    if (msg.role !== "assistant" || msg.reasoning_content !== void 0) {
      return msg;
    }
    const hasOpenAIToolCalls = msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const hasAnthropicToolUse = Array.isArray(msg.content) && msg.content.some((block) => block?.type === "tool_use");
    if (hasOpenAIToolCalls || hasAnthropicToolUse) {
      hasChanges = true;
      return { ...msg, reasoning_content: "" };
    }
    return msg;
  });
  return hasChanges ? normalized : messages;
}
function truncateMessages(messages) {
  if (!messages || messages.length <= MAX_MESSAGES) {
    return {
      messages,
      wasTruncated: false,
      originalCount: messages?.length ?? 0,
      truncatedCount: messages?.length ?? 0
    };
  }
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversationMsgs = messages.filter((m) => m.role !== "system");
  const maxConversation = MAX_MESSAGES - systemMsgs.length;
  const truncatedConversation = conversationMsgs.slice(-maxConversation);
  const result = [...systemMsgs, ...truncatedConversation];
  console.log(
    `[ClawRouter] Truncated messages: ${messages.length} \u2192 ${result.length} (kept ${systemMsgs.length} system + ${truncatedConversation.length} recent)`
  );
  return {
    messages: result,
    wasTruncated: true,
    originalCount: messages.length,
    truncatedCount: result.length
  };
}
var KIMI_BLOCK_RE = /<[｜|][^<>]*begin[^<>]*[｜|]>[\s\S]*?<[｜|][^<>]*end[^<>]*[｜|]>/gi;
var KIMI_TOKEN_RE = /<[｜|][^<>]*[｜|]>/g;
var THINKING_TAG_RE = /<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>/gi;
var THINKING_BLOCK_RE = /<\s*(?:think(?:ing)?|thought|antthinking)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;
function stripThinkingTokens(content) {
  if (!content) return content;
  let cleaned = content.replace(KIMI_BLOCK_RE, "");
  cleaned = cleaned.replace(KIMI_TOKEN_RE, "");
  cleaned = cleaned.replace(THINKING_BLOCK_RE, "");
  cleaned = cleaned.replace(THINKING_TAG_RE, "");
  return cleaned;
}
function buildModelPricing() {
  const map = /* @__PURE__ */ new Map();
  for (const m of BLOCKRUN_MODELS) {
    if (m.id === AUTO_MODEL) continue;
    map.set(m.id, { inputPrice: m.inputPrice, outputPrice: m.outputPrice });
  }
  return map;
}
function buildProxyModelList(createdAt = Math.floor(Date.now() / 1e3)) {
  const seen = /* @__PURE__ */ new Set();
  return OPENCLAW_MODELS.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  }).map((model) => ({
    id: model.id,
    object: "model",
    created: createdAt,
    owned_by: model.id.includes("/") ? model.id.split("/")[0] ?? "blockrun" : "blockrun"
  }));
}
function mergeRoutingConfig(overrides) {
  if (!overrides) return DEFAULT_ROUTING_CONFIG;
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...overrides,
    classifier: { ...DEFAULT_ROUTING_CONFIG.classifier, ...overrides.classifier },
    scoring: { ...DEFAULT_ROUTING_CONFIG.scoring, ...overrides.scoring },
    tiers: { ...DEFAULT_ROUTING_CONFIG.tiers, ...overrides.tiers },
    overrides: { ...DEFAULT_ROUTING_CONFIG.overrides, ...overrides.overrides }
  };
}
function estimateAmount(modelId, bodyLength, maxTokens) {
  const model = BLOCKRUN_MODELS.find((m) => m.id === modelId);
  if (!model) return void 0;
  const estimatedInputTokens = Math.ceil(bodyLength / 4);
  const estimatedOutputTokens = maxTokens || model.maxOutput || 4096;
  const costUsd = estimatedInputTokens / 1e6 * model.inputPrice + estimatedOutputTokens / 1e6 * model.outputPrice;
  const amountMicros = Math.max(100, Math.ceil(costUsd * 1.2 * 1e6));
  return amountMicros.toString();
}
async function proxyPartnerRequest(req, res, apiBase, payFetch) {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(bodyChunks);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "transfer-encoding" || key === "content-length")
      continue;
    if (typeof value === "string") headers[key] = value;
  }
  if (!headers["content-type"]) headers["content-type"] = "application/json";
  headers["user-agent"] = USER_AGENT;
  console.log(`[ClawRouter] Partner request: ${req.method} ${req.url}`);
  const upstream = await payFetch(upstreamUrl, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : void 0
  });
  const responseHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key === "transfer-encoding" || key === "connection" || key === "content-encoding") return;
    responseHeaders[key] = value;
  });
  res.writeHead(upstream.status, responseHeaders);
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        safeWrite(res, Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
  const latencyMs = Date.now() - startTime;
  console.log(`[ClawRouter] Partner response: ${upstream.status} (${latencyMs}ms)`);
  logUsage({
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    model: "partner",
    tier: "PARTNER",
    cost: 0,
    // Actual cost handled by x402 settlement
    baselineCost: 0,
    savings: 0,
    latencyMs,
    partnerId: (req.url?.split("?")[0] ?? "").replace(/^\/v1\//, "").replace(/\//g, "_") || "unknown",
    service: "partner"
  }).catch(() => {
  });
}
async function startProxy(options) {
  const apiBase = options.apiBase ?? BLOCKRUN_API;
  const listenPort = options.port ?? getProxyPort();
  const existingWallet = await checkExistingProxy(listenPort);
  if (existingWallet) {
    const account2 = privateKeyToAccount2(options.walletKey);
    const balanceMonitor2 = new BalanceMonitor(account2.address);
    const baseUrl2 = `http://127.0.0.1:${listenPort}`;
    if (existingWallet !== account2.address) {
      console.warn(
        `[ClawRouter] Existing proxy on port ${listenPort} uses wallet ${existingWallet}, but current config uses ${account2.address}. Reusing existing proxy.`
      );
    }
    options.onReady?.(listenPort);
    return {
      port: listenPort,
      baseUrl: baseUrl2,
      walletAddress: existingWallet,
      balanceMonitor: balanceMonitor2,
      close: async () => {
      }
    };
  }
  const account = privateKeyToAccount2(options.walletKey);
  const payFetch = options.paymentFetch ?? createPaymentFetch(options.walletKey).fetch;
  const balanceMonitor = new BalanceMonitor(account.address);
  const routingConfig = mergeRoutingConfig(options.routingConfig);
  const modelPricing = buildModelPricing();
  const routerOpts = {
    config: routingConfig,
    modelPricing
  };
  const deduplicator = new RequestDeduplicator();
  const responseCache = new ResponseCache(options.cacheConfig);
  const sessionStore = new SessionStore(options.sessionConfig);
  const sessionJournal = new SessionJournal();
  const connections = /* @__PURE__ */ new Set();
  const server = createServer(async (req, res) => {
    req.on("error", (err) => {
      console.error(`[ClawRouter] Request stream error: ${err.message}`);
    });
    res.on("error", (err) => {
      console.error(`[ClawRouter] Response stream error: ${err.message}`);
    });
    finished(res, (err) => {
      if (err && err.code !== "ERR_STREAM_DESTROYED") {
        console.error(`[ClawRouter] Response finished with error: ${err.message}`);
      }
    });
    finished(req, (err) => {
      if (err && err.code !== "ERR_STREAM_DESTROYED") {
        console.error(`[ClawRouter] Request finished with error: ${err.message}`);
      }
    });
    if (req.url === "/health" || req.url?.startsWith("/health?")) {
      const url = new URL(req.url, "http://localhost");
      const full = url.searchParams.get("full") === "true";
      const response = {
        status: "ok",
        wallet: account.address
      };
      if (full) {
        try {
          const balanceInfo = await balanceMonitor.checkBalance();
          response.balance = balanceInfo.balanceUSD;
          response.isLow = balanceInfo.isLow;
          response.isEmpty = balanceInfo.isEmpty;
        } catch {
          response.balanceError = "Could not fetch balance";
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }
    if (req.url === "/cache" || req.url?.startsWith("/cache?")) {
      const stats = responseCache.getStats();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }
    if (req.url === "/stats" || req.url?.startsWith("/stats?")) {
      try {
        const url = new URL(req.url, "http://localhost");
        const days = parseInt(url.searchParams.get("days") || "7", 10);
        const stats = await getStats(Math.min(days, 30));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        });
        res.end(JSON.stringify(stats, null, 2));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `Failed to get stats: ${err instanceof Error ? err.message : String(err)}`
          })
        );
      }
      return;
    }
    if (req.url === "/v1/models" && req.method === "GET") {
      const models = buildProxyModelList();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    if (req.url?.match(/^\/v1\/(?:x|partner)\//)) {
      try {
        await proxyPartnerRequest(req, res, apiBase, payFetch);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.onError?.(error);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: `Partner proxy error: ${error.message}`, type: "partner_error" }
            })
          );
        }
      }
      return;
    }
    if (!req.url?.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      await proxyRequest(
        req,
        res,
        apiBase,
        payFetch,
        options,
        routerOpts,
        deduplicator,
        balanceMonitor,
        sessionStore,
        responseCache,
        sessionJournal
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onError?.(error);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: `Proxy error: ${error.message}`, type: "proxy_error" }
          })
        );
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: { message: error.message, type: "proxy_error" } })}

`
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });
  const tryListen = (attempt) => {
    return new Promise((resolveAttempt, rejectAttempt) => {
      const onError = async (err) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE") {
          const existingWallet2 = await checkExistingProxy(listenPort);
          if (existingWallet2) {
            console.log(`[ClawRouter] Existing proxy detected on port ${listenPort}, reusing`);
            rejectAttempt({ code: "REUSE_EXISTING", wallet: existingWallet2 });
            return;
          }
          if (attempt < PORT_RETRY_ATTEMPTS) {
            console.log(
              `[ClawRouter] Port ${listenPort} in TIME_WAIT, retrying in ${PORT_RETRY_DELAY_MS}ms (attempt ${attempt}/${PORT_RETRY_ATTEMPTS})`
            );
            rejectAttempt({ code: "RETRY", attempt });
            return;
          }
          console.error(
            `[ClawRouter] Port ${listenPort} still in use after ${PORT_RETRY_ATTEMPTS} attempts`
          );
          rejectAttempt(err);
          return;
        }
        rejectAttempt(err);
      };
      server.once("error", onError);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveAttempt();
      });
    });
  };
  let lastError;
  for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
    try {
      await tryListen(attempt);
      break;
    } catch (err) {
      const error = err;
      if (error.code === "REUSE_EXISTING" && error.wallet) {
        const baseUrl2 = `http://127.0.0.1:${listenPort}`;
        options.onReady?.(listenPort);
        return {
          port: listenPort,
          baseUrl: baseUrl2,
          walletAddress: error.wallet,
          balanceMonitor,
          close: async () => {
          }
        };
      }
      if (error.code === "RETRY") {
        await new Promise((r) => setTimeout(r, PORT_RETRY_DELAY_MS));
        continue;
      }
      lastError = err;
      break;
    }
  }
  if (lastError) {
    throw lastError;
  }
  const addr = server.address();
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  options.onReady?.(port);
  checkForUpdates();
  server.on("error", (err) => {
    console.error(`[ClawRouter] Server runtime error: ${err.message}`);
    options.onError?.(err);
  });
  server.on("clientError", (err, socket) => {
    console.error(`[ClawRouter] Client error: ${err.message}`);
    if (socket.writable && !socket.destroyed) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.setTimeout(3e5);
    socket.on("timeout", () => {
      console.error(`[ClawRouter] Socket timeout, destroying connection`);
      socket.destroy();
    });
    socket.on("end", () => {
    });
    socket.on("error", (err) => {
      console.error(`[ClawRouter] Socket error: ${err.message}`);
    });
    socket.on("close", () => {
      connections.delete(socket);
    });
  });
  return {
    port,
    baseUrl,
    walletAddress: account.address,
    balanceMonitor,
    close: () => new Promise((res, rej) => {
      const timeout = setTimeout(() => {
        rej(new Error("[ClawRouter] Close timeout after 4s"));
      }, 4e3);
      sessionStore.close();
      for (const socket of connections) {
        socket.destroy();
      }
      connections.clear();
      server.close((err) => {
        clearTimeout(timeout);
        if (err) {
          rej(err);
        } else {
          res();
        }
      });
    })
  };
}
async function tryModelRequest(upstreamUrl, method, headers, body, modelId, maxTokens, payFetch, balanceMonitor, signal) {
  let requestBody = body;
  try {
    const parsed = JSON.parse(body.toString());
    parsed.model = modelId;
    if (Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessageRoles(parsed.messages);
    }
    if (Array.isArray(parsed.messages)) {
      const truncationResult = truncateMessages(parsed.messages);
      parsed.messages = truncationResult.messages;
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = sanitizeToolIds(parsed.messages);
    }
    if (isGoogleModel(modelId) && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForGoogle(parsed.messages);
    }
    const hasThinkingEnabled = !!(parsed.thinking || parsed.extended_thinking || isReasoningModel(modelId));
    if (hasThinkingEnabled && Array.isArray(parsed.messages)) {
      parsed.messages = normalizeMessagesForThinking(parsed.messages);
    }
    requestBody = Buffer.from(JSON.stringify(parsed));
  } catch {
  }
  const estimated = estimateAmount(modelId, requestBody.length, maxTokens);
  const preAuth = estimated ? { estimatedAmount: estimated } : void 0;
  try {
    const response = await payFetch(
      upstreamUrl,
      {
        method,
        headers,
        body: requestBody.length > 0 ? new Uint8Array(requestBody) : void 0,
        signal
      },
      preAuth
    );
    if (response.status !== 200) {
      const errorBody = await response.text();
      const isProviderErr = isProviderError(response.status, errorBody);
      return {
        success: false,
        errorBody,
        errorStatus: response.status,
        isProviderError: isProviderErr
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json") || contentType.includes("text")) {
      try {
        const responseBody = await response.clone().text();
        const degradedReason = detectDegradedSuccessResponse(responseBody);
        if (degradedReason) {
          return {
            success: false,
            errorBody: degradedReason,
            errorStatus: 503,
            isProviderError: true
          };
        }
      } catch {
      }
    }
    return { success: true, response };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errorBody: errorMsg,
      errorStatus: 500,
      isProviderError: true
      // Network errors are retryable
    };
  }
}
async function proxyRequest(req, res, apiBase, payFetch, options, routerOpts, deduplicator, balanceMonitor, sessionStore, responseCache, sessionJournal) {
  const startTime = Date.now();
  const upstreamUrl = `${apiBase}${req.url}`;
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let body = Buffer.concat(bodyChunks);
  const originalContextSizeKB = Math.ceil(body.length / 1024);
  let routingDecision;
  let isStreaming = false;
  let modelId = "";
  let maxTokens = 4096;
  let routingProfile = null;
  let accumulatedContent = "";
  const isChatCompletion = req.url?.includes("/chat/completions");
  const sessionId = getSessionId(req.headers);
  if (isChatCompletion && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString());
      isStreaming = parsed.stream === true;
      modelId = parsed.model || "";
      maxTokens = parsed.max_tokens || 4096;
      let bodyModified = false;
      if (sessionId && Array.isArray(parsed.messages)) {
        const messages = parsed.messages;
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        const lastContent = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
        if (sessionJournal.needsContext(lastContent)) {
          const journalText = sessionJournal.format(sessionId);
          if (journalText) {
            const sysIdx = messages.findIndex((m) => m.role === "system");
            if (sysIdx >= 0 && typeof messages[sysIdx].content === "string") {
              messages[sysIdx] = {
                ...messages[sysIdx],
                content: journalText + "\n\n" + messages[sysIdx].content
              };
            } else {
              messages.unshift({ role: "system", content: journalText });
            }
            parsed.messages = messages;
            bodyModified = true;
            console.log(
              `[ClawRouter] Injected session journal (${journalText.length} chars) for session ${sessionId.slice(0, 8)}...`
            );
          }
        }
      }
      if (parsed.stream === true) {
        parsed.stream = false;
        bodyModified = true;
      }
      const normalizedModel = typeof parsed.model === "string" ? parsed.model.trim().toLowerCase() : "";
      const resolvedModel = resolveModelAlias(normalizedModel);
      const wasAlias = resolvedModel !== normalizedModel;
      const isRoutingProfile = ROUTING_PROFILES.has(normalizedModel);
      if (isRoutingProfile) {
        const profileName = normalizedModel.replace("blockrun/", "");
        routingProfile = profileName;
      }
      console.log(
        `[ClawRouter] Received model: "${parsed.model}" -> normalized: "${normalizedModel}"${wasAlias ? ` -> alias: "${resolvedModel}"` : ""}${routingProfile ? `, profile: ${routingProfile}` : ""}`
      );
      if (!isRoutingProfile) {
        if (parsed.model !== resolvedModel) {
          parsed.model = resolvedModel;
          bodyModified = true;
        }
        modelId = resolvedModel;
      }
      if (isRoutingProfile) {
        if (routingProfile === "free") {
          const freeModel = "nvidia/gpt-oss-120b";
          console.log(`[ClawRouter] Free profile - using ${freeModel} directly`);
          parsed.model = freeModel;
          modelId = freeModel;
          bodyModified = true;
          await logUsage({
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            model: freeModel,
            tier: "SIMPLE",
            cost: 0,
            baselineCost: 0,
            savings: 1,
            // 100% savings
            latencyMs: 0
          });
        } else {
          const sessionId2 = getSessionId(
            req.headers
          );
          const existingSession = sessionId2 ? sessionStore.getSession(sessionId2) : void 0;
          if (existingSession) {
            console.log(
              `[ClawRouter] Session ${sessionId2?.slice(0, 8)}... using pinned model: ${existingSession.model}`
            );
            parsed.model = existingSession.model;
            modelId = existingSession.model;
            bodyModified = true;
            sessionStore.touchSession(sessionId2);
          } else {
            const messages = parsed.messages;
            let lastUserMsg;
            if (messages) {
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                  lastUserMsg = messages[i];
                  break;
                }
              }
            }
            const systemMsg = messages?.find((m) => m.role === "system");
            const prompt = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
            const systemPrompt = typeof systemMsg?.content === "string" ? systemMsg.content : void 0;
            const tools = parsed.tools;
            const hasTools = Array.isArray(tools) && tools.length > 0;
            if (hasTools && tools) {
              console.log(
                `[ClawRouter] Tools detected (${tools.length}), agentic mode via keywords`
              );
            }
            routingDecision = route(prompt, systemPrompt, maxTokens, {
              ...routerOpts,
              routingProfile: routingProfile ?? void 0
            });
            parsed.model = routingDecision.model;
            modelId = routingDecision.model;
            bodyModified = true;
            if (sessionId2) {
              sessionStore.setSession(sessionId2, routingDecision.model, routingDecision.tier);
              console.log(
                `[ClawRouter] Session ${sessionId2.slice(0, 8)}... pinned to model: ${routingDecision.model}`
              );
            }
            options.onRouted?.(routingDecision);
          }
        }
      }
      if (bodyModified) {
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ClawRouter] Routing error: ${errorMsg}`);
      console.error(`[ClawRouter] Need help? Run: npx @blockrun/clawrouter doctor`);
      options.onError?.(new Error(`Routing failed: ${errorMsg}`));
    }
  }
  const autoCompress = options.autoCompressRequests ?? true;
  const compressionThreshold = options.compressionThresholdKB ?? 180;
  const requestSizeKB = Math.ceil(body.length / 1024);
  if (autoCompress && requestSizeKB > compressionThreshold) {
    try {
      console.log(
        `[ClawRouter] Request size ${requestSizeKB}KB exceeds threshold ${compressionThreshold}KB, applying compression...`
      );
      const parsed = JSON.parse(body.toString());
      if (parsed.messages && parsed.messages.length > 0 && shouldCompress(parsed.messages)) {
        const compressionResult = await compressContext(parsed.messages, {
          enabled: true,
          preserveRaw: false,
          // Don't need originals in proxy
          layers: {
            deduplication: true,
            // Safe: removes duplicate messages
            whitespace: true,
            // Safe: normalizes whitespace
            dictionary: false,
            // Disabled: requires model to understand codebook
            paths: false,
            // Disabled: requires model to understand path codes
            jsonCompact: true,
            // Safe: just removes JSON whitespace
            observation: false,
            // Disabled: may lose important context
            dynamicCodebook: false
            // Disabled: requires model to understand codes
          },
          dictionary: {
            maxEntries: 50,
            minPhraseLength: 15,
            includeCodebookHeader: false
          }
        });
        const compressedSizeKB = Math.ceil(compressionResult.compressedChars / 1024);
        const savings = ((requestSizeKB - compressedSizeKB) / requestSizeKB * 100).toFixed(1);
        console.log(
          `[ClawRouter] Compressed ${requestSizeKB}KB \u2192 ${compressedSizeKB}KB (${savings}% reduction)`
        );
        parsed.messages = compressionResult.messages;
        body = Buffer.from(JSON.stringify(parsed));
      }
    } catch (err) {
      console.warn(
        `[ClawRouter] Compression failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const cacheKey = ResponseCache.generateKey(body);
  const reqHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") reqHeaders[key] = value;
  }
  if (responseCache.shouldCache(body, reqHeaders)) {
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
      console.log(`[ClawRouter] Cache HIT for ${cachedResponse.model} (saved API call)`);
      res.writeHead(cachedResponse.status, cachedResponse.headers);
      res.end(cachedResponse.body);
      return;
    }
  }
  const dedupKey = RequestDeduplicator.hash(body);
  const cached = deduplicator.getCached(dedupKey);
  if (cached) {
    res.writeHead(cached.status, cached.headers);
    res.end(cached.body);
    return;
  }
  const inflight = deduplicator.getInflight(dedupKey);
  if (inflight) {
    const result = await inflight;
    res.writeHead(result.status, result.headers);
    res.end(result.body);
    return;
  }
  deduplicator.markInflight(dedupKey);
  let estimatedCostMicros;
  const isFreeModel = modelId === FREE_MODEL;
  if (modelId && !options.skipBalanceCheck && !isFreeModel) {
    const estimated = estimateAmount(modelId, body.length, maxTokens);
    if (estimated) {
      estimatedCostMicros = BigInt(estimated);
      const bufferedCostMicros = estimatedCostMicros * BigInt(Math.ceil(BALANCE_CHECK_BUFFER * 100)) / 100n;
      const sufficiency = await balanceMonitor.checkSufficient(bufferedCostMicros);
      if (sufficiency.info.isEmpty || !sufficiency.sufficient) {
        const originalModel = modelId;
        console.log(
          `[ClawRouter] Wallet ${sufficiency.info.isEmpty ? "empty" : "insufficient"} ($${sufficiency.info.balanceUSD}), falling back to free model: ${FREE_MODEL} (requested: ${originalModel})`
        );
        modelId = FREE_MODEL;
        const parsed = JSON.parse(body.toString());
        parsed.model = FREE_MODEL;
        body = Buffer.from(JSON.stringify(parsed));
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress
        });
      } else if (sufficiency.info.isLow) {
        options.onLowBalance?.({
          balanceUSD: sufficiency.info.balanceUSD,
          walletAddress: sufficiency.info.walletAddress
        });
      }
    }
  }
  let heartbeatInterval;
  let headersSentEarly = false;
  if (isStreaming) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-context-used-kb": String(originalContextSizeKB),
      "x-context-limit-kb": String(CONTEXT_LIMIT_KB)
    });
    headersSentEarly = true;
    safeWrite(res, ": heartbeat\n\n");
    heartbeatInterval = setInterval(() => {
      if (canWrite(res)) {
        safeWrite(res, ": heartbeat\n\n");
      } else {
        clearInterval(heartbeatInterval);
        heartbeatInterval = void 0;
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === "host" || key === "connection" || key === "transfer-encoding" || key === "content-length")
      continue;
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  headers["user-agent"] = USER_AGENT;
  let completed = false;
  res.on("close", () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    if (!completed) {
      deduplicator.removeInflight(dedupKey);
    }
  });
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let modelsToTry;
    if (routingDecision) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const estimatedTotalTokens = estimatedInputTokens + maxTokens;
      const useAgenticTiers = routingDecision.reasoning?.includes("agentic") && routerOpts.config.agenticTiers;
      const tierConfigs = useAgenticTiers ? routerOpts.config.agenticTiers : routerOpts.config.tiers;
      const fullChain = getFallbackChain(routingDecision.tier, tierConfigs);
      const contextFiltered = getFallbackChainFiltered(
        routingDecision.tier,
        tierConfigs,
        estimatedTotalTokens,
        getModelContextWindow
      );
      const contextExcluded = fullChain.filter((m) => !contextFiltered.includes(m));
      if (contextExcluded.length > 0) {
        console.log(
          `[ClawRouter] Context filter (~${estimatedTotalTokens} tokens): excluded ${contextExcluded.join(", ")}`
        );
      }
      modelsToTry = contextFiltered.slice(0, MAX_FALLBACK_ATTEMPTS);
      modelsToTry = prioritizeNonRateLimited(modelsToTry);
    } else {
      if (modelId && modelId !== FREE_MODEL) {
        modelsToTry = [modelId, FREE_MODEL];
      } else {
        modelsToTry = modelId ? [modelId] : [];
      }
    }
    let upstream;
    let lastError;
    let actualModelUsed = modelId;
    for (let i = 0; i < modelsToTry.length; i++) {
      const tryModel = modelsToTry[i];
      const isLastAttempt = i === modelsToTry.length - 1;
      console.log(`[ClawRouter] Trying model ${i + 1}/${modelsToTry.length}: ${tryModel}`);
      const result = await tryModelRequest(
        upstreamUrl,
        req.method ?? "POST",
        headers,
        body,
        tryModel,
        maxTokens,
        payFetch,
        balanceMonitor,
        controller.signal
      );
      if (result.success && result.response) {
        upstream = result.response;
        actualModelUsed = tryModel;
        console.log(`[ClawRouter] Success with model: ${tryModel}`);
        break;
      }
      lastError = {
        body: result.errorBody || "Unknown error",
        status: result.errorStatus || 500
      };
      if (result.isProviderError && !isLastAttempt) {
        if (result.errorStatus === 429) {
          markRateLimited(tryModel);
        }
        console.log(
          `[ClawRouter] Provider error from ${tryModel}, trying fallback: ${result.errorBody?.slice(0, 100)}`
        );
        continue;
      }
      if (!result.isProviderError) {
        console.log(
          `[ClawRouter] Non-provider error from ${tryModel}, not retrying: ${result.errorBody?.slice(0, 100)}`
        );
      }
      break;
    }
    clearTimeout(timeoutId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    if (routingDecision && actualModelUsed !== routingDecision.model) {
      const estimatedInputTokens = Math.ceil(body.length / 4);
      const newCosts = calculateModelCost(
        actualModelUsed,
        routerOpts.modelPricing,
        estimatedInputTokens,
        maxTokens,
        routingProfile ?? void 0
      );
      routingDecision = {
        ...routingDecision,
        model: actualModelUsed,
        reasoning: `${routingDecision.reasoning} | fallback to ${actualModelUsed}`,
        costEstimate: newCosts.costEstimate,
        baselineCost: newCosts.baselineCost,
        savings: newCosts.savings
      };
      options.onRouted?.(routingDecision);
    }
    if (!upstream) {
      const rawErrBody = lastError?.body || "All models in fallback chain failed";
      const errStatus = lastError?.status || 502;
      const transformedErr = transformPaymentError(rawErrBody);
      if (headersSentEarly) {
        let errPayload;
        try {
          const parsed = JSON.parse(transformedErr);
          errPayload = JSON.stringify(parsed);
        } catch {
          errPayload = JSON.stringify({
            error: { message: rawErrBody, type: "provider_error", status: errStatus }
          });
        }
        const errEvent = `data: ${errPayload}

`;
        safeWrite(res, errEvent);
        safeWrite(res, "data: [DONE]\n\n");
        res.end();
        const errBuf = Buffer.from(errEvent + "data: [DONE]\n\n");
        deduplicator.complete(dedupKey, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: errBuf,
          completedAt: Date.now()
        });
      } else {
        res.writeHead(errStatus, {
          "Content-Type": "application/json",
          "x-context-used-kb": String(originalContextSizeKB),
          "x-context-limit-kb": String(CONTEXT_LIMIT_KB)
        });
        res.end(transformedErr);
        deduplicator.complete(dedupKey, {
          status: errStatus,
          headers: { "content-type": "application/json" },
          body: Buffer.from(transformedErr),
          completedAt: Date.now()
        });
      }
      return;
    }
    const responseChunks = [];
    if (headersSentEarly) {
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const jsonBody = Buffer.concat(chunks);
        const jsonStr = jsonBody.toString();
        try {
          const rsp = JSON.parse(jsonStr);
          const baseChunk = {
            id: rsp.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: rsp.created ?? Math.floor(Date.now() / 1e3),
            model: rsp.model ?? "unknown",
            system_fingerprint: null
          };
          if (rsp.choices && Array.isArray(rsp.choices)) {
            for (const choice of rsp.choices) {
              const rawContent = choice.message?.content ?? choice.delta?.content ?? "";
              const content = stripThinkingTokens(rawContent);
              const role = choice.message?.role ?? choice.delta?.role ?? "assistant";
              const index = choice.index ?? 0;
              if (content) {
                accumulatedContent += content;
              }
              const roleChunk = {
                ...baseChunk,
                choices: [{ index, delta: { role }, logprobs: null, finish_reason: null }]
              };
              const roleData = `data: ${JSON.stringify(roleChunk)}

`;
              safeWrite(res, roleData);
              responseChunks.push(Buffer.from(roleData));
              if (content) {
                const contentChunk = {
                  ...baseChunk,
                  choices: [{ index, delta: { content }, logprobs: null, finish_reason: null }]
                };
                const contentData = `data: ${JSON.stringify(contentChunk)}

`;
                safeWrite(res, contentData);
                responseChunks.push(Buffer.from(contentData));
              }
              const toolCalls = choice.message?.tool_calls ?? choice.delta?.tool_calls;
              if (toolCalls && toolCalls.length > 0) {
                const toolCallChunk = {
                  ...baseChunk,
                  choices: [
                    {
                      index,
                      delta: { tool_calls: toolCalls },
                      logprobs: null,
                      finish_reason: null
                    }
                  ]
                };
                const toolCallData = `data: ${JSON.stringify(toolCallChunk)}

`;
                safeWrite(res, toolCallData);
                responseChunks.push(Buffer.from(toolCallData));
              }
              const finishChunk = {
                ...baseChunk,
                choices: [
                  {
                    index,
                    delta: {},
                    logprobs: null,
                    finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : choice.finish_reason ?? "stop"
                  }
                ]
              };
              const finishData = `data: ${JSON.stringify(finishChunk)}

`;
              safeWrite(res, finishData);
              responseChunks.push(Buffer.from(finishData));
            }
          }
        } catch {
          const sseData = `data: ${jsonStr}

`;
          safeWrite(res, sseData);
          responseChunks.push(Buffer.from(sseData));
        }
      }
      safeWrite(res, "data: [DONE]\n\n");
      responseChunks.push(Buffer.from("data: [DONE]\n\n"));
      res.end();
      deduplicator.complete(dedupKey, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: Buffer.concat(responseChunks),
        completedAt: Date.now()
      });
    } else {
      const responseHeaders = {};
      upstream.headers.forEach((value, key) => {
        if (key === "transfer-encoding" || key === "connection" || key === "content-encoding")
          return;
        responseHeaders[key] = value;
      });
      responseHeaders["x-context-used-kb"] = String(originalContextSizeKB);
      responseHeaders["x-context-limit-kb"] = String(CONTEXT_LIMIT_KB);
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            safeWrite(res, chunk);
            responseChunks.push(chunk);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();
      const responseBody = Buffer.concat(responseChunks);
      deduplicator.complete(dedupKey, {
        status: upstream.status,
        headers: responseHeaders,
        body: responseBody,
        completedAt: Date.now()
      });
      if (upstream.status === 200 && responseCache.shouldCache(body)) {
        responseCache.set(cacheKey, {
          body: responseBody,
          status: upstream.status,
          headers: responseHeaders,
          model: actualModelUsed
        });
        console.log(
          `[ClawRouter] Cached response for ${actualModelUsed} (${responseBody.length} bytes)`
        );
      }
      try {
        const rspJson = JSON.parse(responseBody.toString());
        if (rspJson.choices?.[0]?.message?.content) {
          accumulatedContent = rspJson.choices[0].message.content;
        }
      } catch {
      }
    }
    if (sessionId && accumulatedContent) {
      const events = sessionJournal.extractEvents(accumulatedContent);
      if (events.length > 0) {
        sessionJournal.record(sessionId, events, actualModelUsed);
        console.log(
          `[ClawRouter] Recorded ${events.length} events to session journal for session ${sessionId.slice(0, 8)}...`
        );
      }
    }
    if (estimatedCostMicros !== void 0) {
      balanceMonitor.deductEstimated(estimatedCostMicros);
    }
    completed = true;
  } catch (err) {
    clearTimeout(timeoutId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = void 0;
    }
    deduplicator.removeInflight(dedupKey);
    balanceMonitor.invalidate();
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  const logModel = routingDecision?.model ?? modelId;
  if (logModel) {
    const estimatedInputTokens = Math.ceil(body.length / 4);
    const accurateCosts = calculateModelCost(
      logModel,
      routerOpts.modelPricing,
      estimatedInputTokens,
      maxTokens,
      routingProfile ?? void 0
    );
    const costWithBuffer = accurateCosts.costEstimate * 1.2;
    const baselineWithBuffer = accurateCosts.baselineCost * 1.2;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      model: logModel,
      tier: routingDecision?.tier ?? "DIRECT",
      cost: costWithBuffer,
      baselineCost: baselineWithBuffer,
      savings: accurateCosts.savings,
      latencyMs: Date.now() - startTime
    };
    logUsage(entry).catch(() => {
    });
  }
}

// src/auth.ts
import { writeFile, mkdir as mkdir2 } from "fs/promises";
import { join as join4 } from "path";
import { homedir as homedir3 } from "os";
import { generatePrivateKey, privateKeyToAccount as privateKeyToAccount3 } from "viem/accounts";
var WALLET_DIR = join4(homedir3(), ".openclaw", "blockrun");
var WALLET_FILE = join4(WALLET_DIR, "wallet.key");
async function loadSavedWallet() {
  try {
    const key = (await readTextFile(WALLET_FILE)).trim();
    if (key.startsWith("0x") && key.length === 66) {
      console.log(`[ClawRouter] \u2713 Loaded existing wallet from ${WALLET_FILE}`);
      return key;
    }
    console.warn(`[ClawRouter] \u26A0 Wallet file exists but is invalid (wrong format)`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(
        `[ClawRouter] \u2717 Failed to read wallet file: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return void 0;
}
async function generateAndSaveWallet() {
  const key = generatePrivateKey();
  const account = privateKeyToAccount3(key);
  await mkdir2(WALLET_DIR, { recursive: true });
  await writeFile(WALLET_FILE, key + "\n", { mode: 384 });
  try {
    const verification = (await readTextFile(WALLET_FILE)).trim();
    if (verification !== key) {
      throw new Error("Wallet file verification failed - content mismatch");
    }
    console.log(`[ClawRouter] \u2713 Wallet saved and verified at ${WALLET_FILE}`);
  } catch (err) {
    throw new Error(
      `Failed to verify wallet file after creation: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { key, address: account.address };
}
async function resolveOrGenerateWalletKey() {
  const saved = await loadSavedWallet();
  if (saved) {
    const account = privateKeyToAccount3(saved);
    return { key: saved, address: account.address, source: "saved" };
  }
  const envKey = process["env"].BLOCKRUN_WALLET_KEY;
  if (typeof envKey === "string" && envKey.startsWith("0x") && envKey.length === 66) {
    const account = privateKeyToAccount3(envKey);
    return { key: envKey, address: account.address, source: "env" };
  }
  const { key, address } = await generateAndSaveWallet();
  return { key, address, source: "generated" };
}

// src/doctor.ts
import { platform, arch, freemem, totalmem } from "os";
function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)}GB`;
}
function green(text) {
  return `\x1B[32m\u2713\x1B[0m ${text}`;
}
function red(text) {
  return `\x1B[31m\u2717\x1B[0m ${text}`;
}
function yellow(text) {
  return `\x1B[33m\u26A0\x1B[0m ${text}`;
}
function collectSystemInfo() {
  return {
    os: `${platform()} ${arch()}`,
    arch: arch(),
    nodeVersion: process.version,
    memoryFree: formatBytes(freemem()),
    memoryTotal: formatBytes(totalmem())
  };
}
async function collectWalletInfo() {
  try {
    const { key, address, source } = await resolveOrGenerateWalletKey();
    if (!key || !address) {
      return {
        exists: false,
        valid: false,
        address: null,
        balance: null,
        isLow: false,
        isEmpty: true,
        source: null
      };
    }
    const monitor = new BalanceMonitor(address);
    try {
      const balanceInfo = await monitor.checkBalance();
      return {
        exists: true,
        valid: true,
        address,
        balance: balanceInfo.balanceUSD,
        isLow: balanceInfo.isLow,
        isEmpty: balanceInfo.isEmpty,
        source
      };
    } catch {
      return {
        exists: true,
        valid: true,
        address,
        balance: null,
        isLow: false,
        isEmpty: false,
        source
      };
    }
  } catch {
    return {
      exists: false,
      valid: false,
      address: null,
      balance: null,
      isLow: false,
      isEmpty: true,
      source: null
    };
  }
}
async function collectNetworkInfo() {
  const port = getProxyPort();
  let blockrunReachable = false;
  let blockrunLatency = null;
  try {
    const start = Date.now();
    const response = await fetch("https://blockrun.ai/api/v1/models", {
      method: "GET",
      signal: AbortSignal.timeout(1e4)
    });
    blockrunLatency = Date.now() - start;
    blockrunReachable = response.ok || response.status === 402;
  } catch {
    blockrunReachable = false;
  }
  let proxyRunning = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3e3)
    });
    proxyRunning = response.ok;
  } catch {
    proxyRunning = false;
  }
  return {
    blockrunApi: { reachable: blockrunReachable, latencyMs: blockrunLatency },
    localProxy: { running: proxyRunning, port }
  };
}
async function collectLogInfo() {
  try {
    const stats = await getStats(1);
    return {
      requestsLast24h: stats.totalRequests,
      costLast24h: `$${stats.totalCost.toFixed(4)}`,
      errorsFound: 0
      // TODO: parse error logs
    };
  } catch {
    return {
      requestsLast24h: 0,
      costLast24h: "$0.00",
      errorsFound: 0
    };
  }
}
function identifyIssues(result) {
  const issues = [];
  if (!result.wallet.exists) {
    issues.push("No wallet found");
  }
  if (result.wallet.isEmpty) {
    issues.push("Wallet is empty - need to fund with USDC on Base");
  } else if (result.wallet.isLow) {
    issues.push("Wallet balance is low (< $1.00)");
  }
  if (!result.network.blockrunApi.reachable) {
    issues.push("Cannot reach BlockRun API - check internet connection");
  }
  if (!result.network.localProxy.running) {
    issues.push(`Local proxy not running on port ${result.network.localProxy.port}`);
  }
  return issues;
}
function printDiagnostics(result) {
  console.log("\n\u{1F50D} Collecting diagnostics...\n");
  console.log("System");
  console.log(`  ${green(`OS: ${result.system.os}`)}`);
  console.log(`  ${green(`Node: ${result.system.nodeVersion}`)}`);
  console.log(
    `  ${green(`Memory: ${result.system.memoryFree} free / ${result.system.memoryTotal}`)}`
  );
  console.log("\nWallet");
  if (result.wallet.exists && result.wallet.valid) {
    console.log(`  ${green(`Key: ${WALLET_FILE} (${result.wallet.source})`)}`);
    console.log(`  ${green(`Address: ${result.wallet.address}`)}`);
    if (result.wallet.isEmpty) {
      console.log(`  ${red(`Balance: $0.00 - NEED TO FUND!`)}`);
    } else if (result.wallet.isLow) {
      console.log(`  ${yellow(`Balance: ${result.wallet.balance} (low)`)}`);
    } else if (result.wallet.balance) {
      console.log(`  ${green(`Balance: ${result.wallet.balance}`)}`);
    } else {
      console.log(`  ${yellow(`Balance: checking...`)}`);
    }
  } else {
    console.log(`  ${red("No wallet found")}`);
  }
  console.log("\nNetwork");
  if (result.network.blockrunApi.reachable) {
    console.log(
      `  ${green(`BlockRun API: reachable (${result.network.blockrunApi.latencyMs}ms)`)}`
    );
  } else {
    console.log(`  ${red("BlockRun API: unreachable")}`);
  }
  if (result.network.localProxy.running) {
    console.log(`  ${green(`Local proxy: running on :${result.network.localProxy.port}`)}`);
  } else {
    console.log(`  ${red(`Local proxy: not running on :${result.network.localProxy.port}`)}`);
  }
  console.log("\nLogs");
  console.log(
    `  ${green(`Last 24h: ${result.logs.requestsLast24h} requests, ${result.logs.costLast24h} spent`)}`
  );
  if (result.logs.errorsFound > 0) {
    console.log(`  ${yellow(`${result.logs.errorsFound} errors found in logs`)}`);
  }
  if (result.issues.length > 0) {
    console.log("\n\u26A0\uFE0F  Issues Found:");
    for (const issue of result.issues) {
      console.log(`  \u2022 ${issue}`);
    }
  }
}
var DOCTOR_MODELS = {
  sonnet: {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    cost: "~$0.003"
  },
  opus: {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    cost: "~$0.01"
  }
};
async function analyzeWithAI(diagnostics, userQuestion, model = "sonnet") {
  if (diagnostics.wallet.isEmpty) {
    console.log("\n\u{1F4B3} Wallet is empty - cannot call AI for analysis.");
    console.log(`   Fund your wallet with USDC on Base: ${diagnostics.wallet.address}`);
    console.log("   Get USDC: https://www.coinbase.com/price/usd-coin");
    console.log("   Bridge to Base: https://bridge.base.org\n");
    return;
  }
  const modelConfig = DOCTOR_MODELS[model];
  console.log(`
\u{1F4E4} Sending to ${modelConfig.name} (${modelConfig.cost})...
`);
  try {
    const { key } = await resolveOrGenerateWalletKey();
    const { fetch: paymentFetch } = createPaymentFetch(key);
    const response = await paymentFetch(
      "https://blockrun.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelConfig.id,
          stream: false,
          messages: [
            {
              role: "system",
              content: `You are a technical support expert for BlockRun and ClawRouter.
Analyze the diagnostics and:
1. Identify the root cause of any issues
2. Provide specific, actionable fix commands (bash)
3. Explain why the issue occurred briefly
4. Be concise but thorough
5. Format commands in code blocks`
            },
            {
              role: "user",
              content: userQuestion ? `Here are my system diagnostics:

${JSON.stringify(diagnostics, null, 2)}

User's question: ${userQuestion}` : `Here are my system diagnostics:

${JSON.stringify(diagnostics, null, 2)}

Please analyze and help me fix any issues.`
            }
          ],
          max_tokens: 1e3
        })
      },
      void 0
    );
    if (!response.ok) {
      const text = await response.text();
      console.log(`Error: ${response.status} - ${text}`);
      return;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      console.log("\u{1F916} AI Analysis:\n");
      console.log(content);
      console.log();
    } else {
      console.log("Error: No response from AI");
    }
  } catch (err) {
    console.log(`
Error calling AI: ${err instanceof Error ? err.message : String(err)}`);
    console.log("Try again or check your wallet balance.\n");
  }
}
async function runDoctor(userQuestion, model = "sonnet") {
  console.log(`
\u{1FA7A} BlockRun Doctor v${VERSION}
`);
  const [system, wallet, network, logs] = await Promise.all([
    collectSystemInfo(),
    collectWalletInfo(),
    collectNetworkInfo(),
    collectLogInfo()
  ]);
  const result = {
    version: VERSION,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    system,
    wallet,
    network,
    logs,
    issues: []
  };
  result.issues = identifyIssues(result);
  printDiagnostics(result);
  await analyzeWithAI(result, userQuestion, model);
}

// src/partners/registry.ts
var PARTNER_SERVICES = [
  {
    id: "x_users_lookup",
    name: "Twitter/X User Lookup",
    partner: "AttentionVC",
    description: "Look up Twitter/X user profiles by username. Returns follower counts, verification status, bio, and more. Accepts up to 100 usernames per request.",
    proxyPath: "/x/users/lookup",
    method: "POST",
    params: [
      {
        name: "usernames",
        type: "string[]",
        description: 'Array of Twitter/X usernames to look up (without @ prefix). Example: ["elonmusk", "naval"]',
        required: true
      }
    ],
    pricing: {
      perUnit: "$0.001",
      unit: "user",
      minimum: "$0.01 (10 users)",
      maximum: "$0.10 (100 users)"
    },
    example: {
      input: { usernames: ["elonmusk", "naval", "balaboris"] },
      description: "Look up 3 Twitter/X user profiles"
    }
  }
];

// src/cli.ts
function printHelp() {
  console.log(`
ClawRouter v${VERSION} - Smart LLM Router

Usage:
  clawrouter [options]
  clawrouter doctor [opus] [question]
  clawrouter partners [test]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: ${getProxyPort()})

Commands:
  doctor            AI-powered diagnostics (default: Sonnet ~$0.003)
  doctor opus       Use Opus for deeper analysis (~$0.01)
  partners          List available partner APIs with pricing
  partners test     Test partner API endpoints (expect 402 = alive)

Examples:
  # Start standalone proxy
  npx @blockrun/clawrouter

  # Run diagnostics (uses Sonnet by default)
  npx @blockrun/clawrouter doctor

  # Use Opus for complex issues
  npx @blockrun/clawrouter doctor opus

  # Ask a specific question
  npx @blockrun/clawrouter doctor "why is my request failing?"

  # Opus + question
  npx @blockrun/clawrouter doctor opus "\u6DF1\u5EA6\u5206\u6790\u6211\u7684\u914D\u7F6E\u95EE\u9898"

Environment Variables:
  BLOCKRUN_WALLET_KEY     Private key for x402 payments (auto-generated if not set)
  BLOCKRUN_PROXY_PORT     Default proxy port (default: 8402)

For more info: https://github.com/BlockRunAI/ClawRouter
`);
}
function parseArgs(args) {
  const result = {
    version: false,
    help: false,
    doctor: false,
    partners: false,
    partnersTest: false,
    port: void 0
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "doctor" || arg === "--doctor") {
      result.doctor = true;
    } else if (arg === "partners") {
      result.partners = true;
      if (args[i + 1] === "test") {
        result.partnersTest = true;
        i++;
      }
    } else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return result;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.doctor) {
    const rawArgs = process.argv.slice(2);
    const doctorIndex = rawArgs.findIndex((a) => a === "doctor" || a === "--doctor");
    const afterDoctor = rawArgs.slice(doctorIndex + 1);
    let model = "sonnet";
    let questionArgs = afterDoctor;
    if (afterDoctor[0] === "opus") {
      model = "opus";
      questionArgs = afterDoctor.slice(1);
    } else if (afterDoctor[0] === "sonnet") {
      model = "sonnet";
      questionArgs = afterDoctor.slice(1);
    }
    const userQuestion = questionArgs.join(" ").trim() || void 0;
    await runDoctor(userQuestion, model);
    process.exit(0);
  }
  if (args.partners) {
    if (PARTNER_SERVICES.length === 0) {
      console.log("No partner APIs available.");
      process.exit(0);
    }
    console.log(`
ClawRouter Partner APIs (v${VERSION})
`);
    for (const svc of PARTNER_SERVICES) {
      console.log(`  ${svc.name} (${svc.partner})`);
      console.log(`    ${svc.description}`);
      console.log(`    Tool:    blockrun_${svc.id}`);
      console.log(`    Method:  ${svc.method} /v1${svc.proxyPath}`);
      console.log(`    Pricing: ${svc.pricing.perUnit} per ${svc.pricing.unit} (min ${svc.pricing.minimum}, max ${svc.pricing.maximum})`);
      console.log();
    }
    if (args.partnersTest) {
      console.log("Testing partner endpoints...\n");
      const apiBase = "https://blockrun.ai/api";
      for (const svc of PARTNER_SERVICES) {
        const url = `${apiBase}/v1${svc.proxyPath}`;
        try {
          const response = await fetch(url, { method: "GET" });
          const status = response.status;
          const ok = status === 402 ? "alive (402 = payment required)" : `status ${status}`;
          console.log(`  ${svc.id}: ${ok}`);
        } catch (err) {
          console.log(`  ${svc.id}: error - ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      console.log();
    }
    process.exit(0);
  }
  const { key: walletKey, address, source } = await resolveOrGenerateWalletKey();
  if (source === "generated") {
    console.log(`[ClawRouter] Generated new wallet: ${address}`);
  } else if (source === "saved") {
    console.log(`[ClawRouter] Using saved wallet: ${address}`);
  } else {
    console.log(`[ClawRouter] Using wallet from BLOCKRUN_WALLET_KEY: ${address}`);
  }
  const proxy = await startProxy({
    walletKey,
    port: args.port,
    onReady: (port) => {
      console.log(`[ClawRouter] Proxy listening on http://127.0.0.1:${port}`);
      console.log(`[ClawRouter] Health check: http://127.0.0.1:${port}/health`);
    },
    onError: (error) => {
      console.error(`[ClawRouter] Error: ${error.message}`);
    },
    onRouted: (decision) => {
      const cost = decision.costEstimate.toFixed(4);
      const saved = (decision.savings * 100).toFixed(0);
      console.log(`[ClawRouter] [${decision.tier}] ${decision.model} $${cost} (saved ${saved}%)`);
    },
    onLowBalance: (info) => {
      console.warn(`[ClawRouter] Low balance: ${info.balanceUSD}. Fund: ${info.walletAddress}`);
    },
    onInsufficientFunds: (info) => {
      console.error(
        `[ClawRouter] Insufficient funds. Balance: ${info.balanceUSD}, Need: ${info.requiredUSD}`
      );
      console.error(`[ClawRouter] Need help? Run: npx @blockrun/clawrouter doctor`);
    }
  });
  const monitor = new BalanceMonitor(address);
  try {
    const balance = await monitor.checkBalance();
    if (balance.isEmpty) {
      console.log(`[ClawRouter] Wallet balance: $0.00 (using FREE model)`);
      console.log(`[ClawRouter] Fund wallet for premium models: ${address}`);
    } else if (balance.isLow) {
      console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD} (low)`);
    } else {
      console.log(`[ClawRouter] Wallet balance: ${balance.balanceUSD}`);
    }
  } catch {
    console.log(`[ClawRouter] Wallet: ${address} (balance check pending)`);
  }
  console.log(`[ClawRouter] Ready - Ctrl+C to stop`);
  const shutdown = async (signal) => {
    console.log(`
[ClawRouter] Received ${signal}, shutting down...`);
    try {
      await proxy.close();
      console.log(`[ClawRouter] Proxy closed`);
      process.exit(0);
    } catch (err) {
      console.error(`[ClawRouter] Error during shutdown: ${err}`);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await new Promise(() => {
  });
}
main().catch((err) => {
  console.error(`[ClawRouter] Fatal error: ${err.message}`);
  console.error(`[ClawRouter] Need help? Run: npx @blockrun/clawrouter doctor`);
  process.exit(1);
});
//# sourceMappingURL=cli.js.map