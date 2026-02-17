import { describe, it, expect, afterEach, vi } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createPaymentFetch } from "./x402.js";

const TEST_WALLET_KEY = `0x${"1".repeat(64)}` as `0x${string}`;

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type PaymentPayload = {
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepted: {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds?: number;
    extra?: { name?: string; version?: string };
  };
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
};

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function encodeBase64Url(value: unknown): string {
  return encodeBase64Json(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

describe("x402 payment payload compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses 402 option fields for accepted/resource and sends both payment headers", async () => {
    const option = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "4200",
      asset: "0x1111111111111111111111111111111111111111",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 120,
      extra: { name: "USDC Mock", version: "1" },
    };
    const paymentRequired = {
      accepts: [option],
      resource: {
        url: "https://blockrun.ai/api/v1/chat/completions",
        description: "canonical endpoint",
      },
    };

    let retryHeaders: Headers | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("payment required", {
          status: 402,
          headers: { "x-payment-required": encodeBase64Url(paymentRequired) },
        }),
      )
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
        retryHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fetch: payFetch } = createPaymentFetch(TEST_WALLET_KEY);
    const response = await payFetch("https://blockrun.ai/api/v1/chat/completions?debug=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retryHeaders).toBeDefined();

    const paymentSignature = retryHeaders!.get("payment-signature");
    expect(paymentSignature).toBeTruthy();
    expect(retryHeaders!.get("x-payment")).toBe(paymentSignature);

    const payload = decodeBase64Json<PaymentPayload>(paymentSignature!);
    expect(payload.accepted).toMatchObject({
      scheme: option.scheme,
      network: option.network,
      amount: option.amount,
      asset: option.asset,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      extra: option.extra,
    });
    expect(payload.resource.url).toBe(paymentRequired.resource.url);
    expect(payload.resource.description).toBe(paymentRequired.resource.description);

    const account = privateKeyToAccount(TEST_WALLET_KEY);
    const isValid = await verifyTypedData({
      address: account.address,
      domain: {
        name: option.extra.name,
        version: option.extra.version,
        chainId: 84532,
        verifyingContract: option.asset as `0x${string}`,
      },
      types: TRANSFER_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: payload.payload.authorization.from,
        to: payload.payload.authorization.to,
        value: BigInt(payload.payload.authorization.value),
        validAfter: BigInt(payload.payload.authorization.validAfter),
        validBefore: BigInt(payload.payload.authorization.validBefore),
        nonce: payload.payload.authorization.nonce,
      },
      signature: payload.payload.signature,
    });

    expect(isValid).toBe(true);
  });

  it("reuses cached canonical resource URL for pre-auth payloads", async () => {
    const option = {
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: "1000",
      asset: "0x3333333333333333333333333333333333333333",
      payTo: "0x4444444444444444444444444444444444444444",
      maxTimeoutSeconds: 90,
      extra: { name: "USDC", version: "2" },
    };
    const paymentRequired = {
      accepts: [option],
      resource: {
        url: "https://blockrun.ai/api/v1/chat/completions",
        description: "canonical resource",
      },
    };

    let callCount = 0;
    let preAuthHeaders: Headers | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;

        if (callCount === 1) {
          return new Response("payment required", {
            status: 402,
            headers: { "x-payment-required": encodeBase64Json(paymentRequired) },
          });
        }

        if (callCount === 2) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        if (callCount === 3) {
          preAuthHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        throw new Error(`Unexpected fetch call #${callCount}`);
      });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { fetch: payFetch } = createPaymentFetch(TEST_WALLET_KEY);

    // First request: 402 -> signed retry (fills payment cache).
    await payFetch("https://blockrun.ai/api/v1/chat/completions?first=1", {
      method: "POST",
      body: JSON.stringify({ model: "moonshot/kimi-k2.5" }),
    });

    // Second request: pre-auth path should sign using cached canonical resource.
    await payFetch(
      "https://blockrun.ai/api/v1/chat/completions?second=1",
      {
        method: "POST",
        body: JSON.stringify({ model: "moonshot/kimi-k2.5" }),
      },
      { estimatedAmount: "2000" },
    );

    expect(preAuthHeaders).toBeDefined();
    const paymentSignature = preAuthHeaders!.get("payment-signature");
    expect(paymentSignature).toBeTruthy();
    expect(preAuthHeaders!.get("x-payment")).toBe(paymentSignature);

    const payload = decodeBase64Json<PaymentPayload>(paymentSignature!);
    expect(payload.resource.url).toBe(paymentRequired.resource.url);
    expect(payload.resource.description).toBe(paymentRequired.resource.description);
    expect(payload.payload.authorization.value).toBe("2000");
  });
});
