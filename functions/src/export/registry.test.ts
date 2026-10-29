/**
 * Tests for the export format registry (#521).
 */

import { describe, expect, it } from "vitest";

import { registeredExportFormats, rendererFor, UnsupportedExportFormat } from "./registry.ts";
import { textRenderer } from "./text.ts";
import { EXPORT_FORMAT_ORDER } from "./types.ts";

describe("rendererFor", () => {
  it("returns the plain-text renderer for txt", () => {
    expect(rendererFor("txt")).toBe(textRenderer);
  });

  it.each(["pdf", "docx"])("rejects %s, a known format with no renderer yet", (format) => {
    expect(() => rendererFor(format)).toThrow(UnsupportedExportFormat);
  });

  it.each([["json"], ["rtf"], [""], ["TXT"], [" txt"], ["toString"], ["__proto__"], [undefined], [null], [42], [{}]])(
    "rejects %j",
    (format) => {
      expect(() => rendererFor(format)).toThrow(UnsupportedExportFormat);
    },
  );

  it("names the bad format and the supported ones in the message", () => {
    try {
      rendererFor("rtf");
      expect.unreachable("rendererFor should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedExportFormat);
      expect((err as UnsupportedExportFormat).format).toBe("rtf");
      expect((err as Error).message).toBe('Unsupported export format "rtf". Supported: txt.');
    }
  });

  it("echoes at most 32 characters of a 10,000-character format", () => {
    const format = "x".repeat(10_000);
    let thrown: unknown;
    try {
      rendererFor(format);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedExportFormat);
    const message = (thrown as Error).message;
    expect(message).toBe(`Unsupported export format "${"x".repeat(32)}". Supported: txt.`);
    expect(message.length).toBeLessThan(100);
  });

  it("JSON-escapes the echoed format, so quotes and control characters cannot shape the message", () => {
    expect(new UnsupportedExportFormat('a"b\\c\nd').message).toBe(
      'Unsupported export format "a\\"b\\\\c\\nd". Supported: txt.',
    );
  });

  it.each([
    [undefined, "undefined"],
    [null, "object"],
    [42, "number"],
    [{ toString: () => "x".repeat(10_000) }, "object"],
  ])("names only the type of a non-string format (%j)", (format, type) => {
    expect(new UnsupportedExportFormat(format).message).toBe(`Unsupported export format ${type}. Supported: txt.`);
  });
});

describe("registeredExportFormats", () => {
  it("lists txt only today", () => {
    expect(registeredExportFormats()).toEqual(["txt"]);
  });

  it("keeps EXPORT_FORMAT_ORDER", () => {
    const registered = registeredExportFormats();
    const positions = registered.map((f) => EXPORT_FORMAT_ORDER.indexOf(f));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
