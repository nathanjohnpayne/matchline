import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { GeneratedAssetContent, GeneratedItem } from "../types/crm.ts";
import { plainTextOf, renderPlainText, TEXT_CONTENT_TYPE, textRenderer } from "./text.ts";
import { EXPORT_FORMAT_ORDER, InvalidExportContent } from "./types.ts";

let nextId = 0;
const item = (text: string, units: string[] = ["u1"]): GeneratedItem => ({
  id: `i${++nextId}`,
  text,
  source_unit_ids: units,
});

const FIXTURE: GeneratedAssetContent = {
  summary: item("Product leader with 12 years shipping consumer subscription apps — most recently at a streaming service."),
  bullets: [
    item("Led a **cross-functional** team of 14 to rebuild checkout → conversion up 18%."),
    item("Cut onboarding drop-off from 41% to 27% by redesigning the *first-run* flow."),
    item("Shipped the “Family plan” to 3 markets in two quarters."),
  ],
  skills: [item("Pricing & packaging"), item("SQL, `dbt`, Looker")],
  education: [item("B.A., Economics — Université de Montréal")],
};

const EXPECTED = [
  "SUMMARY",
  "Product leader with 12 years shipping consumer subscription apps — most recently at a streaming service.",
  "",
  "EXPERIENCE",
  "- Led a cross-functional team of 14 to rebuild checkout → conversion up 18%.",
  "- Cut onboarding drop-off from 41% to 27% by redesigning the first-run flow.",
  "- Shipped the “Family plan” to 3 markets in two quarters.",
  "",
  "SKILLS",
  "- Pricing & packaging",
  "- SQL, dbt, Looker",
  "",
  "EDUCATION",
  "- B.A., Economics — Université de Montréal",
  "",
].join("\n");

const withBullets = (texts: string[]): GeneratedAssetContent => ({
  summary: item("Summary."),
  bullets: texts.map((t) => item(t)),
  skills: [],
});

describe("renderPlainText: fixture asset", () => {
  it("renders the exact expected text, sections in editor order", () => {
    expect(renderPlainText(FIXTURE)).toBe(EXPECTED);
  });

  it("separates sections by exactly one blank line and ends with one newline", () => {
    const out = renderPlainText(FIXTURE);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out).not.toMatch(/\n\n\n/);
    expect(out.match(/^(SUMMARY|EXPERIENCE|SKILLS|EDUCATION)$/gm)).toEqual(["SUMMARY", "EXPERIENCE", "SKILLS", "EDUCATION"]);
  });
});

describe("determinism", () => {
  it("gives byte-identical output for the same input, via the string and the renderer", async () => {
    expect(renderPlainText(FIXTURE)).toBe(renderPlainText(FIXTURE));
    const a = await textRenderer.render(FIXTURE);
    const b = await textRenderer.render(structuredClone(FIXTURE));
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.bytes).toEqual(b.bytes);
  });

  it("renders items in stored array order, not id order; a reorder is a different but stable output", () => {
    const reordered = { ...FIXTURE, bullets: [...FIXTURE.bullets].reverse() };
    const out = renderPlainText(reordered);
    expect(out).not.toBe(renderPlainText(FIXTURE));
    expect(out).toBe(renderPlainText(reordered));
    const lines = out.split("\n");
    expect(lines.indexOf("- Shipped the “Family plan” to 3 markets in two quarters.")).toBeLessThan(
      lines.indexOf("- Led a cross-functional team of 14 to rebuild checkout → conversion up 18%."),
    );
  });
});

describe("line endings and whitespace", () => {
  const messy: GeneratedAssetContent = {
    summary: item("  Line one\r\nline two\rline three\u2028line four\u2029line five\u0085six   "),
    bullets: [item("Trailing spaces   "), item("Trailing tab\t"), item("Inner\t\ttabs  and   spaces"), item("Form\ffeed\vtab")],
    skills: [item("\tLeading tab")],
  };

  it("uses only \\n line endings, even when item text carries CR, CRLF, NEL, LS or PS", () => {
    const out = renderPlainText(messy);
    expect(out).not.toMatch(/[\r\u0085\u2028\u2029]/);
    expect(out.split("\n")[1]).toBe("Line one line two line three line four line five six");
  });

  it("leaves no trailing whitespace on any line", () => {
    const out = renderPlainText(messy);
    for (const line of out.split("\n")) expect(line).not.toMatch(/\s$/u);
    expect(out).not.toMatch(/[ \t]+$/m);
  });

  it("collapses runs of ASCII whitespace to one space", () => {
    const out = renderPlainText(messy);
    expect(out).toContain("- Inner tabs and spaces\n");
    expect(out).toContain("- Form feed tab\n");
    expect(out).toContain("- Leading tab\n");
  });

  it("joins a multi-line bullet into one line, keeping the `- ` structure", () => {
    const out = renderPlainText(withBullets(["Built the pipeline\nand ran it\n\nin production"]));
    expect(out).toContain("\n- Built the pipeline and ran it in production\n");
  });
});

