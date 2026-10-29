/**
 * Tests for the export download filename and Content-Disposition (#521).
 */

import { describe, expect, it } from "vitest";

import {
  asciiFallback,
  contentDisposition,
  exportFilename,
  FILENAME_SEPARATOR,
  MAX_FILENAME_PART_CODE_POINTS,
  rfc5987,
  sanitizeFilenamePart,
} from "./filename.ts";

const EM_DASH = "\u2014";

describe("exportFilename", () => {
  it("joins company and title with a real em dash", () => {
    const name = exportFilename({ company: "Acme", title: "Senior PM", extension: "txt" });
    expect(name).toBe(`Acme ${EM_DASH} Senior PM ${EM_DASH} Resume.txt`);
    expect(FILENAME_SEPARATOR).toBe(` ${EM_DASH} `);
    expect(name).not.toContain(" - ");
  });

  it.each([undefined, null, "", "   ", "\t\n"])("leaves out a missing company (%j)", (company) => {
    expect(exportFilename({ company, title: "Senior PM", extension: "txt" })).toBe(
      `Senior PM ${EM_DASH} Resume.txt`,
    );
  });

  it("leaves out a missing title", () => {
    expect(exportFilename({ company: "Acme", title: "", extension: "txt" })).toBe(`Acme ${EM_DASH} Resume.txt`);
  });

  it("is just Resume.{ext} with neither part", () => {
    expect(exportFilename({ extension: "txt" })).toBe("Resume.txt");
  });

  it("keeps non-ASCII text as typed", () => {
    const name = exportFilename({ company: "Zürich Café", title: "Ingeniera de Datos", extension: "txt" });
    expect(name).toBe(`Zürich Café ${EM_DASH} Ingeniera de Datos ${EM_DASH} Resume.txt`);
    // Decomposed input stays decomposed: no normalization.
    const decomposed = "Cafe\u0301";
    expect(exportFilename({ company: decomposed, extension: "txt" })).toBe(`${decomposed} ${EM_DASH} Resume.txt`);
  });

  it("is deterministic", () => {
    const input = { company: "株式会社 Example", title: "PM — Platform", extension: "txt" };
    expect(exportFilename(input)).toBe(exportFilename(input));
  });
});

describe("sanitizeFilenamePart", () => {
  it("replaces path and reserved characters with spaces and collapses whitespace", () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeFilenamePart("  Senior   PM\t\n ")).toBe("Senior PM");
  });

  it("drops control characters", () => {
    expect(sanitizeFilenamePart("Ac\u0000me\u0007\u009f")).toBe("Acme");
  });

  it("strips leading dots", () => {
    expect(sanitizeFilenamePart("..hidden")).toBe("hidden");
    expect(sanitizeFilenamePart("../../etc")).toBe("etc");
    expect(sanitizeFilenamePart("...")).toBe("");
  });

  it("caps a part by code points without splitting a surrogate pair", () => {
    const long = "😀".repeat(MAX_FILENAME_PART_CODE_POINTS + 5);
    const cut = sanitizeFilenamePart(long);
    expect(Array.from(cut)).toHaveLength(MAX_FILENAME_PART_CODE_POINTS);
    expect(cut).toBe("😀".repeat(MAX_FILENAME_PART_CODE_POINTS));
    expect(/[\ud800-\udbff]$/.test(cut)).toBe(false);
  });

  it("keeps a part of exactly the cap", () => {
    const exact = "a".repeat(MAX_FILENAME_PART_CODE_POINTS);
    expect(sanitizeFilenamePart(exact)).toBe(exact);
  });
});

describe("asciiFallback", () => {
  it("turns dashes into hyphens and strips accents", () => {
    expect(asciiFallback(`Zürich Café ${EM_DASH} PM \u2013 Data ${EM_DASH} Resume.txt`)).toBe(
      "Zurich Cafe - PM - Data - Resume.txt",
    );
  });

  it("replaces other non-ASCII with underscores and is pure ASCII", () => {
    const out = asciiFallback(`株式会社 ${EM_DASH} PM 🚀 ${EM_DASH} Resume.txt`);
    expect(out).toBe("____ - PM _ - Resume.txt");
    expect(/^[\x20-\x7e]*$/.test(out)).toBe(true);
  });

  it("removes quotes and backslashes", () => {
    expect(asciiFallback('a"b\\c')).toBe("abc");
  });
});

describe("rfc5987", () => {
  it("percent-encodes UTF-8, spaces and the characters encodeURIComponent leaves", () => {
    expect(rfc5987(EM_DASH)).toBe("%E2%80%94");
    expect(rfc5987("a b")).toBe("a%20b");
    expect(rfc5987("O'Brien (x)*")).toBe("O%27Brien%20%28x%29%2A");
  });
});

describe("contentDisposition", () => {
  it("gives the exact header for an ASCII-titled export", () => {
    const name = exportFilename({ company: "Acme", title: "Senior PM", extension: "txt" });
    expect(contentDisposition(name)).toBe(
      "attachment; filename=\"Acme - Senior PM - Resume.txt\"; filename*=UTF-8''Acme%20%E2%80%94%20Senior%20PM%20%E2%80%94%20Resume.txt",
    );
  });

  it("gives the exact header for a non-ASCII name", () => {
    const name = exportFilename({ company: "Zürich Café", title: "PM", extension: "txt" });
    expect(contentDisposition(name)).toBe(
      "attachment; filename=\"Zurich Cafe - PM - Resume.txt\"; filename*=UTF-8''Z%C3%BCrich%20Caf%C3%A9%20%E2%80%94%20PM%20%E2%80%94%20Resume.txt",
    );
  });

  it("is all ASCII, starts with attachment and never has a raw quote inside the value", () => {
    const header = contentDisposition(exportFilename({ company: 'Q"uote', title: "日本", extension: "txt" }));
    expect(header.startsWith("attachment; ")).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
    const quoted = /filename="([^"]*)"/.exec(header);
    expect(quoted).not.toBeNull();
    expect(header.match(/"/g)).toHaveLength(2);
  });

  it("round-trips the UTF-8 name through filename*", () => {
    const name = exportFilename({ company: "Zürich Café", title: "PM 🚀", extension: "txt" });
    const encoded = /filename\*=UTF-8''(.*)$/.exec(contentDisposition(name))?.[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe(name);
  });
});
