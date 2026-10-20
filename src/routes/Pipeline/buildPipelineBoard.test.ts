import { describe, expect, it } from "vitest";

import type {
  Application,
  ApplicationStage,
  Company,
  Interaction,
  Person,
  Role,
} from "../../types/crm.ts";

import {
  PIPELINE_STAGES,
  buildPipelineBoard,
  daysInStage,
  latestInteractionByApplication,
  type PipelineBoardInputs,
  type PipelineCard,
} from "./buildPipelineBoard.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");

function app(
  id: string,
  stage: ApplicationStage,
  overrides: Partial<Application> = {},
): Application {
  return {
    id,
    owner_uid: "u",
    role_id: `role-${id}`,
    stage,
    last_activity_at: "2026-10-19T09:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: [],
    ...overrides,
  };
}

function role(id: string, companyId: string, title = `Title ${id}`): Role {
  return {
    id,
    owner_uid: "u",
    company_id: companyId,
    title,
    jd_raw: "",
    discovered_at: "2026-10-01T00:00:00.000Z",
  };
}

function company(id: string, name: string): Company {
  return { id, owner_uid: "u", name, priority: "medium" };
}

function person(id: string, name: string): Person {
  return {
    id,
    owner_uid: "u",
    name,
    role: "Recruiter",
    company_id: "c",
    relationship_type: "recruiter",
  };
}

function interaction(
  id: string,
  personId: string,
  occurredAt: string,
  applicationId?: string,
): Interaction {
  return {
    id,
    owner_uid: "u",
    person_id: personId,
    ...(applicationId !== undefined && { application_id: applicationId }),
    type: "email",
    direction: "inbound",
    summary: "",
    occurred_at: occurredAt,
  };
}

function inputs(overrides: Partial<PipelineBoardInputs>): PipelineBoardInputs {
  return {
    applications: [],
    roles: [],
    companies: [],
    interactions: [],
    people: [],
    now: NOW,
    ...overrides,
  };
}

function cardsIn(
  board: ReturnType<typeof buildPipelineBoard>,
  stage: ApplicationStage,
): readonly PipelineCard[] {
  return board.find((c) => c.stage === stage)?.cards ?? [];
}

describe("daysInStage", () => {
  it("floors whole days since last activity", () => {
    expect(daysInStage("2026-10-16T12:00:00.000Z", NOW)).toBe(3);
    expect(daysInStage("2026-10-16T12:00:01.000Z", NOW)).toBe(2);
  });

  it("is 0 on the same day", () => {
    expect(daysInStage("2026-10-19T11:59:59.000Z", NOW)).toBe(0);
    expect(daysInStage(NOW.toISOString(), NOW)).toBe(0);
  });

  it("clamps a future timestamp (clock skew) to 0", () => {
    expect(daysInStage("2026-10-25T00:00:00.000Z", NOW)).toBe(0);
  });

  it("returns null for an unparseable timestamp", () => {
    expect(daysInStage("not a date", NOW)).toBeNull();
    expect(daysInStage("", NOW)).toBeNull();
  });
});

describe("latestInteractionByApplication", () => {
  it("picks the most recent Interaction per Application", () => {
    const latest = latestInteractionByApplication([
      interaction("i1", "p1", "2026-10-01T00:00:00.000Z", "a1"),
      interaction("i2", "p2", "2026-10-05T00:00:00.000Z", "a1"),
      interaction("i3", "p3", "2026-10-03T00:00:00.000Z", "a1"),
      interaction("i4", "p4", "2026-10-02T00:00:00.000Z", "a2"),
    ]);
    expect(latest.get("a1")?.id).toBe("i2");
    expect(latest.get("a2")?.id).toBe("i4");
  });

  it("ignores Interactions with no Application or a bad timestamp", () => {
    const latest = latestInteractionByApplication([
      interaction("i1", "p1", "2026-10-09T00:00:00.000Z"),
      interaction("i2", "p2", "garbage", "a1"),
    ]);
    expect(latest.size).toBe(0);
  });

  it("keeps the first one seen on a timestamp tie", () => {
    const at = "2026-10-05T00:00:00.000Z";
    const latest = latestInteractionByApplication([
      interaction("i1", "p1", at, "a1"),
      interaction("i2", "p2", at, "a1"),
    ]);
    expect(latest.get("a1")?.id).toBe("i1");
  });

  it("is empty for no Interactions", () => {
    expect(latestInteractionByApplication([]).size).toBe(0);
  });
});

