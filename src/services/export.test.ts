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

const { exportAndDownload, invokeExportAsset, isSafeDownloadUrl, startDownload } = await import(
  "./export.ts"
);
const { isAppBusy } = await import("../lib/appBusy.ts");

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

  it("releases the lease when starting the download throws", async () => {
    await expect(
      exportAndDownload("app-1", "asset-1", "txt", {
        invoke: () => Promise.resolve({ ...RESPONSE, url: "javascript:alert(1)" }),
      }),
    ).rejects.toThrow("unexpected download link");
    expect(isAppBusy()).toBe(false);
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
  it("clicks a hidden anchor carrying the URL, the filename and noopener, then removes it", () => {
    const clicked: HTMLAnchorElement[] = [];
    const spy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });
    startDownload(RESPONSE.url, RESPONSE.filename);
    expect(clicked).toHaveLength(1);
    const anchor = clicked[0]!;
    expect(anchor.href).toBe(RESPONSE.url);
    expect(anchor.download).toBe("Acme — Senior PM — Resume.txt");
    expect(anchor.rel).toBe("noopener noreferrer");
    expect(anchor.target).toBe("");
    expect(document.querySelector("a")).toBeNull();
    spy.mockRestore();
  });

  it("refuses a non-https link and never navigates", () => {
    const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    for (const url of ["javascript:alert(1)", "data:text/plain,hi", "http://example.com/x.txt", "not a url"]) {
      expect(() => startDownload(url, "Resume.txt")).toThrow("unexpected download link");
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
