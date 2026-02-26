/**
 * Ampersend Integration
 *
 * Payments go through Ampersend's smart account system with spend limits and budget controls.
 *
 * Configuration via OpenClaw plugin config:
 *   openclaw config set plugins.entries.clawrouter.ampersend_agent_key "0xSmartAccount:::0xSessionKey"
 */

import { createAmpersendHttpClient } from "@ampersend_ai/ampersend-sdk";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { PreAuthParams } from "./x402.js";

export type PaymentFetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
  preAuth?: PreAuthParams,
) => Promise<Response>;

export type AmpersendConfig = {
  address: string;
  paymentFetch: PaymentFetchFn;
};

type PluginConfig = {
  ampersend_agent_key?: string;
};

/**
 * Parse ampersend_agent_key in format "0xSmartAccount:::0xSessionKey"
 */
function parseAgentKey(key: string): {
  smartAccountAddress: `0x${string}`;
  sessionKey: `0x${string}`;
} {
  const parts = key.split(":::");
  if (parts.length !== 2) {
    throw new Error("Invalid ampersend_agent_key format. Expected: 0xSmartAccount:::0xSessionKey");
  }
  const [smartAccountAddress, sessionKey] = parts;
  if (!smartAccountAddress.startsWith("0x") || !sessionKey.startsWith("0x")) {
    throw new Error("Invalid ampersend_agent_key: both parts must be 0x-prefixed addresses");
  }
  return {
    smartAccountAddress: smartAccountAddress as `0x${string}`,
    sessionKey: sessionKey as `0x${string}`,
  };
}

/**
 * Resolve Ampersend configuration from plugin config.
 */
export function resolveAmpersendConfig(pluginConfig: PluginConfig): AmpersendConfig {
  const agentKey = pluginConfig.ampersend_agent_key;

  if (!agentKey) {
    throw new Error(
      "Missing ampersend_agent_key. Set via:\n" +
        "  openclaw config set plugins.entries.clawrouter.ampersend_agent_key '0xSmartAccount:::0xSessionKey'\n" +
        "Get your key from https://app.ampersend.ai",
    );
  }

  const { smartAccountAddress, sessionKey } = parseAgentKey(agentKey);

  const client = createAmpersendHttpClient({
    smartAccountAddress,
    sessionKeyPrivateKey: sessionKey,
    apiUrl: process.env.AMPERSEND_API_URL ?? "https://api.ampersend.ai",
  });

  const wrappedFetch = wrapFetchWithPayment(fetch, client);

  return {
    address: smartAccountAddress,
    paymentFetch: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      wrappedFetch(input instanceof URL ? input.toString() : input, init),
  };
}
