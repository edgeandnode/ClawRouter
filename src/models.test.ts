import { describe, expect, it } from "vitest";

import { resolveModelAlias } from "./models.js";

describe("resolveModelAlias", () => {
  it("maps legacy Claude IDs to backend model names", () => {
    // Backend uses bare model names (claude-sonnet-4, not anthropic/claude-sonnet-4-6)
    expect(resolveModelAlias("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4");
    expect(resolveModelAlias("anthropic/claude-opus-4.6")).toBe("claude-opus-4");
    expect(resolveModelAlias("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
  });

  it("resolves legacy IDs even when sent with blockrun/ prefix", () => {
    expect(resolveModelAlias("blockrun/anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4");
    expect(resolveModelAlias("blockrun/anthropic/claude-opus-4.6")).toBe("claude-opus-4");
  });
});
