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

  // The guard after a marker must look at the first non-whitespace character, however much
  // whitespace sits between: with a backtracking `[ \t]+` the guard ran against the second space,
  // and `-  30% cost` lost its minus while `- 30% cost` kept it (external review, P1).
  it.each([
    ["-  30% cost", "- 30% cost"],
    ["-\t30% cost", "- 30% cost"],
    ["- \t30% cost", "- 30% cost"],
    ["-\t \t30% cost", "- 30% cost"],
    ["+  12% NRR", "+ 12% NRR"],
    ["+\t12% NRR", "+ 12% NRR"],
    ["*  5x throughput", "* 5x throughput"],
    ["- \t$2M saved", "- $2M saved"],
    ["-  .5 FTE", "- .5 FTE"],
    ["#  1 ranked team", "# 1 ranked team"],
    ["#\t1 ranked team", "# 1 ranked team"],
    ["## \t1 ranked team", "## 1 ranked team"],
    // NBSP and the other Unicode spaces are trimmed at the end too, so they cannot hide a sign either.
    ["- \u00a030% cost", "- \u00a030% cost"],
    ["- \f30% cost", "- 30% cost"],
  ])("keeps a marker followed by more than one whitespace character and a number or sign: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    ["-  Led the team", "Led the team"],
    ["-\tLed the team", "Led the team"],
    ["- \tLed the team", "Led the team"],
    ["-\t \tLed the team", "Led the team"],
    ["+  Grew revenue", "Grew revenue"],
    ["*\tShipped search", "Shipped search"],
    ["#  Platform work", "Platform work"],
    ["#\tPlatform work", "Platform work"],
    ["## \tPlatform work", "Platform work"],
    ["- \u00a0Led the team", "Led the team"],
  ])("still strips a marker followed by any whitespace run and a letter: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  // The guard decides on the first *visible* character. Block markers are stripped before inline
  // formatting is reduced, so a guard that read the raw next character met `*`, `_`, a backtick or a
  // held-escape placeholder instead of the number, and `- **30%** cost` lost its minus (external review, P2).
  it.each([
    ["- **30%** cost", "- 30% cost"],
    ["+ **12%** NRR", "+ 12% NRR"],
    ["- *30%* cost", "- 30% cost"],
    ["- __30%__ cost", "- 30% cost"],
    ["- `30%` cost", "- 30% cost"],
    ["# **1** ranked", "# 1 ranked"],
    ["* **$2M** saved", "* $2M saved"],
    ["- **−30%** cost", "- −30% cost"],
    ["- ***30%*** cost", "- 30% cost"],
    ["-  **30%** cost", "- 30% cost"],
    ["- ~~30%~~ cost", "- ~~30%~~ cost"],
    ["- [30% savings](https://example.com/c) on cloud", "- 30% savings (https://example.com/c) on cloud"],
    ["- [**30%** savings](https://example.com/c)", "- 30% savings (https://example.com/c)"],
    ["- ![30%](https://example.com/chart.png) cost", "- 30% cost"],
  ])("keeps a marker whose first visible character, through inline formatting, is a number or sign: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // A held placeholder stands for a literal the author escaped: that is content, so the marker stays.
    ["- \\-30% cost", "- -30% cost"],
    ["+ \\+12% NRR", "+ +12% NRR"],
    ["- **\\-30%** cost", "- -30% cost"],
    ["# \\#1 ranked app", "# #1 ranked app"],
    ["- \\*starred\\* note", "- *starred* note"],
    // A backslash before a digit escapes nothing, so it is kept as typed and is the visible content.
    ["- \\30% cost", "- \\30% cost"],
  ])("keeps a marker whose first visible character is an escaped literal: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    ["- **Led** the team", "Led the team"],
    ["* _Owned_ the roadmap", "Owned the roadmap"],
    ["# **Summary**", "Summary"],
    ["## __Platform work__", "Platform work"],
    ["+ `dbt` models", "dbt models"],
    ["- ~~Draft~~ Final", "~~Draft~~ Final"],
    ["- [Case study](https://example.com/c)", "Case study (https://example.com/c)"],
  ])("still strips a marker whose first visible character, through inline formatting, is a letter: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it("keeps the sign through the full render when inline formatting or an escape follows the marker", () => {
    const bullets = ["- **30%** cost", "+ **12%** NRR", "- \\-30% cost", "* **$2M** saved", "- **Led** the team"];
    expect(renderPlainText(withBullets(bullets))).toBe(
      "SUMMARY\nSummary.\n\nEXPERIENCE\n- - 30% cost\n- + 12% NRR\n- - -30% cost\n- * $2M saved\n- Led the team\n",
    );
    const content: GeneratedAssetContent = {
      summary: item("# **1** ranked team"),
      bullets: [item("- `30%` cost")],
      skills: [item("* _Owned_ the roadmap")],
    };
    expect(renderPlainText(content)).toBe("SUMMARY\n# 1 ranked team\n\nEXPERIENCE\n- - 30% cost\n\nSKILLS\n- Owned the roadmap\n");
  });

  it("keeps the sign through the full render when the marker has two spaces", () => {
    const out = renderPlainText(withBullets(["-  30% cost", "- \t$2M saved"]));
    expect(out).toContain("\n- - 30% cost\n");
    expect(out).toContain("\n- - $2M saved\n");
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

// Code spans are held before escapes outside them are reduced: a backslash inside a code span is
// literal, as in CommonMark. Reducing escapes first turned `\d+\.\d+` into `\d+.\d+` (a literal
// decimal separator became a wildcard) and `C:\*` into `C:*` (external review, P2, zero fabrication).
describe("code spans export as typed", () => {
  it.each([
    ["Parsed versions with `\\d+\\.\\d+`", "Parsed versions with \\d+\\.\\d+"],
    ["Globbed `C:\\*` on build hosts", "Globbed C:\\* on build hosts"],
    ["Profiles in `C:\\Users\\me`", "Profiles in C:\\Users\\me"],
    ["Root is `C:\\`", "Root is C:\\"],
    ["Matched `\\*` and `\\_` literally", "Matched \\* and \\_ literally"],
    ["`a\\*b\\_c\\#d\\>e\\~f`", "a\\*b\\_c\\#d\\>e\\~f"],
    ["Wrote `[docs](https://example.com/a_b) **not bold**`", "Wrote [docs](https://example.com/a_b) **not bold**"],
    ["Used `**kwargs` and `*args` and `__init__`", "Used **kwargs and *args and __init__"],
    ["Kept `~~12%~~`, `# 1` and `> 5`", "Kept ~~12%~~, # 1 and > 5"],
    ["See `<https://example.com/_x_>`", "See <https://example.com/_x_>"],
  ])("keeps the text of a code span exactly as typed: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // A double-backtick span holds a single backtick, and its backslashes too.
    ["Quoted ``a ` b\\*`` here", "Quoted a ` b\\* here"],
    ["Ran `` `pwd` `` nightly", "Ran `pwd` nightly"],
    // A backtick run with no closer of the same length is literal text.
    ["a ``b` c", "a ``b` c"],
  ])("closes a code span only on a backtick run of the same length: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // Outside code spans escapes still reduce, and an escaped backtick opens no span.
    ["Escaped \\`not code\\` here", "Escaped `not code` here"],
    ["\\`raw\\` and `co\\de`", "`raw` and co\\de"],
    ["Escaped \\*stars\\* and `\\*code\\*`", "Escaped *stars* and \\*code\\*"],
    ["\\\\`code`", "\\code"],
    ["- `dbt` and \\*stars\\*", "dbt and *stars*"],
  ])("still reduces escapes outside code spans: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // A code span at the start is read by the first non-whitespace character of its text.
    ["- `-30%` cost", "- -30% cost"],
    ["+ `+12%` NRR", "+ +12% NRR"],
    ["- `$2M` saved", "- $2M saved"],
    ["* `−5%` churn", "* −5% churn"],
    ["# ` 1` ranked", "# 1 ranked"],
    ["- ` ` 30% cost", "- 30% cost"],
  ])("keeps a marker before a code span that starts with a number or sign: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // Code-span text is never an escape: a leading backslash in it is just its first character.
    ["- `\\d+` parsing", "\\d+ parsing"],
    ["- `C:\\Users` profiles", "C:\\Users profiles"],
    ["- `*` wildcard", "* wildcard"],
  ])("still strips a marker before a code span that starts with another character: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it("renders the exact expected text through the full render", () => {
    const content: GeneratedAssetContent = {
      summary: item("Parsed `\\d+\\.\\d+` versions and \\*starred\\* notes."),
      bullets: [item("- `-30%` cost on `C:\\Users\\me` builds"), item("Escaped \\`tick\\` beside ``a ` b\\*``"), item("+ `dbt` models")],
      skills: [item("`C:\\*`"), item("`**kwargs`, `[docs](https://example.com/a_b)`")],
    };
    expect(renderPlainText(content)).toBe(
      [
        "SUMMARY",
        "Parsed \\d+\\.\\d+ versions and *starred* notes.",
        "",
        "EXPERIENCE",
        "- - -30% cost on C:\\Users\\me builds",
        "- Escaped `tick` beside a ` b\\*",
        "- dbt models",
        "",
        "SKILLS",
        "- C:\\*",
        "- **kwargs, [docs](https://example.com/a_b)",
        "",
      ].join("\n"),
    );
  });
});