describe("buildPipelineBoard", () => {
  it("returns all seven columns in stage order, even with no data", () => {
    const board = buildPipelineBoard(inputs({}));
    expect(board.map((c) => c.stage)).toEqual([...PIPELINE_STAGES]);
    expect(board.every((c) => c.cards.length === 0)).toBe(true);
  });

  it("groups Applications into their stage's column with matching counts", () => {
    const board = buildPipelineBoard(
      inputs({
        applications: [
          app("a1", "saved"),
          app("a2", "applied"),
          app("a3", "applied"),
          app("a4", "interviewing"),
          app("a5", "withdrawn"),
        ],
      }),
    );
    const counts = Object.fromEntries(board.map((c) => [c.stage, c.cards.length]));
    expect(counts).toEqual({
      saved: 1,
      drafting: 0,
      applied: 2,
      interviewing: 1,
      offer: 0,
      rejected: 0,
      withdrawn: 1,
    });
  });

  it("drops an Application whose stage is not a known column", () => {
    const board = buildPipelineBoard(
      inputs({
        applications: [app("a1", "ghosted" as ApplicationStage)],
      }),
    );
    expect(board.reduce((n, c) => n + c.cards.length, 0)).toBe(0);
  });

  it("joins Application → Role → Company and computes days in stage", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [
            app("a1", "applied", {
              role_id: "r1",
              last_activity_at: "2026-10-14T12:00:00.000Z",
            }),
          ],
          roles: [role("r1", "c1", "Staff PM")],
          companies: [company("c1", "Acme")],
        }),
      ),
      "applied",
    );
    expect(card).toEqual({
      applicationId: "a1",
      roleId: "r1",
      companyName: "Acme",
      roleTitle: "Staff PM",
      daysInStage: 5,
      keyContact: null,
      nextAction: null,
    });
  });

  it("keeps a card with null fields when the Role is missing", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [app("a1", "offer", { role_id: "gone" })],
          companies: [company("c1", "Acme")],
        }),
      ),
      "offer",
    );
    expect(card?.roleId).toBe("gone");
    expect(card?.roleTitle).toBeNull();
    expect(card?.companyName).toBeNull();
  });

  it("keeps the Role title when only the Company is missing", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [app("a1", "saved", { role_id: "r1" })],
          roles: [role("r1", "missing-company", "Staff PM")],
        }),
      ),
      "saved",
    );
    expect(card?.roleTitle).toBe("Staff PM");
    expect(card?.companyName).toBeNull();
  });

  it("sets the key contact from the latest Interaction for that Application", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [app("a1", "interviewing")],
          interactions: [
            interaction("i1", "p-old", "2026-10-01T00:00:00.000Z", "a1"),
            interaction("i2", "p-new", "2026-10-10T00:00:00.000Z", "a1"),
            // A newer Interaction on a different Application must not win.
            interaction("i3", "p-other", "2026-10-18T00:00:00.000Z", "a2"),
          ],
          people: [
            person("p-old", "Old Contact"),
            person("p-new", "Dana Reyes"),
            person("p-other", "Someone Else"),
          ],
        }),
      ),
      "interviewing",
    );
    expect(card?.keyContact).toEqual({ personId: "p-new", name: "Dana Reyes" });
  });

  it("has no key contact when there is no matching Interaction", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [app("a1", "applied")],
          interactions: [
            interaction("i1", "p1", "2026-10-10T00:00:00.000Z", "other-app"),
            interaction("i2", "p1", "2026-10-11T00:00:00.000Z"),
          ],
          people: [person("p1", "Dana Reyes")],
        }),
      ),
      "applied",
    );
    expect(card?.keyContact).toBeNull();
  });

  it("has no key contact when the Interaction's Person is missing", () => {
    const [card] = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [app("a1", "applied")],
          interactions: [
            interaction("i1", "gone", "2026-10-10T00:00:00.000Z", "a1"),
          ],
        }),
      ),
      "applied",
    );
    expect(card?.keyContact).toBeNull();
  });

  it("orders each column by most recent activity first, then by id", () => {
    const cards = cardsIn(
      buildPipelineBoard(
        inputs({
          applications: [
            app("b-old", "applied", { last_activity_at: "2026-10-01T00:00:00.000Z" }),
            app("z-new", "applied", { last_activity_at: "2026-10-18T00:00:00.000Z" }),
            app("a-tie", "applied", { last_activity_at: "2026-10-10T00:00:00.000Z" }),
            app("b-tie", "applied", { last_activity_at: "2026-10-10T00:00:00.000Z" }),
            app("bad", "applied", { last_activity_at: "nope" }),
          ],
        }),
      ),
      "applied",
    );
    expect(cards.map((c) => c.applicationId)).toEqual([
      "z-new",
      "a-tie",
      "b-tie",
      "b-old",
      "bad",
    ]);
    expect(cards.at(-1)?.daysInStage).toBeNull();
  });
});
