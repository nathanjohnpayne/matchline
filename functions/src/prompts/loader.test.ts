import { describe, expect, it, beforeEach } from "vitest";

import { PROMPT_CONFIG, activeVersion } from "./config.ts";
import {
  _clearCacheForTests,
  loadPromptText,
  parsePromptSections,
} from "./loader.ts";

describe("activeVersion", () => {
  it("returns the configured active version for a known (stage, name)", () => {
    expect(activeVersion("extraction", "resume")).toBe("v1");
  });

  it("PROMPT_CONFIG's extraction.resume entry is v1 (matches #66)", () => {
    // Pins the release state so flipping to v2 without updating this
    // test catches the intent-to-ship signal.
    expect(PROMPT_CONFIG.extraction.resume).toBe("v1");
  });
});

describe("parsePromptSections", () => {
  it("splits a well-formed prompt on '## System' and '## User (few-shot)'", () => {
    const raw = [
      "# Extraction prompt — resume.v1",
      "",
      "Preamble that gets ignored.",
      "",
      "## System",
      "",
      "Be careful. Return via the tool.",
      "",
      "## User (few-shot)",
      "",
      "Example input follows.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Be careful. Return via the tool.");
    expect(userFewShot).toBe("Example input follows.");
  });

  it("normalizes CRLF line endings", () => {
    const raw = "## System\r\nrules here\r\n\r\n## User (few-shot)\r\nexample";
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("rules here");
    expect(userFewShot).toBe("example");
  });

  it("throws when the System section is missing", () => {
    expect(() =>
      parsePromptSections("\n## User (few-shot)\nexample", "test.md"),
    ).toThrow(/missing a '## System' section/);
  });

  it("throws when the User (few-shot) section is missing", () => {
    expect(() =>
      parsePromptSections("\n## System\nrules", "test.md"),
    ).toThrow(/missing a '## User \(few-shot\)' section/);
  });

  it("throws when the User section precedes the System section", () => {
    // This is a prompt-authoring mistake — the loader catches it
    // loudly rather than silently slicing wrong.
    const raw = "\n## User (few-shot)\nexample\n\n## System\nrules";
    expect(() => parsePromptSections(raw, "test.md")).toThrow(
      /appears before '## System'/,
    );
  });

  it("does not match substring headings like '## Systematic approach'", () => {
    // Prior indexOf-based scan would have matched "## System"
    // inside "## Systematic" and sliced wrong. Line-based match
    // now requires the line to equal "## System" exactly — the
    // substring heading below doesn't count.
    const raw = [
      "# Preamble",
      "",
      "## Systematic approach",
      "This section looks like a System heading but isn't.",
      "",
      "## System",
      "Real rules here.",
      "",
      "## User (few-shot)",
      "Real example here.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules here.");
    expect(userFewShot).toBe("Real example here.");
  });

  it("handles tilde fences (~~~) per CommonMark", () => {
    const raw = [
      "Preamble with a tilde-fenced example:",
      "",
      "~~~markdown",
      "## System",
      "fake",
      "~~~",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });

  it("handles indented fences (up to 3 leading spaces) per CommonMark", () => {
    const raw = [
      "Preamble with an indented fence:",
      "",
      "   ```",
      "   ## System",
      "   fake",
      "   ```",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });

  it("does NOT cross-close a backtick fence with a tilde fence", () => {
    // A tilde run inside a backtick fence must not close the outer
    // backtick fence — CommonMark requires same-char closure.
    const raw = [
      "```markdown",
      "Inside a backtick fence:",
      "~~~",
      "## System",
      "fake",
      "~~~",
      "```",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });

  it("handles nested fences correctly (4-tick outer showing 3-tick inner)", () => {
    // CommonMark rule: a fence opened with N backticks is only
    // closed by a fence of N or more backticks. A 3-tick line
    // inside a 4-tick outer fence does NOT close the outer. If we
    // got this wrong, the `## System` lines inside the inner
    // example would be mistaken for the real headings.
    const raw = [
      "# Preamble documenting the format",
      "",
      "````markdown",
      "Here's what a prompt file looks like:",
      "",
      "```",
      "## System",
      "fake system",
      "",
      "## User (few-shot)",
      "fake user",
      "```",
      "````",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });

  it("ignores section headings inside fenced code blocks (Codex P2 fix)", () => {
    // A prompt author documenting the format with a fenced example
    // in the preamble must not trip the parser. Only real (non-
    // fenced) top-level headings count.
    const raw = [
      "# Preamble with format example",
      "",
      "```markdown",
      "## System",
      "example system content that IS NOT the real heading",
      "",
      "## User (few-shot)",
      "example user content that IS NOT the real heading",
      "```",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });

  it("ignores a mention of '## System' inside preamble commentary", () => {
    // Commentary above the real heading that quotes the heading
    // in prose (e.g. "the ## System section below...") must not be
    // mistaken for the real heading. Line-based match means only
    // lines that ARE exactly "## System" count.
    const raw = [
      "Preamble line 1.",
      "This prompt uses a ## System heading convention (see below).",
      "",
      "## System",
      "Real rules.",
      "",
      "## User (few-shot)",
      "Real example.",
    ].join("\n");
    const { system, userFewShot } = parsePromptSections(raw);
    expect(system).toBe("Real rules.");
    expect(userFewShot).toBe("Real example.");
  });
});

describe("loadPromptText (integration with real prompt files)", () => {
  beforeEach(() => {
    _clearCacheForTests();
  });

  it("loads the real extraction/resume.v1.md file end-to-end", () => {
    const p = loadPromptText("extraction", "resume");
    expect(p.stage).toBe("extraction");
    expect(p.name).toBe("resume");
    expect(p.version).toBe("v1");
    // System section has the hard-rules block from the real file.
    expect(p.system).toMatch(/Evidence grounded/);
    // Few-shot section has the example input from the real file.
    expect(p.userFewShot).toMatch(/Example input/);
  });

  it("caches loaded prompts (second load doesn't re-read disk)", () => {
    const first = loadPromptText("extraction", "resume");
    const second = loadPromptText("extraction", "resume");
    // Reference equality — the cached object is returned, not
    // reparsed.
    expect(second).toBe(first);
  });
});