// `**x**` is reduced only at non-word boundaries, mirroring the `__` rule: the opening `**` must not
// follow, and the closing `**` must not precede, a letter, digit or `_`. Reducing every `**…**` pair
// turned the exponent operators in `Processed 10**6 to 10**9 records` into `Processed 106 to 109
// records` (external review, P2, zero fabrication).
describe("strong emphasis only at non-word boundaries", () => {
  it.each([
    ["Processed 10**6 to 10**9 records", "Processed 10**6 to 10**9 records"],
    ["2**10 = 1024", "2**10 = 1024"],
    ["x**2 + y**2", "x**2 + y**2"],
    ["a**b**c", "a**b**c"],
    // A closing `**` followed by a word character is not a closer, so the bold reaches past the operator.
    ["**Throughput 10**6 rps**", "Throughput 10**6 rps"],
  ])("keeps a `**` inside a word or number as typed: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    ["**bold** text", "bold text"],
    ["a **bold** b", "a bold b"],
    ["(**bold**)", "(bold)"],
    ["**bold**.", "bold."],
    ["**bold**, then", "bold, then"],
    ["***both***", "both"],
    ["**Scale:** 10**6 to 10**9 records", "Scale: 10**6 to 10**9 records"],
  ])("still reduces `**x**` at non-word boundaries: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // The marker guard still sees the sign through the `**`.
    ["- **30%** cost", "- 30% cost"],
    // `_` is a word character, so the `**` right after the dunder is not an opener and both are kept;
    // after a space the same `**x**` is reduced and the dunder is still kept.
    ["__init__**x**", "__init__**x**"],
    ["__init__ **x**", "__init__ x"],
    // A code span holds its `**` before emphasis is reduced.
    ["Ran `x**2` and **bold**", "Ran x**2 and bold"],
    ["`10**6 **rows**`", "10**6 **rows**"],
  ])("keeps the marker guard, the dunder rule and code spans: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it("renders the exact expected text through the full render", () => {
    const content: GeneratedAssetContent = {
      summary: item("**Platform** lead; sized queues at 2**10 = 1024."),
      bullets: [item("Processed 10**6 to 10**9 records"), item("Fit x**2 + y**2 with `a**b`"), item("- **30%** cost"), item("(**bold**), a**b**c")],
      skills: [item("__init__**x**")],
    };
    expect(renderPlainText(content)).toBe(
      [
        "SUMMARY",
        "Platform lead; sized queues at 2**10 = 1024.",
        "",
        "EXPERIENCE",
        "- Processed 10**6 to 10**9 records",
        "- Fit x**2 + y**2 with a**b",
        "- - 30% cost",
        "- (bold), a**b**c",
        "",
        "SKILLS",
        "- __init__**x**",
        "",
      ].join("\n"),
    );
  });
});

