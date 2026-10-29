/**
 * Tests for the export object path, private write and download URL (#521).
 * Storage is a hand-rolled stub; nothing here touches the network.
 */

import { describe, expect, it, vi } from "vitest";

import {
  downloadUrl,
  EXPORT_URL_TTL_MS,
  exportObjectPath,
  isDeployedRuntime,
  StorageEmulatorInDeployedRuntime,
  storageEmulatorHost,
  writeExport,
  type ExportFileLike,
} from "./storage.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const DISPOSITION = "attachment; filename=\"Resume.txt\"; filename*=UTF-8''Resume.txt";
const CONTENT_TYPE = "text/plain; charset=utf-8";

function stubFile(signed = "https://storage.googleapis.com/bucket/obj?X-Goog-Signature=abc") {
  const file = {
    save: vi.fn(async () => undefined),
    getSignedUrl: vi.fn(async () => [signed] as [string]),
    makePublic: vi.fn(async () => undefined),
  };
  return file as typeof file & ExportFileLike;
}

describe("exportObjectPath", () => {
  it("is applications/{applicationId}/{assetId}.{ext}", () => {
    expect(exportObjectPath("app-1", "asset-1", "txt")).toBe("applications/app-1/asset-1.txt");
  });
});

describe("writeExport", () => {
  it("saves the exact bytes once, privately, with the content type and disposition", async () => {
    const file = stubFile();
    const bytes = new TextEncoder().encode("SUMMARY\nLed — things\n");
    await writeExport(file, { bytes, contentType: CONTENT_TYPE, extension: "txt" }, DISPOSITION);
    expect(file.save).toHaveBeenCalledTimes(1);
    const [data, options] = file.save.mock.calls[0] as unknown as [Buffer, Record<string, unknown>];
    expect(Buffer.compare(data, Buffer.from(bytes))).toBe(0);
    expect(options).toEqual({
      resumable: false,
      contentType: CONTENT_TYPE,
      metadata: { contentDisposition: DISPOSITION, cacheControl: "private, no-store" },
    });
    expect(options).not.toHaveProperty("predefinedAcl");
    expect(options).not.toHaveProperty("public");
    expect(JSON.stringify(options)).not.toContain("firebaseStorageDownloadTokens");
    expect(file.makePublic).not.toHaveBeenCalled();
  });
});

