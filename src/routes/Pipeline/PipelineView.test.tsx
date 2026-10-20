/**
 * Static-render tests for the Pipeline board view (#510). Same
 * convention as `RoleDetailView.test.tsx`: `renderToStaticMarkup`,
 * wrapped in `MemoryRouter` because cards are router `Link`s.
 * Click-through is asserted on the rendered `href`, which is what a
 * click (or Enter on a focused card) follows.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { ApplicationStage } from "../../types/crm.ts";

import {
  PIPELINE_STAGES,
  type PipelineCard,
  type PipelineColumn,
} from "./buildPipelineBoard.ts";
import PipelineView, {
  STAGE_EMPTY_COPY,
  STAGE_LABELS,
  type PipelineViewProps,
} from "./PipelineView.tsx";

function card(overrides: Partial<PipelineCard> = {}): PipelineCard {
  return {
    applicationId: "a1",
    roleId: "r1",
    companyName: "Acme",
    roleTitle: "Staff Product Manager",
    daysInStage: 4,
    keyContact: null,
    nextAction: null,
    ...overrides,
  };
}

function board(
  cards: Partial<Record<ApplicationStage, PipelineCard[]>>,
): PipelineColumn[] {
  return PIPELINE_STAGES.map((stage) => ({ stage, cards: cards[stage] ?? [] }));
}

function render(props: Partial<PipelineViewProps> = {}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <PipelineView
        status="ready"
        columns={board({})}
        error={null}
        partial={false}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** The markup of one column, by stage. */
