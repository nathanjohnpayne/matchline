// @vitest-environment jsdom
/**
 * The Application Editor's export action (#523): it exports the shown
 * asset, and refuses (rather than resolving silently) when the editor has
 * no Application or asset id, so the Export menu shows an inline error
 * instead of implying a download started. Both of the app's own refusals
 * (no ids, an unsafe download link) reach the menu as `ExportRefusal` and
 * show their sentence. `exportAndDownload` is stubbed, or given a stubbed
 * callable.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ExportMenu from "../../components/ExportMenu.tsx";
import { ExportRefusal } from "../../lib/exportRefusal.ts";
import { exportAndDownload, UNSAFE_DOWNLOAD_LINK_MESSAGE } from "../../services/export.ts";
import { EXPORT_UNAVAILABLE_MESSAGE, exportCurrentAsset } from "./exportCurrentAsset.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
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
    const attempt = exportCurrentAsset(applicationId, assetId, "txt", run);
    await expect(attempt).rejects.toBeInstanceOf(ExportRefusal);
    await expect(attempt).rejects.toThrow(EXPORT_UNAVAILABLE_MESSAGE);
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
    expect(error.textContent).toBe(EXPORT_UNAVAILABLE_MESSAGE);
    expect(console.warn).toHaveBeenCalledWith(
      "export failed",
      expect.objectContaining({ message: EXPORT_UNAVAILABLE_MESSAGE }),
    );
    await waitFor(() => expect(trigger.disabled).toBe(false));
    expect(run).not.toHaveBeenCalled();
  });

  it("surfaces an unsafe download link's refusal inline, with its sentence, and loads nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invoke = vi.fn(() =>
      Promise.resolve({
        url: "javascript:alert(1)",
        filename: "Resume.txt",
        format: "txt" as const,
        contentType: "text/plain; charset=utf-8",
        expiresAt: "2026-10-29T12:05:00.000Z",
      }),
    );
    render(
      <ExportMenu
        gate={{ enabled: true, disabledReason: null }}
        onExport={(format) =>
          exportCurrentAsset("app-1", "asset-1", format, (applicationId, assetId, f) =>
            exportAndDownload(applicationId, assetId, f, { invoke }),
          )
        }
      />,
    );
    const trigger = screen.getByTestId("export-button") as HTMLButtonElement;
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("export-format-txt"));
    const error = await screen.findByTestId("export-error");
    expect(error.textContent).toBe(UNSAFE_DOWNLOAD_LINK_MESSAGE);
    expect(error.textContent).not.toBe("Something went wrong. Try again.");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("app-1", "asset-1", "txt");
    expect(document.querySelector("iframe")).toBeNull();
    await waitFor(() => expect(trigger.disabled).toBe(false));
  });
});