describe("markdown reduction", () => {
  const cases: Array<[string, string]> = [
    // `__word__` around one identifier-like token reads as a dunder name (`__slots__`) wherever it
    // appears, so it keeps its underscores; `__` is reduced only around text with a space or non-word character.
    ["**bold** and __strong__", "bold and __strong__"],
    ["__strong__ and **bold**", "__strong__ and bold"],
    ["__strong text__ and **bold**", "strong text and bold"],
    ["__go-to-market__ lead", "go-to-market lead"],
    ["*italic* and _emphasis_", "italic and emphasis"],
    // Plain text has no strikethrough, so the tildes are kept rather than presenting struck text as live.
    ["~~struck~~ text", "~~struck~~ text"],
    ["uses `inline code`", "uses inline code"],
    ["uses ``code with ` tick``", "uses code with ` tick"],
    ["`**not bold** inside code`", "**not bold** inside code"],
    ["## Heading text", "Heading text"],
    // Blockquote and ordered-list markers are kept: `>40%` and `2019.` are claims, not markup.
    ["> quoted line", "> quoted line"],
    ["> > nested quote", "> > nested quote"],
    ["- leading list marker", "leading list marker"],
    ["* star list marker", "star list marker"],
    ["1. numbered marker", "1. numbered marker"],
    ["see [the case study](https://example.com/case)", "see the case study (https://example.com/case)"],
    ['see [docs](https://example.com/d "Title")', "see docs (https://example.com/d)"],
    ["[https://example.com](https://example.com)", "https://example.com"],
    ["![Team photo](https://example.com/p.png) caption", "Team photo caption"],
    ["mail <mailto:me@example.com> or <https://example.com>", "mail mailto:me@example.com or https://example.com"],
    ["escaped \\*literal\\* stars", "escaped *literal* stars"],
    ["[spec](https://example.com/_draft_/a*b*)", "spec (https://example.com/_draft_/a*b*)"],
    ["<https://example.com/__init__>", "https://example.com/__init__"],
    ["read https://example.com/_notes_/x.", "read https://example.com/_notes_/x."],
    ["**see https://example.com/a_b_c**", "see https://example.com/a_b_c"],
    ["escaped \\_under\\_ and \\# hash and \\[bracket\\]", "escaped _under_ and # hash and [bracket]"],
    ["***both***", "both"],
    ["line one\n---\nline two", "line one line two"],
  ];

  it.each(cases)("%j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    [">40% faster onboarding", ">40% faster onboarding"],
    [">10M users", ">10M users"],
    ["> 10M daily users served", "> 10M daily users served"],
    ["2019. B.A. History", "2019. B.A. History"],
    ["2019. Promoted to Director", "2019. Promoted to Director"],
    ["2024. Joined X", "2024. Joined X"],
    ["1999) Founded", "1999) Founded"],
    ["1984) era", "1984) era"],
    ["1) Led", "1) Led"],
    ["+ 12% NRR", "+ 12% NRR"],
    ["+ 40% net revenue retention", "+ 40% net revenue retention"],
    ["- 30% cost", "- 30% cost"],
    ["- $2M saved", "- $2M saved"],
    ["* 5x throughput", "* 5x throughput"],
    ["# 1 ranked team", "# 1 ranked team"],
    ["# 1 ranked app", "# 1 ranked app"],
    ["ok\n2020. continued", "ok 2020. continued"],
    ["Led team of 12\n> 5 regions", "Led team of 12 > 5 regions"],
    ["Cut churn ~~12%~~ **18%**", "Cut churn ~~12%~~ 18%"],
    ["__init__.py", "__init__.py"],
    ["__slots__", "__slots__"],
    ["Python (__call__(), __slots__)", "Python (__call__(), __slots__)"],
    // A single identifier-like token keeps its underscores whatever follows it.
    ["__Python__, Go", "__Python__, Go"],
    ["Implemented __init__ hooks", "Implemented __init__ hooks"],
    ["via __init__ work", "via __init__ work"],
    ["__slots__ and __dict__ tuning", "__slots__ and __dict__ tuning"],
    ["__2024__ launch", "__2024__ launch"],
    ["__Platform team__, 2024", "Platform team, 2024"],
    ["- Led the team", "Led the team"],
    ["+ Grew revenue", "Grew revenue"],
    ["## Platform work", "Platform work"],
  ])("keeps a leading token that can carry a claim: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it("a bullet item that starts with a sign keeps it after the list prefix", () => {
    const out = renderPlainText(withBullets(["+ 40% net revenue retention", ">10M users"]));
    expect(out).toContain("\n- + 40% net revenue retention\n");
    expect(out).toContain("\n- >10M users\n");
  });

  it("does not strip characters that are not markup", () => {
    for (const literal of [
      "snake_case_name",
      "5*3*2",
      "2 * 3 = 6",
      "C# and F#",
      "node.js",
      "a_b",
      "#1 ranked app",
      "100% of 2,000 users",
      "+15% NPS",
      "2019 – 2024",
      "Q3 2024: launched",
      "user@example.com",
      "tilde ~ alone",
      "back\\slash",
    ]) {
      expect(plainTextOf(literal)).toBe(literal);
    }
  });

  it("an item that is only markup is skipped like an empty item", () => {
    const out = renderPlainText(withBullets(["---", "Real bullet.", "   "]));
    expect(out).toBe("SUMMARY\nSummary.\n\nEXPERIENCE\n- Real bullet.\n");
  });
});

