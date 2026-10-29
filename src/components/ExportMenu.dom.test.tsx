// @vitest-environment jsdom
/**
 * Export dropdown (#523): disabled trigger with the gate's reason and
 * re-validate action, the format list and its fixed order, busy state,
 * inline errors (including the server's failed-precondition), keyboard
 * operation and isolation from Application Editor internals. The export
 * call is mocked; the real one is `exportAndDownload` (services/export.ts).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FunctionsError } from "firebase/functions";
import { afterEach, describe, expect, it, vi } from "vitest";

import ExportMenu, {
  EXPORT_FORMAT_OPTIONS,
  type ExportMenuGate,
  type ExportMenuProps,
} from "./ExportMenu.tsx";
import exportMenuSource from "./ExportMenu.tsx?raw";

const OPEN: ExportMenuGate = { enabled: true, disabledReason: null };
const STALE: ExportMenuGate = {
  enabled: false,
  disabledReason: "This resume changed since it was validated. Re-run validation before exporting.",
  canRevalidate: true,
};
const FLAGGED: ExportMenuGate = {
  enabled: false,
  disabledReason: "Resolve 2 validation flags before exporting.",
};

function renderMenu(props: Partial<ExportMenuProps> = {}): ReturnType<typeof render> {
  return render(<ExportMenu gate={OPEN} onExport={() => undefined} {...props} />);
}

function trigger(): HTMLButtonElement {
  return screen.getByTestId("export-button") as HTMLButtonElement;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ExportMenu: closed gate", () => {
  it("disables the trigger, shows the gate's reason and never opens or exports", () => {
    const onExport = vi.fn();
    renderMenu({ gate: FLAGGED, onExport });
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute("data-export-enabled")).toBe("false");
    expect(trigger().title).toBe(FLAGGED.disabledReason);
    expect(screen.getByTestId("export-disabled-reason").textContent).toBe(FLAGGED.disabledReason);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.queryByTestId("export-menu")).toBeNull();
    expect(onExport).not.toHaveBeenCalled();
  });

  it("offers Re-run validation when the gate says re-validating is the fix", () => {
    const onRevalidate = vi.fn();
    renderMenu({ gate: STALE, onRevalidate });
    expect(screen.getByTestId("export-disabled-reason").textContent).toBe(STALE.disabledReason);
    fireEvent.click(screen.getByTestId("revalidate-button"));
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });

  it("does not offer Re-run validation when the gate cannot be fixed that way", () => {
    renderMenu({ gate: FLAGGED, onRevalidate: () => undefined });
    expect(screen.queryByTestId("revalidate-button")).toBeNull();
  });

  it("shows the in-flight re-validation label disabled, and a re-validation error inline", () => {
    renderMenu({
      gate: STALE,
      onRevalidate: () => undefined,
      revalidating: true,
      revalidateError: "Validation couldn't run. Try again in a moment.",
    });
    const retry = screen.getByTestId("revalidate-button") as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    expect(retry.textContent).toBe("Re-running validation…");
    expect(screen.getByTestId("revalidate-error").getAttribute("role")).toBe("alert");
  });

  it("stays disabled with 'Export is not available yet.' when no export call is wired", () => {
    render(<ExportMenu gate={OPEN} />);
    expect(trigger().disabled).toBe(true);
    expect(screen.getByTestId("export-disabled-reason").textContent).toBe(
      "Export is not available yet.",
    );
  });

  it("stays disabled when there are no formats to offer", () => {
    renderMenu({ formats: [] });
    expect(trigger().disabled).toBe(true);
    expect(screen.getByTestId("export-disabled-reason").textContent).toBe(
      "Export is not available yet.",
    );
  });
});

describe("ExportMenu: format list", () => {
  it("opens a menu with exactly one entry, Text, by default", () => {
    expect(EXPORT_FORMAT_OPTIONS).toEqual([{ format: "txt", label: "Text" }]);
    renderMenu();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByTestId("export-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(trigger().getAttribute("aria-controls")).toBe(menu.id);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Text"]);
  });

  it("always lists formats in the order PDF, DOCX, Text", () => {
    renderMenu({
      formats: [
        { format: "txt", label: "Text" },
        { format: "pdf", label: "PDF" },
        { format: "docx", label: "DOCX" },
      ],
    });
    fireEvent.click(trigger());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "PDF",
      "DOCX",
      "Text",
    ]);
  });

  it("clicking the trigger again closes the menu", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByTestId("export-menu")).toBeNull();
  });

  it("a click outside closes the menu without exporting", () => {
    const onExport = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">
          outside
        </button>
        <ExportMenu gate={OPEN} onExport={onExport} />
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("export-menu")).toBeNull();
    expect(onExport).not.toHaveBeenCalled();
  });

  it("closes an open menu when the gate closes", () => {
    const view = renderMenu();
    fireEvent.click(trigger());
    view.rerender(<ExportMenu gate={STALE} onExport={() => undefined} />);
    expect(screen.queryByTestId("export-menu")).toBeNull();
    expect(trigger().disabled).toBe(true);
  });
});

describe("ExportMenu: exporting", () => {
  it("choosing Text calls onExport('txt') once and closes the menu", async () => {
    const onExport = vi.fn(() => Promise.resolve());
    renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith("txt");
    expect(screen.queryByTestId("export-menu")).toBeNull();
    await waitFor(() => expect(trigger().disabled).toBe(false));
    expect(screen.queryByTestId("export-error")).toBeNull();
  });

  it("is busy while the export runs: disabled, 'Exporting…', aria-busy, and no second call", async () => {
    const pending = deferred();
    const onExport = vi.fn(() => pending.promise);
    renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    expect(trigger().disabled).toBe(true);
    expect(trigger().textContent).toBe("Exporting…");
    expect(trigger().getAttribute("aria-busy")).toBe("true");
    expect(trigger().getAttribute("data-export-busy")).toBe("true");
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.queryByTestId("export-menu")).toBeNull();
    expect(onExport).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(trigger().disabled).toBe(false);
    expect(trigger().textContent).toContain("Export");
    expect(trigger().getAttribute("aria-busy")).toBeNull();
  });

  it("shows the server's failed-precondition sentence inline, and the control works again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refusal = new FunctionsError(
      "failed-precondition",
      "This resume's current content isn't covered by a passing validation run. Re-run validation before exporting.",
    );
    const onExport = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined);
    renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    const error = await screen.findByTestId("export-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe(
      "This resume's current content isn't covered by a passing validation run. Re-run validation before exporting.",
    );
    expect(trigger().disabled).toBe(false);
    // Usable again, and a new attempt clears the old error.
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    await waitFor(() => expect(screen.queryByTestId("export-error")).toBeNull());
    expect(onExport).toHaveBeenCalledTimes(2);
  });

  it("shows generic friendly copy for a bare internal error, never the code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onExport = vi.fn(() => Promise.reject(new FunctionsError("internal", "internal")));
    renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    const error = await screen.findByTestId("export-error");
    expect(error.textContent).not.toBe("internal");
    expect(error.textContent?.length ?? 0).toBeGreaterThan(20);
  });

  it("shows generic copy for a non-callable failure (for example a refused download link)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onExport = vi.fn(() =>
      Promise.reject(new Error("The export returned an unexpected download link.")),
    );
    renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    expect((await screen.findByTestId("export-error")).textContent).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("clears the error when the gate changes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onExport = vi.fn(() => Promise.reject(new FunctionsError("failed-precondition", "Refused.")));
    const view = renderMenu({ onExport });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("export-format-txt"));
    await screen.findByTestId("export-error");
    view.rerender(<ExportMenu gate={STALE} onExport={onExport} />);
    expect(screen.queryByTestId("export-error")).toBeNull();
  });
});

describe("ExportMenu: keyboard", () => {
  const MANY: ExportMenuProps["formats"] = [
    { format: "pdf", label: "PDF" },
    { format: "docx", label: "DOCX" },
    { format: "txt", label: "Text" },
  ];

  it("ArrowDown opens on the first item and Enter chooses it", async () => {
    const onExport = vi.fn(() => Promise.resolve());
    renderMenu({ onExport });
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const item = screen.getByTestId("export-format-txt");
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "Enter" });
    expect(onExport).toHaveBeenCalledWith("txt");
    await waitFor(() => expect(trigger().disabled).toBe(false));
    expect(document.activeElement).toBe(trigger());
  });

  it("Enter and Space on the trigger open the menu; Space on an item chooses it", () => {
    const onExport = vi.fn();
    renderMenu({ onExport });
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.getByTestId("export-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("export-menu"), { key: "Escape" });
    fireEvent.keyDown(trigger(), { key: " " });
    expect(screen.getByTestId("export-menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("export-format-txt"), { key: " " });
    expect(onExport).toHaveBeenCalledWith("txt");
  });

  it("Escape closes and returns focus to the trigger without exporting", () => {
    const onExport = vi.fn();
    renderMenu({ onExport });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("export-format-txt"), { key: "Escape" });
    expect(screen.queryByTestId("export-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(onExport).not.toHaveBeenCalled();
  });

  it("Tab closes the menu", () => {
    renderMenu();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("export-format-txt"), { key: "Tab" });
    expect(screen.queryByTestId("export-menu")).toBeNull();
  });

  it("Tab hands focus to the trigger inside the keydown handler, without preventing the browser's Tab", () => {
    renderMenu();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    const item = screen.getByTestId("export-format-txt");
    expect(document.activeElement).toBe(item);
    // A document listener runs after React's root listener, i.e. at the
    // end of the menu's keydown handler and before the browser's default
    // Tab action would move focus on.
    let focusedAtEndOfHandler: Element | null = null;
    const record = (): void => {
      focusedAtEndOfHandler = document.activeElement;
    };
    document.addEventListener("keydown", record);
    let notPrevented: boolean;
    try {
      notPrevented = fireEvent.keyDown(item, { key: "Tab" });
    } finally {
      document.removeEventListener("keydown", record);
    }
    expect(notPrevented).toBe(true);
    expect(focusedAtEndOfHandler).toBe(trigger());
    expect(document.activeElement).toBe(trigger());
    expect(screen.queryByTestId("export-menu")).toBeNull();
  });

  it("arrows wrap, Home and End jump, ArrowUp on the trigger opens on the last item", () => {
    const onExport = vi.fn();
    renderMenu({ onExport, formats: MANY });
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    const focused = (): string | null =>
      (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null;
    expect(focused()).toBe("export-format-txt");
    const menu = screen.getByTestId("export-menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("export-format-pdf");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(focused()).toBe("export-format-txt");
    fireEvent.keyDown(menu, { key: "Home" });
    expect(focused()).toBe("export-format-pdf");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(focused()).toBe("export-format-docx");
    fireEvent.keyDown(menu, { key: "End" });
    expect(focused()).toBe("export-format-txt");
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onExport).toHaveBeenCalledWith("txt");
  });

  it("only the active item is in the tab order", () => {
    renderMenu({ formats: MANY });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getAllByRole("menuitem").map((item) => item.tabIndex)).toEqual([0, -1, -1]);
  });
});

describe("ExportMenu: isolation", () => {
  it("imports nothing from src/routes (mountable in the Package tab, #628)", () => {
    const imports = [...exportMenuSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/routes\//);
    }
  });
});
