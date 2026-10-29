// @vitest-environment jsdom
/**
 * Client export service (#523): the `exportAsset` callable wrapper, the
 * busy lease around call + download, and the download-link guard.
 * Firebase is mocked narrowly, the way `validation.test.ts` does it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const callable = vi.fn();
const httpsCallable = vi.fn((..._args: unknown[]) => callable);

vi.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => httpsCallable(...args),
}));
vi.mock("../firebase.ts", () => ({ getFunctionsClient: () => ({ client: true }) }));

const {
  DOWNLOAD_FRAME_LIFETIME_MS,
  UNSAFE_DOWNLOAD_LINK_MESSAGE,
  exportAndDownload,
  invokeExportAsset,
  isSafeDownloadUrl,
  startDownload,
} = await import("./export.ts");
const { isAppBusy } = await import("../lib/appBusy.ts");
const { ExportRefusal } = await import("../lib/exportRefusal.ts");

const RESPONSE = {
  url: "https://storage.googleapis.com/bucket/applications/app-1/asset-1.txt?X-Goog-Signature=abc",
  filename: "Acme — Senior PM — Resume.txt",
  format: "txt" as const,
  contentType: "text/plain; charset=utf-8",
  expiresAt: "2026-10-29T12:05:00.000Z",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("invokeExportAsset", () => {
  it("calls the exportAsset callable with its client timeout and returns the response data", async () => {
    callable.mockResolvedValueOnce({ data: RESPONSE });
    const result = await invokeExportAsset("app-1", "asset-1", "txt");
    expect(httpsCallable).toHaveBeenCalledWith({ client: true }, "exportAsset", {
      timeout: 150_000,
    });
    expect(callable).toHaveBeenCalledWith({
      applicationId: "app-1",
      assetId: "asset-1",
      format: "txt",
    });
    expect(result).toEqual(RESPONSE);
  });

  it("propagates the callable rejection unchanged", async () => {
    const err = Object.assign(new Error("Re-run validation before exporting."), {
      code: "functions/failed-precondition",
    });
    callable.mockRejectedValueOnce(err);
    await expect(invokeExportAsset("app-1", "asset-1", "txt")).rejects.toBe(err);
  });
});

describe("exportAndDownload", () => {
  it("holds a busy lease while the call is pending and starts the download on success", async () => {
    const pending = deferred<typeof RESPONSE>();
    const invoke = vi.fn(() => pending.promise);
    const download = vi.fn();
    const run = exportAndDownload("app-1", "asset-1", "txt", { invoke, download });
    expect(isAppBusy()).toBe(true);
    expect(download).not.toHaveBeenCalled();
    pending.resolve(RESPONSE);
    await expect(run).resolves.toEqual(RESPONSE);
    expect(invoke).toHaveBeenCalledWith("app-1", "asset-1", "txt");
    expect(download).toHaveBeenCalledWith(RESPONSE.url, RESPONSE.filename);
    expect(isAppBusy()).toBe(false);
  });

  it("releases the lease and rethrows when the call fails, without downloading", async () => {
    const err = new Error("boom");
    const download = vi.fn();
    await expect(
      exportAndDownload("app-1", "asset-1", "txt", {
        invoke: () => Promise.reject(err),
        download,
      }),
    ).rejects.toBe(err);
    expect(download).not.toHaveBeenCalled();
    expect(isAppBusy()).toBe(false);
  });

  it("releases the lease when starting the download throws, rejecting with an ExportRefusal", async () => {
    const run = exportAndDownload("app-1", "asset-1", "txt", {
      invoke: () => Promise.resolve({ ...RESPONSE, url: "javascript:alert(1)" }),
    });
    await expect(run).rejects.toBeInstanceOf(ExportRefusal);
    await expect(run).rejects.toThrow(UNSAFE_DOWNLOAD_LINK_MESSAGE);
    expect(isAppBusy()).toBe(false);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("starts the default download in a hidden iframe", async () => {
    vi.useFakeTimers();
    await exportAndDownload("app-1", "asset-1", "txt", { invoke: () => Promise.resolve(RESPONSE) });
    const frame = document.querySelector("iframe");
    expect(frame?.src).toBe(RESPONSE.url);
  });

  it("uses one lease per invocation, so the first export settling cannot release the second's", async () => {
    const first = deferred<typeof RESPONSE>();
    const second = deferred<typeof RESPONSE>();
    const download = vi.fn();
    const a = exportAndDownload("app-1", "asset-1", "txt", { invoke: () => first.promise, download });
    const b = exportAndDownload("app-1", "asset-2", "txt", { invoke: () => second.promise, download });
    first.resolve(RESPONSE);
    await a;
    expect(isAppBusy()).toBe(true);
    second.resolve(RESPONSE);
    await b;
    expect(isAppBusy()).toBe(false);
  });
});

describe("startDownload", () => {
  it("loads the URL in a hidden iframe and removes the frame after its lifetime", () => {
    vi.useFakeTimers();
    startDownload(RESPONSE.url);
    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.src).toBe(RESPONSE.url);
    expect(frame.style.display).toBe("none");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.dataset.exportDownload).toBe("true");
    vi.advanceTimersByTime(DOWNLOAD_FRAME_LIFETIME_MS - 1);
    expect(document.querySelector("iframe")).toBe(frame);
    vi.advanceTimersByTime(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("never navigates the page: no window.location change and no anchor click", () => {
    const before = window.location.href;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const scheduled: Array<[() => void, number]> = [];
    startDownload(RESPONSE.url, { schedule: (run, ms) => scheduled.push([run, ms]) });
    expect(window.location.href).toBe(before);
    expect(click).not.toHaveBeenCalled();
    expect(document.querySelector("a")).toBeNull();
    // The URL went to the frame and nowhere else.
    expect(document.querySelector("iframe")?.src).toBe(RESPONSE.url);
    expect(scheduled.map(([, ms]) => ms)).toEqual([DOWNLOAD_FRAME_LIFETIME_MS]);
    scheduled[0]![0]();
    expect(document.querySelector("iframe")).toBeNull();
    expect(window.location.href).toBe(before);
    click.mockRestore();
  });

  it("gives each download its own frame", () => {
    vi.useFakeTimers();
    startDownload(RESPONSE.url);
    startDownload("http://127.0.0.1:9199/b/applications/a/x.txt");
    expect([...document.querySelectorAll("iframe")].map((f) => f.src)).toEqual([
      RESPONSE.url,
      "http://127.0.0.1:9199/b/applications/a/x.txt",
    ]);
    vi.advanceTimersByTime(DOWNLOAD_FRAME_LIFETIME_MS);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("refuses a non-https link with an ExportRefusal and creates no frame", () => {
    for (const url of ["javascript:alert(1)", "data:text/plain,hi", "http://example.com/x.txt", "not a url"]) {
      expect(() => startDownload(url)).toThrow(ExportRefusal);
      expect(() => startDownload(url)).toThrow(UNSAFE_DOWNLOAD_LINK_MESSAGE);
    }
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("isSafeDownloadUrl", () => {
  it.each([
    ["https://storage.googleapis.com/b/o?sig=1", true],
    ["http://127.0.0.1:9199/b/applications/a/x.txt", true],
    ["http://localhost:9199/b/applications/a/x.txt", true],
    ["http://storage.googleapis.com/b/o", false],
    ["javascript:alert(1)", false],
    ["data:text/plain,hi", false],
    ["", false],
  ])("%s → %s", (url, safe) => {
    expect(isSafeDownloadUrl(url)).toBe(safe);
  });
});