describe("Unicode preservation (#141 glyph-loss guard)", () => {
  const glyphs = [
    "—",
    "–",
    "→",
    "↑",
    "“quoted”",
    "‘single’",
    "a\u00a0b",
    "café",
    "naïve",
    "Zürich",
    "東京",
    "데이터",
    "🚀",
    "👩🏽‍💻",
    "e\u0301",
    "…",
  ];

  it("passes every glyph through byte-identically, with no normalization", async () => {
    const text = `Shipped ${glyphs.join(" ")} done`;
    const content = withBullets([text]);
    const out = renderPlainText(content);
    expect(out).toContain(`- ${text}\n`);
    const { bytes } = await textRenderer.render(content);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(decoded).toBe(out);
    expect(Buffer.from(bytes).includes(Buffer.from("—", "utf8"))).toBe(true);
    expect(decoded).toContain("e\u0301");
    // The decomposed "e\u0301" was not composed to "\u00e9": no normalization ran.
    expect(decoded.normalize("NFC")).not.toBe(decoded);
  });
});

describe("every item exactly once", () => {
  it("emits each distinct item text exactly once", () => {
    const out = renderPlainText(FIXTURE);
    const items = [FIXTURE.summary, ...FIXTURE.bullets, ...FIXTURE.skills, ...(FIXTURE.education ?? [])];
    for (const it of items) {
      const text = plainTextOf(it.text);
      expect(out.split(text).length - 1).toBe(1);
    }
  });

  it("keeps duplicate texts as separate lines (never de-duplicates)", () => {
    const out = renderPlainText(withBullets(["Same bullet.", "Same bullet."]));
    expect(out.match(/^- Same bullet\.$/gm)).toHaveLength(2);
  });
});

describe("optional and empty sections", () => {
  it("emits no EDUCATION heading when education is absent", () => {
    const { education: _omitted, ...rest } = FIXTURE;
    const out = renderPlainText(rest);
    expect(out).not.toContain("EDUCATION");
    expect(out.endsWith("- SQL, dbt, Looker\n")).toBe(true);
  });

  it("emits no EDUCATION heading when education is empty", () => {
    expect(renderPlainText({ ...FIXTURE, education: [] })).not.toContain("EDUCATION");
  });

  it("emits no heading for empty skills or bullets, or for whitespace-only items", () => {
    const out = renderPlainText({ ...FIXTURE, bullets: [], skills: [item("  \t ")] });
    expect(out).not.toContain("EXPERIENCE");
    expect(out).not.toContain("SKILLS");
    expect(out).toBe(
      "SUMMARY\nProduct leader with 12 years shipping consumer subscription apps — most recently at a streaming service.\n\nEDUCATION\n- B.A., Economics — Université de Montréal\n",
    );
  });

  it("emits no SUMMARY heading for an empty summary", () => {
    expect(renderPlainText({ ...FIXTURE, summary: item("") }).startsWith("EXPERIENCE\n")).toBe(true);
  });

  it("renders fully empty content as the empty string (boundary)", async () => {
    const empty: GeneratedAssetContent = { summary: item(""), bullets: [], skills: [], education: [] };
    expect(renderPlainText(empty)).toBe("");
    expect((await textRenderer.render(empty)).bytes).toHaveLength(0);
  });
});

