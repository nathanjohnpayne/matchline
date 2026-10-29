// @vitest-environment jsdom
/**
 * The Application Editor's export action (#523): it exports the shown
 * asset, and refuses (rather than resolving silently) when the editor has
 * no Application or asset id, so the Export menu shows an inline error
 * instead of implying a download started. `exportAndDownload` is stubbed.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ExportMenu from "../../components/ExportMenu.tsx";
import { EXPORT_UNAVAILABLE_MESSAGE, exportCurrentAsset } from "./exportCurrentAsset.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("exportCurrentAsset", () => {
  it("exports the shown asset in the chosen format", async () => {
    const run = vi.fn(() => Promise.resolve({}));
    await expect(exportCurrentAsset("app-1", "asset-1", "txt", run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith("app-1", "asset-1", "txt");
  });

  it.each([
    ["no applicationId", undefined, "asset-1"],
    ["no assetId", "app-1", undefined],
    ["neither id", undefined, undefined],
    ["a blank applicationId", "", "asset-1"],
    ["a blank assetId", "app-1", ""],
  ])("rejects with %s instead of resolving silently, and never calls the export", async (_label, applicationId, assetId) => {
    const run = vi.fn(() => Promise.resolve({}));
    await expect(exportCurrentAsset(applicationId, assetId, "txt", run)).rejects.toThrow(EXPORT_UNAVAILABLE_MESSAGE);
    expect(EXPORT_UNAVAILABLE_MESSAGE).toBe("This resume can't be exported right now.");
    expect(run).not.toHaveBeenCalled();
  });

  it("passes an export failure through unchanged", async () => {
    const failure = new Error("refused");
    await expect(exportCurrentAsset("app-1", "asset-1", "txt", () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it("surfaces the refusal inline in the Export menu, which is usable again at once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(() => Promise.resolve({}));
    render(
      <ExportMenu
        gate={{ enabled: true, disabledReason: null }}
        onExport={(format) => exportCurrentAsset(undefined, "asset-1", format, run)}
      />,
    );
    const trigger = screen.getByTestId("export-button") as HTMLButtonElement;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("export-format-txt"));
    const error = await screen.findByTestId("export-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent ?? "").not.toBe("");
    expect(console.warn).toHaveBeenCalledWith(
      "export failed",
      expect.objectContaining({ message: EXPORT_UNAVAILABLE_MESSAGE }),
    );
    await waitFor(() => expect(trigger.disabled).toBe(false));
    expect(run).not.toHaveBeenCalled();
  });
});
