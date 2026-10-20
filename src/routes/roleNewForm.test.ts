import { describe, expect, it, vi } from "vitest";

import type { Role } from "../types/crm.ts";

import {
  EMPTY_ROLE_NEW_FORM,
  buildRoleFromForm,
  canSubmitRoleNew,
  isRoleNewFormDirty,
  restoreRoleNewForm,
  submitRoleNewForm,
  type RoleNewFormState,
} from "./roleNewForm.ts";

const IDS = { id: "role-1", companyId: "company-1" };
const NOW = new Date("2026-10-19T12:00:00.000Z");

function form(overrides: Partial<RoleNewFormState> = {}): RoleNewFormState {
  return { ...EMPTY_ROLE_NEW_FORM, ...overrides };
}

describe("canSubmitRoleNew", () => {
  it("accepts a title with no JD (#431)", () => {
    expect(canSubmitRoleNew(form({ title: "Staff PM" }))).toBe(true);
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(canSubmitRoleNew(form())).toBe(false);
    expect(canSubmitRoleNew(form({ title: "   " }))).toBe(false);
  });

  it("rejects a JD without a title", () => {
    expect(canSubmitRoleNew(form({ jdRaw: "We are hiring." }))).toBe(false);
  });
});

describe("isRoleNewFormDirty", () => {
  it("is false for the empty form and whitespace-only fields", () => {
    expect(isRoleNewFormDirty(form())).toBe(false);
    expect(isRoleNewFormDirty(form({ title: "  ", compRange: "\n" }))).toBe(
      false,
    );
  });

  it("is true once any field has text", () => {
    expect(isRoleNewFormDirty(form({ jdUrl: "https://x.test" }))).toBe(true);
    expect(isRoleNewFormDirty(form({ remotePolicy: "remote" }))).toBe(true);
  });
});

describe("buildRoleFromForm", () => {
  it("builds a title-only Role with an empty JD and no optional keys", () => {
    const role = buildRoleFromForm(form({ title: "  Staff PM " }), IDS, NOW);
    expect(role).toEqual({
      id: "role-1",
      company_id: "company-1",
      title: "Staff PM",
      jd_raw: "",
      discovered_at: "2026-10-19T12:00:00.000Z",
    });
    // Absent, not undefined: Firestore rejects undefined values.
    expect("jd_url" in role).toBe(false);
    expect("location" in role).toBe(false);
    expect("remote_policy" in role).toBe(false);
    expect("comp_range" in role).toBe(false);
  });

  it("stores a whitespace-only JD paste as no JD", () => {
    const role = buildRoleFromForm(
      form({ title: "PM", jdRaw: "  \n\t " }),
      IDS,
      NOW,
    );
    expect(role.jd_raw).toBe("");
  });

  it("keeps a real JD verbatim (no trim of the pasted body)", () => {
    const jd = "  About us\n\n- Ship things\n";
    const role = buildRoleFromForm(form({ title: "PM", jdRaw: jd }), IDS, NOW);
    expect(role.jd_raw).toBe(jd);
  });

  it("includes trimmed optional fields when present", () => {
    const role = buildRoleFromForm(
      form({
        title: "PM",
        jdUrl: " https://jobs.test/1 ",
        location: " Remote, US ",
        remotePolicy: "hybrid",
        compRange: " $200k ",
      }),
      IDS,
      NOW,
    );
    expect(role).toMatchObject({
      jd_url: "https://jobs.test/1",
      location: "Remote, US",
      remote_policy: "hybrid",
      comp_range: "$200k",
    });
  });
});

describe("restoreRoleNewForm", () => {
  it("restores a stored draft field for field", () => {
    const stored = {
      title: "Staff PM",
      jdRaw: "",
      jdUrl: "https://jobs.test/1",
      location: "NYC",
      remotePolicy: "remote",
      compRange: "$250k",
    };
    expect(restoreRoleNewForm(stored)).toEqual(stored);
  });

  it("returns the empty form for nothing stored or a non-object", () => {
    expect(restoreRoleNewForm(undefined)).toEqual(EMPTY_ROLE_NEW_FORM);
    expect(restoreRoleNewForm(null)).toEqual(EMPTY_ROLE_NEW_FORM);
    expect(restoreRoleNewForm("Staff PM")).toEqual(EMPTY_ROLE_NEW_FORM);
    expect(restoreRoleNewForm(["Staff PM"])).toEqual(EMPTY_ROLE_NEW_FORM);
  });

  it("blanks wrong-typed fields and an unknown remote policy", () => {
    expect(
      restoreRoleNewForm({
        title: 42,
        jdRaw: { nested: true },
        location: "Berlin",
        remotePolicy: "on-the-moon",
      }),
    ).toEqual(form({ location: "Berlin" }));
  });
});

describe("submitRoleNewForm", () => {
  function deps(upsertRole = vi.fn((_: Omit<Role, "owner_uid">) => Promise.resolve())) {
    const ids = ["role-new-1", "company-new-1"];
    return {
      upsertRole,
      newId: vi.fn(() => ids.shift() ?? "extra-id"),
      now: () => NOW,
    };
  }

  it("writes a title-only Role with an empty JD and returns its id (#431)", async () => {
    const d = deps();
    const id = await submitRoleNewForm(form({ title: " Staff PM " }), d);
    expect(id).toBe("role-new-1");
    expect(d.upsertRole).toHaveBeenCalledTimes(1);
    expect(d.upsertRole).toHaveBeenCalledWith({
      id: "role-new-1",
      company_id: "company-new-1",
      title: "Staff PM",
      jd_raw: "",
      discovered_at: "2026-10-19T12:00:00.000Z",
    });
  });

  it("writes the pasted JD when there is one", async () => {
    const d = deps();
    await submitRoleNewForm(form({ title: "PM", jdRaw: "About us" }), d);
    expect(d.upsertRole.mock.calls[0]?.[0].jd_raw).toBe("About us");
  });

  it("throws without writing when the title is missing", async () => {
    const d = deps();
    await expect(
      submitRoleNewForm(form({ jdRaw: "About us" }), d),
    ).rejects.toThrow("Title is required.");
    expect(d.upsertRole).not.toHaveBeenCalled();
    expect(d.newId).not.toHaveBeenCalled();
  });

  it("rejects with the service error when the write fails", async () => {
    const d = deps(vi.fn(() => Promise.reject(new Error("permission-denied"))));
    await expect(
      submitRoleNewForm(form({ title: "PM" }), d),
    ).rejects.toThrow("permission-denied");
  });
});

