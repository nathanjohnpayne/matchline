// @vitest-environment jsdom
/**
 * The Application Editor's Export menu, mounted in the real view (#523):
 * the view's own gate (`exportGateState` over the server attestation)
 * drives the menu, choosing Text hands the container's handler the
 * format, and a server refusal shows inline in the resume pane. The
 * export call is mocked; ExportMenu.dom.test.tsx covers the menu itself.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FunctionsError } from "firebase/functions";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application, AssetRef } from "../../types/crm.ts";
import {
  assetContentVersion,
  type ValidationAttestation,
} from "../../../functions/src/validation/attestation.ts";

import ApplicationEditorView from "./ApplicationEditorView.tsx";

const ASSET: AssetRef = {
  id: "asset-1",
  owner_uid: "u",
  application_id: "app-1",
  kind: "resume",
  format: "json",
  storage_path: "",
  generated_content: {
    summary: { id: "summary", text: "Product leader — platform and growth.", source_unit_ids: [] },
    bullets: [{ id: "b1", text: "Shipped the thing.", source_unit_ids: [] }],
    skills: [],
  },
  validation_status: "passed",
  validation_flags: [],
  created_at: "2026-10-01T00:00:00.000Z",
};

const APPLICATION: Application = {
  id: "app-1",
  owner_uid: "u",
  role_id: "role-1",
  stage: "drafting",
  last_activity_at: "2026-10-01T00:00:00.000Z",
  generated_assets: [ASSET],
  approved_unit_ids: [],
};

function attestation(a: AssetRef): ValidationAttestation {
  return {
    owner_uid: a.owner_uid,
    application_id: a.application_id,
    asset_id: a.id,
    content_version: assetContentVersion(a.generated_content),
    status: "passed",
    validated_at: "2026-10-02T00:00:00.000Z",
    validated_unit_versions: {},
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ApplicationEditorView Export menu (#523)", () => {
  it("exports Text through the container's handler for an attested pass", () => {
    const onExport = vi.fn(() => Promise.resolve());
    render(
      <ApplicationEditorView
        status="ready"
        application={APPLICATION}
        asset={ASSET}
        units={[]}
        attestation={attestation(ASSET)}
        onExport={onExport}
      />,
    );
    const trigger = screen.getByTestId("export-button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("export-format-txt"), { key: "Enter" });
    expect(onExport).toHaveBeenCalledWith("txt");
  });

  it("shows a server failed-precondition refusal inline in the resume pane", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onExport = vi.fn(() =>
      Promise.reject(
        new FunctionsError(
          "failed-precondition",
          "This resume's current content isn't covered by a passing validation run. Re-run validation before exporting.",
        ),
      ),
    );
    render(
      <ApplicationEditorView
        status="ready"
        application={APPLICATION}
        asset={ASSET}
        units={[]}
        attestation={attestation(ASSET)}
        onExport={onExport}
      />,
    );
    fireEvent.click(screen.getByTestId("export-button"));
    fireEvent.click(screen.getByTestId("export-format-txt"));
    const error = await screen.findByTestId("export-error");
    expect(screen.getByTestId("resume-pane").contains(error)).toBe(true);
    expect(error.textContent).toContain("Re-run validation before exporting.");
    expect((screen.getByTestId("export-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the menu closed with the gate's reason and re-validate action when the content was never attested", () => {
    const onExport = vi.fn();
    const onRevalidate = vi.fn();
    render(
      <ApplicationEditorView
        status="ready"
        application={APPLICATION}
        asset={ASSET}
        units={[]}
        attestation={null}
        onExport={onExport}
        onRevalidate={onRevalidate}
      />,
    );
    const trigger = screen.getByTestId("export-button") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(screen.getByTestId("export-disabled-reason").textContent).not.toBe("");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByTestId("export-menu")).toBeNull();
    fireEvent.click(screen.getByTestId("revalidate-button"));
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onExport).not.toHaveBeenCalled();
  });
});
