import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_USD, parseFixedInputArgs } from "./args.ts";

describe("parseFixedInputArgs", () => {
  it("reads every flag form, with defaults for the rest", () => {
    expect(parseFixedInputArgs(["--records", "/a", "/b"])).toEqual({
      records: ["/a", "/b"],
      units: { kind: "record" },
      requirements: { kind: "record" },
      scorers: ["current"],
      maxUsd: DEFAULT_MAX_USD,
      dryRun: false,
    });
    expect(DEFAULT_MAX_USD).toBe(0.1);
    expect(
      parseFixedInputArgs([
        "--records=/a",
        "--records",
        "/c",
        "--units",
        "gold",
        "--requirements=gold",
        "--scorer",
        "current,renormalized,cosine",
        "--k",
        "48",
        "--embeddings-cache",
        "/x/cache.jsonl",
        "--out",
        "/x/out",
        "--max-usd",
        "0.5",
        "--dry-run",
      ]),
    ).toEqual({
      records: ["/a", "/c"],
      units: { kind: "gold" },
      requirements: { kind: "gold" },
      scorers: ["current", "renormalized", "cosine"],
      k: 48,
      embeddingsCache: "/x/cache.jsonl",
      out: "/x/out",
      maxUsd: 0.5,
      dryRun: true,
    });
  });

  it("takes repeated corrections files, one per cell", () => {
    const args = parseFixedInputArgs(["--records", "/a", "--units", "/c/one.json", "--units", "/c/two.json"]);
    expect(args.units).toEqual({ kind: "corrections", paths: ["/c/one.json", "/c/two.json"] });
    expect(args.requirements).toEqual({ kind: "record" });
  });

  it("refuses unknown, missing, repeated or malformed flags", () => {
    expect(() => parseFixedInputArgs(["--units", "gold"])).toThrow(/--records requires/);
    expect(() => parseFixedInputArgs(["--records"])).toThrow(/--records requires a value/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--unit", "gold"])).toThrow(/Unknown flag/);
    expect(() => parseFixedInputArgs(["stray", "--records", "/a"])).toThrow(/Unexpected argument/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--scorer", "best"])).toThrow(/--scorer must be/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--scorer", "current,current"])).toThrow(/twice/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--k", "0"])).toThrow(/--k must be a positive integer/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--k", "2.5"])).toThrow(/--k/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--max-usd", "0"])).toThrow(/--max-usd/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--max-usd", "-1"])).toThrow(/--max-usd/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--k", "3", "--k", "4"])).toThrow(/more than once/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--dry-run=1"])).toThrow(/takes no value/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--units", "gold", "--units", "/c.json"])).toThrow(/not a mix/);
    expect(() => parseFixedInputArgs(["--records", "/a", "--units", "/c.json", "--units", "/c.json"])).toThrow(/twice/);
  });
});