// An emphasis delimiter pairs only at a word-like boundary. Pairing any two `*` that touched no
// letter or digit read operators, globs, paths and footnote marks as emphasis: `Grew 30%*, cut churn
// 12%*` exported as `Grew 30%, cut churn 12%`, `COUNT(*) and SUM(*)` as `COUNT() and SUM()` and
// `src/**/*.ts` as `src//.ts` (adversarial sweep R1, R2, zero fabrication).
describe("emphasis delimiters pair only at word-like boundaries", () => {
  it.each([
    "Grew 30%*, cut churn 12%*",
    "Revenue $2M (*) and churn 3% (*)",
    "Computed (3)*(4)*(5)",
    "Rewrote COUNT(*) and SUM(*) queries",
    "SELECT *, id FROM t WHERE COUNT(*) > 5",
    "Supports v2.*, v3.* releases",
    "Pinned v2.*/v3.* ranges",
    "Range 1.*–2.*",
    "Migrated src/*.ts and test/*.ts to ESM",
    "*.ts,*.js",
    "Matched /.*/ and /.*/g",
    "Cleaned /tmp/*/cache/* nightly",
    "Archived logs/*/2024/*.gz",
    "*/15,*/30",
    "Ran cron */15 and */30 jobs",
    "Called f(*a) and g(*)",
    "Called f(*1)* and (f(*1))*",
    "char* p and (int*)q",
    "*p/*q",
    "rm -rf *",
    "Rated 5* and 4*",
  ])("keeps a single `*` glued to punctuation as typed: %j", (input) => {
    expect(plainTextOf(input)).toBe(input);
  });

  it.each([
    "Excluded **/node_modules/** from builds",
    "Linted src/**/*.ts and lib/**/*.js",
    "f(**a, **b)",
    "(10)**6 and (10)**9",
    "e**-x and e**-y",
    "2**-3",
    "**2**10",
    "10**6**",
  ])("keeps a `**` glued to punctuation, or between operands, as typed: %j", (input) => {
    expect(plainTextOf(input)).toBe(input);
  });

  it.each([
    // A `*` or `**` between a digit and a signed digit is an operator, so bold around it keeps it whole,
    // and a single-`*` span cannot hold another `*`, so italics around `2*-3` keep every star.
    ["**2**-3** error", "2**-3 error"],
    ["*2*-3* scale", "*2*-3* scale"],
    // Emphasis never crosses a bracket: the `*` inside the parentheses pairs with nothing outside them.
    ["*f(*1)* calls", "*f(*1)* calls"],
    ["**COUNT(*)** rows", "COUNT(*) rows"],
  ])("keeps operators and brackets whole inside emphasis: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    ["Cut (*see*) cost", "Cut (see) cost"],
    ["“**fast**” wins", "“fast” wins"],
    ["**30%**, then", "30%, then"],
    ["Cut **30%**/yr", "Cut 30%/yr"],
    ["Cut *-12* cost", "Cut -12 cost"],
    ["**−5%** churn", "−5% churn"],
    ["**30%**-**40%**", "30%-40%"],
    ["-*30%*", "-30%"],
    ["*see (appendix)* now", "see (appendix) now"],
    ["🚀*fast*", "🚀fast"],
    ["**Scale:** 10**6 rows", "Scale: 10**6 rows"],
    ["**see** https://ex.com/*", "see https://ex.com/*"],
    ["*a\\*b*", "a*b"],
  ])("still reduces `*` and `**` emphasis at word-like boundaries: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  // The intended trade-off: the guard keeps the delimiters of some emphasis Markdown would format.
  // Keeping characters is the safe side of the zero-fabrication invariant; dropping them is not.
  it.each(["**.NET** stack", "_42_/x", "*+15%*… growth", "**1)** Led"])("keeps the delimiters of emphasis the guard cannot tell from an operator: %j", (input) => {
    expect(plainTextOf(input)).toBe(input);
  });
});