function columnHtml(html: string, stage: ApplicationStage): string {
  const start = html.indexOf(`data-stage="${stage}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-testid="pipeline-column"', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("PipelineView", () => {
  it("renders seven columns in ApplicationStage order with labels", () => {
    const html = render();
    const stages = [...html.matchAll(/data-stage="([a-z]+)"/g)].map((m) => m[1]);
    expect(stages).toEqual([...PIPELINE_STAGES]);
    for (const stage of PIPELINE_STAGES) {
      expect(columnHtml(html, stage)).toContain(`<span>${STAGE_LABELS[stage]}</span>`);
    }
  });

  it("shows each column's card count in its header", () => {
    const html = render({
      columns: board({
        applied: [card({ applicationId: "a1" }), card({ applicationId: "a2" })],
        offer: [card({ applicationId: "a3" })],
      }),
    });
    const count = (stage: ApplicationStage): string | undefined =>
      columnHtml(html, stage).match(
        /data-testid="pipeline-column-count">(\d+)</,
      )?.[1];
    expect(count("applied")).toBe("2");
    expect(count("offer")).toBe("1");
    expect(count("saved")).toBe("0");
  });

  it("places each card in its stage's column", () => {
    const html = render({
      columns: board({
        saved: [card({ applicationId: "in-saved" })],
        interviewing: [card({ applicationId: "in-interviewing" })],
      }),
    });
    expect(columnHtml(html, "saved")).toContain('data-application-id="in-saved"');
    expect(columnHtml(html, "interviewing")).toContain(
      'data-application-id="in-interviewing"',
    );
    expect(columnHtml(html, "saved")).not.toContain("in-interviewing");
  });

  it("shows every empty column's own empty-state copy", () => {
    const html = render({
      columns: board({ applied: [card()] }),
    });
    for (const stage of PIPELINE_STAGES) {
      const col = columnHtml(html, stage);
      if (stage === "applied") {
        expect(col).not.toContain('data-testid="pipeline-column-empty"');
      } else {
        expect(col).toContain('data-testid="pipeline-column-empty"');
        expect(col).toContain(STAGE_EMPTY_COPY[stage].replace(/'/g, "&#x27;"));
      }
    }
    // Copy is per-column, not one string repeated.
    expect(new Set(Object.values(STAGE_EMPTY_COPY)).size).toBe(PIPELINE_STAGES.length);
  });

  it("renders company, title and days in stage on a card", () => {
    const html = render({
      columns: board({ applied: [card({ daysInStage: 4 })] }),
    });
    expect(html).toMatch(/data-testid="pipeline-card-company">Acme</);
    expect(html).toContain(">Staff Product Manager<");
    expect(html).toMatch(/data-testid="pipeline-card-days"[^>]*>4d</);
    expect(html).toContain('aria-label="4 days in stage"');
  });

  it("uses the singular for one day", () => {
    const html = render({ columns: board({ applied: [card({ daysInStage: 1 })] }) });
    expect(html).toContain('aria-label="1 day in stage"');
  });

  it("shows the key contact only when there is one", () => {
    const without = render({ columns: board({ applied: [card()] }) });
    expect(without).not.toContain('data-testid="pipeline-card-contact"');

    const withContact = render({
      columns: board({
        applied: [card({ keyContact: { personId: "p1", name: "Dana Reyes" } })],
      }),
    });
    expect(withContact).toContain('aria-label="Key contact: Dana Reyes"');
    expect(withContact).toMatch(/data-testid="pipeline-card-contact"[^>]*>DR</);
  });

  it("renders nothing in the next-action slot while it is null", () => {
    const html = render({ columns: board({ applied: [card()] }) });
    expect(html).not.toContain('data-testid="pipeline-card-next-action"');
  });

  it("renders a visible fallback when the Role or Company is missing", () => {
    const html = render({
      columns: board({
        offer: [card({ companyName: null, roleTitle: null, roleId: "gone" })],
      }),
    });
    expect(html).toContain(">Unknown company<");
    expect(html).toContain(">Role unavailable<");
    // Still clickable: the Role id comes from the Application.
    expect(html).toContain('href="/roles/gone"');
  });

  it("links each card to its Role Detail page", () => {
    const html = render({
      columns: board({
        applied: [card({ applicationId: "a1", roleId: "role-123" })],
        drafting: [card({ applicationId: "a2", roleId: "role-456" })],
      }),
    });
    expect(html).toMatch(
      /<a[^>]*href="\/roles\/role-123"[^>]*data-application-id="a1"|<a[^>]*data-application-id="a1"[^>]*href="\/roles\/role-123"/,
    );
    expect(html).toContain('href="/roles/role-456"');
  });

  it("stacks vertically below md and sits side by side from md", () => {
    const html = render();
    const boardTag = html.match(/<div[^>]*data-testid="pipeline-board"[^>]*>/)?.[0] ?? "";
    expect(boardTag).toContain("flex-col");
    expect(boardTag).toContain("md:grid");
    expect(boardTag).toContain("md:grid-cols-7");
    // Headers are pills by default and plain rows from md up.
    const header = html.match(/<h2[^>]*data-testid="pipeline-column-header"[^>]*>/)?.[0] ?? "";
    expect(header).toContain("rounded-full");
    expect(header).toContain("md:rounded-none");
  });

  it("does not render the Sprint 0 placeholder footer", () => {
    expect(render()).not.toContain("Sprint 0 placeholder");
  });

  it("LOADING: shows an inline loading line and no board", () => {
    const html = render({ status: "loading", columns: [] });
    expect(html).toContain('data-testid="pipeline-loading"');
    expect(html).not.toContain('data-testid="pipeline-board"');
  });

  it("ERROR: shows the read failure inline as an alert, no board", () => {
    const html = render({
      status: "error",
      columns: [],
      error: new Error("permission-denied"),
    });
    expect(html).toMatch(/role="alert"[^>]*data-testid="pipeline-error"/);
    expect(html).toContain("permission-denied");
    expect(html).not.toContain('data-testid="pipeline-board"');
  });

  it("PARTIAL: notes missing details above a board that still renders", () => {
    const html = render({ partial: true, columns: board({ applied: [card()] }) });
    expect(html).toContain('data-testid="pipeline-partial"');
    expect(html).toContain('data-testid="pipeline-board"');
    expect(html).toContain('data-testid="pipeline-card"');
  });
});
