import { describe, expect, it } from "vitest";

import { JdParsingResponseV1Schema } from "../prompts/parsing/jd.v1.schema.ts";
import { JdParsingResponseV2Schema } from "../prompts/parsing/jd.v2.schema.ts";

import { JD_PARSING_SCHEMA_VERSIONS, jdParsingResponseSchemaFor } from "./jdResponseSchema.ts";

describe("jdParsingResponseSchemaFor (#656)", () => {
  it("returns each registered version's own schema", () => {
    expect(jdParsingResponseSchemaFor("v1")).toBe(JdParsingResponseV1Schema);
    expect(jdParsingResponseSchemaFor("v2")).toBe(JdParsingResponseV2Schema);
  });

  it("lists exactly the registered versions, frozen", () => {
    expect(JD_PARSING_SCHEMA_VERSIONS).toEqual(["v1", "v2"]);
    expect(Object.isFrozen(JD_PARSING_SCHEMA_VERSIONS)).toBe(true);
  });

  it.each(["v3", "", "V1", "v1 ", "__proto__", "toString", "constructor"])(
    "throws for unregistered version %j",
    (version) => {
      expect(() => jdParsingResponseSchemaFor(version)).toThrow(/No JD parsing schema registered for version/);
    },
  );

  it("names the registered versions in the error", () => {
    expect(() => jdParsingResponseSchemaFor("v9")).toThrow(/Registered: v1, v2/);
  });
});