describe("private-use sentinel", () => {
  const PUA_START = 0xe000;
  const PUA_END = 0xf8ff;
  const puaRange = (skip?: number): string => {
    const chars: string[] = [];
    for (let code = PUA_START; code <= PUA_END; code++) if (code !== skip) chars.push(String.fromCharCode(code));
    return chars.join("");
  };

  it("covers 6,400 characters", () => {
    expect(puaRange()).toHaveLength(6400);
  });

  it("refuses an item that uses every Private Use Area character, since no placeholder is free", async () => {
    const every = `Shipped ${puaRange()} **done**`;
    expect(() => plainTextOf(every)).toThrow(InvalidExportContent);
    await expect(textRenderer.render(withBullets([every]))).rejects.toBeInstanceOf(InvalidExportContent);
  });

  it("renders an item missing one private-use character, keeping all the others unchanged (boundary)", async () => {
    const missing = 0xf123;
    const pua = puaRange(missing);
    // The free character becomes the placeholder that holds code spans and escapes.
    expect(plainTextOf(`Shipped ${pua} **done** with \`dbt\` and \\*stars\\*`)).toBe(
      `Shipped ${pua} done with dbt and *stars*`,
    );
    const { bytes } = await textRenderer.render(withBullets([`**Led** ${pua}`]));
    const out = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    expect(out).toBe(`SUMMARY\nSummary.\n\nEXPERIENCE\n- Led ${pua}\n`);
    expect(out).not.toContain(String.fromCharCode(missing));
  });
});

describe("failure modes", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    "text",
    [],
    { bullets: [], skills: [] },
    { summary: item("S"), skills: [] },
    { summary: item("S"), bullets: [{ id: "b", text: 42, source_unit_ids: [] }], skills: [] },
    { summary: item("S"), bullets: [], skills: [], education: "none" },
  ];

  it.each(malformed)("renderPlainText(%j) throws InvalidExportContent", (bad) => {
    expect(() => renderPlainText(bad as GeneratedAssetContent)).toThrow(InvalidExportContent);
  });

  it("textRenderer.render rejects with InvalidExportContent", async () => {
    await expect(textRenderer.render(null as unknown as GeneratedAssetContent)).rejects.toBeInstanceOf(InvalidExportContent);
  });
});

describe("renderer contract", () => {
  it("declares the txt format, extension and UTF-8 content type", async () => {
    expect(textRenderer.format).toBe("txt");
    expect(textRenderer.extension).toBe("txt");
    expect(textRenderer.contentType).toBe("text/plain; charset=utf-8");
    expect(TEXT_CONTENT_TYPE).toBe(textRenderer.contentType);
    const rendered = await textRenderer.render(FIXTURE);
    expect(rendered.contentType).toBe(textRenderer.contentType);
    expect(rendered.extension).toBe("txt");
    expect(rendered.bytes).toBeInstanceOf(Uint8Array);
  });

  it("writes no byte-order mark", async () => {
    const { bytes } = await textRenderer.render(FIXTURE);
    expect(bytes[0]).toBe("S".charCodeAt(0));
    expect(bytes[0]).not.toBe(0xef);
  });

  it("lists formats in the final menu order, with txt and never json", () => {
    expect(EXPORT_FORMAT_ORDER).toEqual(["pdf", "docx", "txt"]);
  });
});

describe("isolation", () => {
  it("imports only the contract, the shared types and the attestation shape check", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "text.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../types/crm.js", "../validation/attestation.js", "./types.js"]);
    expect(source).not.toMatch(/firebase-admin|@google-cloud|\bfetch\(|node:(?:http|https|net|fs)|Date\.now|Math\.random/);
  });
});