// A bare URL stopped at `*` and `(`, so the tail of the URL was exposed to emphasis reduction:
// `https://ex.com/search?q=*foo*` exported as `…q=foo` and `https://ex.com/(_draft_)` as `…/(draft)`,
// in link labels too (adversarial sweep R3).
describe("URLs are held whole", () => {
  it.each([
    "See https://ex.com/search?q=*foo* now",
    "See https://ex.com/*/b/* now",
    "See https://ex.com/a*b*c now",
    "See https://ex.com/(_draft_) now",
    "See https://en.wikipedia.org/wiki/C_(programming_language) now",
    "See (https://ex.com/_x_) now",
    "See (https://ex.com/a_(b)) now",
    "Fetched ftp://ex.com/*x* and ftp://ex.com/_pub_/x",
    "Opened file:///C:/_tmp_/x",
    "Synced s3://bucket/*/raw/* daily",
  ])("keeps every character of a bare URL with a scheme: %j", (input) => {
    expect(plainTextOf(input)).toBe(input);
  });

  it.each([
    ["[see https://ex.com/*/b/*](https://ex.com/x)", "see https://ex.com/*/b/* (https://ex.com/x)"],
    ["[see https://ex.com/(_d_) here](https://ex.com/y)", "see https://ex.com/(_d_) here (https://ex.com/y)"],
    ["[https://ex.com/q=*x*](https://ex.com/q=*x*)", "https://ex.com/q=*x*"],
    ["[https://ex.com/(_d_)](https://ex.com/(_d_))", "https://ex.com/(_d_)"],
    ["[wiki](https://en.wikipedia.org/wiki/C_(programming_language))", "wiki (https://en.wikipedia.org/wiki/C_(programming_language))"],
  ])("keeps a URL whole in a link label and destination: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each([
    // A bare URL never ends with `*` or trailing punctuation, so emphasis around it still reduces.
    ["*see https://ex.com/a*", "see https://ex.com/a"],
    ["**see https://ex.com/a_b**, then", "see https://ex.com/a_b, then"],
    ["Read https://ex.com/x.", "Read https://ex.com/x."],
  ])("ends a bare URL before `*` and trailing punctuation: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });
});

