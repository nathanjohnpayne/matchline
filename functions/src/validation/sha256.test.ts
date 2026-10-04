import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256.ts";

const nodeSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches Node's crypto across block boundaries and non-ASCII input", () => {
    // 55/56/63/64/65 bytes straddle the single- vs two-block padding cases.
    const lengths = [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 10_000];
    for (const n of lengths) {
      const text = "x".repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(nodeSha256(text));
    }
    for (const text of ["Led a team — 40% ↑", "日本語のテキスト", JSON.stringify({ a: ["b", 1] }), "🚀".repeat(40)]) {
      expect(sha256Hex(text)).toBe(nodeSha256(text));
    }
  });
});