describe("storageEmulatorHost", () => {
  it("reads FIREBASE_STORAGE_EMULATOR_HOST first", () => {
    expect(
      storageEmulatorHost({ FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", STORAGE_EMULATOR_HOST: "http://x:1" }),
    ).toBe("127.0.0.1:9199");
  });

  it("strips the protocol from STORAGE_EMULATOR_HOST", () => {
    expect(storageEmulatorHost({ STORAGE_EMULATOR_HOST: "http://127.0.0.1:9199/" })).toBe("127.0.0.1:9199");
  });

  it.each([{}, { FIREBASE_STORAGE_EMULATOR_HOST: "" }, { STORAGE_EMULATOR_HOST: "  " }])(
    "is null outside the emulator (%j)",
    (env) => {
      expect(storageEmulatorHost(env)).toBeNull();
    },
  );
});

describe("downloadUrl", () => {
  const base = {
    bucketName: "matchline-dev.firebasestorage.app",
    path: "applications/app-1/asset-1.txt",
    disposition: DISPOSITION,
    contentType: CONTENT_TYPE,
    nowMs: NOW,
  };

  it("returns the emulator object URL and never signs under FIREBASE_STORAGE_EMULATOR_HOST", async () => {
    const file = stubFile();
    const out = await downloadUrl({ ...base, file, env: { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" } });
    expect(out).toEqual({
      url: "http://127.0.0.1:9199/matchline-dev.firebasestorage.app/applications/app-1/asset-1.txt",
      expiresAt: new Date(NOW + EXPORT_URL_TTL_MS).toISOString(),
      kind: "emulator",
    });
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });

  it("uses STORAGE_EMULATOR_HOST alone too", async () => {
    const file = stubFile();
    const out = await downloadUrl({ ...base, file, env: { STORAGE_EMULATOR_HOST: "http://localhost:9199" } });
    expect(out.url).toBe("http://localhost:9199/matchline-dev.firebasestorage.app/applications/app-1/asset-1.txt");
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });

  it("URI-encodes path segments in the emulator URL", async () => {
    const out = await downloadUrl({
      ...base,
      path: "applications/app 1/asset#1.txt",
      file: stubFile(),
      env: { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199" },
    });
    expect(out.url).toBe("http://127.0.0.1:9199/matchline-dev.firebasestorage.app/applications/app%201/asset%231.txt");
  });

  it("signs a 5-minute V4 read URL carrying the disposition outside the emulator", async () => {
    const file = stubFile("https://signed.example/obj?sig=1");
    const out = await downloadUrl({ ...base, file, env: {} });
    expect(file.getSignedUrl).toHaveBeenCalledTimes(1);
    expect(file.getSignedUrl).toHaveBeenCalledWith({
      version: "v4",
      action: "read",
      expires: NOW + 300_000,
      responseDisposition: DISPOSITION,
      responseType: CONTENT_TYPE,
    });
    expect(out).toEqual({
      url: "https://signed.example/obj?sig=1",
      expiresAt: "2026-10-29T12:05:00.000Z",
      kind: "signed",
    });
  });

  it.each([
    ["K_SERVICE", { K_SERVICE: "exportasset" }],
    ["K_REVISION", { K_REVISION: "exportasset-00001-abc" }],
    ["FUNCTION_TARGET", { FUNCTION_TARGET: "exportAsset" }],
  ])("refuses the emulator branch when %s marks a deployed runtime", async (_marker, markers) => {
    const file = stubFile();
    await expect(
      downloadUrl({ ...base, file, env: { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", ...markers } }),
    ).rejects.toBeInstanceOf(StorageEmulatorInDeployedRuntime);
    expect(file.getSignedUrl).not.toHaveBeenCalled();
    expect(file.makePublic).not.toHaveBeenCalled();
  });

  it("takes the emulator branch under the Functions emulator even with Cloud Run markers", async () => {
    const file = stubFile();
    const out = await downloadUrl({
      ...base,
      file,
      env: { FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199", FUNCTIONS_EMULATOR: "true", K_SERVICE: "exportasset" },
    });
    expect(out.kind).toBe("emulator");
    expect(file.getSignedUrl).not.toHaveBeenCalled();
  });

  it("still signs in a deployed runtime with no emulator host", async () => {
    const file = stubFile("https://signed.example/obj?sig=2");
    const out = await downloadUrl({ ...base, file, env: { K_SERVICE: "exportasset" } });
    expect(out).toMatchObject({ url: "https://signed.example/obj?sig=2", kind: "signed" });
  });

  it("propagates a signing failure instead of falling back to an unsigned URL", async () => {
    const file = stubFile();
    file.getSignedUrl.mockRejectedValueOnce(new Error("Cannot sign data without `client_email`."));
    await expect(downloadUrl({ ...base, file, env: {} })).rejects.toThrow(/client_email/);
    expect(file.makePublic).not.toHaveBeenCalled();
  });
});

describe("isDeployedRuntime", () => {
  it("is false for a plain process and under the Functions emulator", () => {
    expect(isDeployedRuntime({})).toBe(false);
    expect(isDeployedRuntime({ FUNCTIONS_EMULATOR: "true", K_SERVICE: "x", FUNCTION_TARGET: "y" })).toBe(false);
    expect(isDeployedRuntime({ K_SERVICE: "  " })).toBe(false);
  });

  it("is true when a Cloud Run / Functions marker is set without the emulator flag", () => {
    expect(isDeployedRuntime({ K_SERVICE: "exportasset" })).toBe(true);
    expect(isDeployedRuntime({ FUNCTION_TARGET: "exportAsset", FUNCTIONS_EMULATOR: "false" })).toBe(true);
  });
});