// The single-`_` rule paired underscores with punctuation outside them, so `Read $_1_ and $_2_`
// exported as `Read $1 and $2` and `_jdoe_@ex.com` as `jdoe@ex.com` (adversarial sweep R4).
describe("`_` emphasis needs a boundary outside both delimiters", () => {
  it.each([
    "Read $_1_ and $_2_",
    "Routed /_internal_/api",
    "Used _.map/_.filter",
    "Mail _jdoe_@ex.com",
    "_$_POST_",
    "$_POST/$_GET",
    "See github.com/acme/_private_ repo",
    "See www.ex.com/_x_/y",
    "_1_000_ rows",
    "1_000_* rows",
    "__init__/__main__",
  ])("keeps underscores that touch punctuation outside them as typed: %j", (input) => {
    expect(plainTextOf(input)).toBe(input);
  });

  it.each([
    ["_emphasis_ here", "emphasis here"],
    ["(_aside_)", "(aside)"],
    ["“_quoted_”", "“quoted”"],
    ["_done_.", "done."],
    ["a -_x_- b", "a -x- b"],
    ["Led _30%_ growth", "Led 30% growth"],
    ["_x_ and __y__ and *z*", "x and __y__ and z"],
  ])("still reduces `_x_` at a boundary: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });
});

// A combining mark counted as a non-word character, so a decomposed `é` opened emphasis that the
// precomposed form did not: `cafe\u0301*2*` exported as `café2` (adversarial sweep R5).
describe("combining marks belong to the word", () => {
  it.each([
    ["cafe\u0301*2*", "caf\u00e9*2*"],
    ["cafe\u0301**2**", "caf\u00e9**2**"],
    ["__cafe\u0301__", "__caf\u00e9__"],
    ["nai\u0308ve*x*", "na\u00efve*x*"],
  ])("keeps a delimiter after a combining mark, as after the precomposed letter: %j", (decomposed, precomposed) => {
    expect(plainTextOf(decomposed)).toBe(decomposed);
    expect(plainTextOf(precomposed)).toBe(precomposed);
  });

  it("still reduces emphasis after a space, keeping the decomposed letter unnormalized", () => {
    expect(plainTextOf("cafe\u0301 *x*")).toBe("cafe\u0301 x");
  });
});

// The marker guard skipped a raw `~` as an inline opener but read a code span by its first
// character, so `- ~30% faster` kept its marker while `` - `~30%` faster `` lost it.
describe("the marker guard reads raw text and code-span text alike", () => {
  it.each([
    ["- ~30% faster", "- ~30% faster"],
    ["- `~30%` faster", "- ~30% faster"],
    ["- `` ~30% `` faster", "- ~30% faster"],
    ["# `~1` ranked", "# ~1 ranked"],
    ["+ `*2` multiplier", "+ *2 multiplier"],
  ])("keeps the marker when a number or sign follows the delimiters: %j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });

  it.each(["~30%", "~~12%~~", "*2", "_30_", "**30%**", "~/bin", "~~Draft~~", "*args", "dbt"])(
    "decides the same for %j typed raw and inside a code span",
    (text) => {
      const raw = plainTextOf(`- ${text} cost`);
      const code = plainTextOf(`- \`${text}\` cost`);
      expect(code.startsWith("- ")).toBe(raw.startsWith("- "));
    },
  );
});

// Behaviours the sweep found undocumented; the header and the spec Renderers bullet now state them.
describe("documented reductions of links, images and block markers", () => {
  it.each([
    // An image keeps only its alt text: its URL is dropped, and an empty-alt image disappears.
    ["![chart 30%](https://ex.com/q3.png)", "chart 30%"],
    ["![](https://ex.com/growth.png) growth", "growth"],
    // A link title is dropped.
    ['[docs](https://ex.com/d "30% faster")', "docs (https://ex.com/d)"],
    ["[docs](https://ex.com/d '30% faster')", "docs (https://ex.com/d)"],
    // As in CommonMark, `![` always opens an image and `[x](y)` is a link wherever it stands.
    ["Wow![chart](https://ex.com/c.png)", "Wowchart"],
    ["arr[0](1)", "arr0 (1)"],
    // A link label holds no `[`, and a destination's parentheses must balance.
    ["[a [b](https://c.com)", "[a b (https://c.com)"],
    ["[a](b(c) x", "[a](b(c) x"],
    // A heading marker before a bullet marker keeps both: the guard reads the `-` as a sign.
    ["## - Led team", "## - Led team"],
  ])("%j → %j", (input, expected) => {
    expect(plainTextOf(input)).toBe(expected);
  });
});

// Every pattern runs in time linear in the item's length. The old trim, the `[^\]]` label class,
// the link destination and autolink classes and the unbounded `.+?` emphasis span each rescanned the
// rest of the text from every start position, and these inputs took 0.8 to 3 seconds at the base size.
// The check is relative so it holds on slow CI runners: the input grows 4×, so a linear renderer takes
// about 4× as long and a quadratic one about 16×. A loose absolute cap is the backstop.
describe("linear time on pathological input", () => {
  const SCALE = 4;
  const MAX_RATIO = 8;
  const FLOOR_MS = 5;
  const CAP_MS = 5000;
  const timeOf = (text: string): number => {
    plainTextOf(text); // warm up the JIT once so the first measurement is not an outlier
    const start = performance.now();
    plainTextOf(text);
    return performance.now() - start;
  };
  it.each([
    ["a run of NBSP", (n: number) => `a${"\u00a0".repeat(n)}b`, 10000],
    ["`[`", (n: number) => "[".repeat(n), 10000],
    ["`![`", (n: number) => "![".repeat(n), 5000],
    ["unclosed `**a `", (n: number) => "**a ".repeat(n), 7500],
    ["unclosed `__a `", (n: number) => "__a ".repeat(n), 7500],
    ["unclosed `***a `", (n: number) => "***a ".repeat(n), 4000],
    ["unclosed `[a](`", (n: number) => "[a](".repeat(n), 2500],
    ["unclosed `![a](`", (n: number) => "![a](".repeat(n), 2500],
    ["unclosed `<https://`", (n: number) => "<https://".repeat(n), 2500],
  ])("renders %s in time that grows linearly, as typed", (_name, build, base) => {
    const small = build(base);
    const large = build(base * SCALE);
    const tSmall = Math.max(timeOf(small), FLOOR_MS);
    const tLarge = timeOf(large);
    expect(tLarge).toBeLessThan(Math.max(tSmall * MAX_RATIO, FLOOR_MS * MAX_RATIO));
    expect(tLarge).toBeLessThan(CAP_MS);
    expect(plainTextOf(large)).toBe(large.trim());
  });

  it("renders a long emphasis span up to the bound and keeps the delimiters of a longer one", () => {
    const within = "word ".repeat(99).trim();
    const beyond = "word ".repeat(101).trim();
    expect(plainTextOf(`**${within}**`)).toBe(within);
    expect(plainTextOf(`**${beyond}**`)).toBe(`**${beyond}**`);
  });
});

/**
 * The claim characters of `text`, in order: every character that is not a letter, a combining mark
 * or whitespace, in each whitespace-delimited run that holds a digit. In `Cut (30%)*, then -$2M.`
 * they are `(30%)*,` and `-$2.`.
 */
const claimCharacters = (text: string): string[] =>
  text
    .split(/\s+/u)
    .filter((run) => /\p{N}/u.test(run))
    .flatMap((run) => [...run].filter((char) => !/[\p{L}\p{M}]/u.test(char)));

/** True when every character of `needle` appears in `haystack` in order, gaps allowed. */
const appearsInOrder = (needle: readonly string[], haystack: string): boolean => {
  let found = 0;
  for (const char of haystack) if (found < needle.length && char === needle[found]) found += 1;
  return found === needle.length;
};

// The sweep's grid as a deterministic property: for each claim-bearing token, each way of wrapping
// it and each place in a sentence, the digits and the signs and operators beside them that the
// author typed all reach the output, in order. The expected characters come from the sentence with
// the bare token, so markup the wrapper adds may be dropped and nothing the token carries may be.
describe("claim characters survive every wrapper and position (property grid)", () => {
  const TOKENS = [
    "42", "3.5", "-12", "−12", "+15%", "3-5", "10–12", "30%", "$2M", "€5k", "£3.2M", "2,000", "1,234.56", "-0.5", "½",
    "10**6", "2*3", "5*3*2", "2**10", "x**2", "2**-3", "2*-3", "1+1", "x×2", "<5ms", ">40%", "<=10", "~30%", "2^10",
    "1e-9", "10^-6", "±5%", "≥3", "v2.*", "1.*", "3%*", "(30%)", "[1]", "24/7", "Q3'24", "9-to-5", "$1.2B", "-$3M",
    "+/-2", "1st", "50k+", "~2x", "x_1", "$_1", "2_000", "O(n*2)", "f(*1)", "C++17", "#1", "*/15",
  ];
  const escape = (token: string): string => token.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, (char) => `\\${char}`);
  const WRAPPERS: ReadonlyArray<(token: string) => string> = [
    (t) => t,
    (t) => `**${t}**`,
    (t) => `*${t}*`,
    (t) => `_${t}_`,
    (t) => `__${t}__`,
    (t) => `***${t}***`,
    (t) => `~~${t}~~`,
    (t) => `\`${t}\``,
    (t) => `\`\` ${t} \`\``,
    (t) => `[${t}](https://example.com/p_1)`,
    (t) => `![${t}](https://example.com/i.png)`,
    escape,
  ];
  const POSITIONS: ReadonlyArray<(wrapped: string) => string> = [
    (w) => `${w} cut cost`,
    (w) => `Cut ${w} cost`,
    (w) => `Cut cost ${w}`,
    (w) => `Cut (${w}) cost`,
    (w) => `Cut ${w}, then ${w}.`,
    (w) => `Cut ${w} and ${w} cost`,
    (w) => `  \t${w}  `,
    (w) => `Led\n${w} cost`,
    (w) => `Led\r\n${w}\r\ncost`,
    (w) => `Led\u2028${w}`,
    (w) => `Led\u00a0${w}\u00a0cost`,
    (w) => `Cut “${w}” x`,
    (w) => `Cut ${w}: x`,
    (w) => `Cut ${w}—x`,
    (w) => `Cut ${w}/x`,
    (w) => `x/${w} y`,
    (w) => `Cut ${w}*, then ${w}*`,
    (w) => `(${w})*(${w})*`,
    (w) => `Cut ${w} (*) and ${w} (*)`,
    (w) => `- ${w} x`,
    (w) => `# ${w} x`,
    (w) => `> ${w} x`,
  ];

  it(`holds for ${TOKENS.length * WRAPPERS.length * POSITIONS.length} inputs`, () => {
    const failures: string[] = [];
    for (const token of TOKENS) {
      for (const wrap of WRAPPERS) {
        for (const place of POSITIONS) {
          const input = place(wrap(token));
          const output = plainTextOf(input);
          if (!appearsInOrder(claimCharacters(place(token)), output)) failures.push(`${JSON.stringify(input)} → ${JSON.stringify(output)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // Operators, globs, paths and URLs typed bare carry no emphasis at all, so each exports exactly as
  // typed (only the line breaks and whitespace are laid out) wherever it stands. A token that a
  // trailing footnote `*` would turn into Markdown emphasis (`*args` + `*` is `*args*`) is left out.
  const OPERATOR_TOKENS = [
    "COUNT(*)", "SELECT *,", "src/*.ts", "*.ts,*.js", "v2.*", "1.*–2.*", "30%*", "(*)", "(3)*(4)*(5)", "f(*a)", "g(*)",
    "**/node_modules/**", "src/**/*.ts", "/.*/g", "/tmp/*/cache/*", "*/15,*/30", "$_1_", "/_internal_/api", "_.map/_.filter",
    "_jdoe_@ex.com", "_$_POST_", "$_POST/$_GET", "ftp://ex.com/_pub_/x", "file:///C:/_tmp_/x", "github.com/acme/_private_",
    "https://ex.com/search?q=*foo*", "https://ex.com/*/b/*", "https://ex.com/(_draft_)", "https://ex.com/a*b*c",
    "s3://bucket/*/raw/*", "__init__/__main__", "10**6", "2**-3", "5*3*2", "x**2", "a*b", "x_1", "snake_case_name",
    "cafe\u0301*2*", "f(*1)*", "2*-3", "e**-x", "(10)**6", "**kwargs", "O(n*m)", "~/cache/*", "2_000_000", "1_000_*",
  ];
  const layout = (text: string): string =>
    text
      .split(/\r\n|[\r\n\u0085\u2028\u2029]/)
      .join(" ")
      .replace(/[ \t\f\v]+/g, " ")
      .trim();

  it(`exports ${OPERATOR_TOKENS.length * (POSITIONS.length - 3)} operator, glob, path and URL inputs as typed`, () => {
    const failures: string[] = [];
    // The three block-marker positions are left out: a marker before a letter is stripped by design.
    for (const token of OPERATOR_TOKENS) {
      for (const place of POSITIONS.slice(0, -3)) {
        const input = place(token);
        const output = plainTextOf(input);
        if (output !== layout(input)) failures.push(`${JSON.stringify(input)} → ${JSON.stringify(output)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("word-like emphasis boundaries through the full render", () => {
  it("renders the exact expected text", () => {
    const content: GeneratedAssetContent = {
      summary: item("**Platform** lead; grew revenue 30%* and cut churn 12%*."),
      bullets: [
        item("Rewrote COUNT(*) and SUM(*) queries over src/**/*.ts"),
        item("- ~30% faster and `~2x` cheaper"),
        item("- `~30%` faster"),
        item("Read $_1_ from _jdoe_@ex.com via https://ex.com/search?q=*foo*"),
        item("See [the draft](https://ex.com/(_draft_)) and ![chart](https://ex.com/c.png)"),
      ],
      skills: [item("_Python_, `**kwargs`, cafe\u0301*2*")],
    };
    expect(renderPlainText(content)).toBe(
      [
        "SUMMARY",
        "Platform lead; grew revenue 30%* and cut churn 12%*.",
        "",
        "EXPERIENCE",
        "- Rewrote COUNT(*) and SUM(*) queries over src/**/*.ts",
        "- - ~30% faster and ~2x cheaper",
        "- - ~30% faster",
        "- Read $_1_ from _jdoe_@ex.com via https://ex.com/search?q=*foo*",
        "- See the draft (https://ex.com/(_draft_)) and chart",
        "",
        "SKILLS",
        "- Python, **kwargs, cafe\u0301*2*",
        "",
      ].join("\n"),
    );
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
