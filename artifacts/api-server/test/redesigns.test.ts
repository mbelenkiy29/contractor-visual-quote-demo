import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import sharp from "sharp";
import { createRedesignRouter } from "../src/routes/redesigns";

const apiKey = "test-secret-never-log";
const output = Buffer.from("deterministic edited image").toString("base64");
let server: Server;
let origin: string;
let logLines: string[];
let edit: ReturnType<typeof vi.fn>;
let reserve: ReturnType<typeof vi.fn>;
let source: Buffer;

function upload(user = "contractor-a", file = source, name = "room.jpg") {
  const body = new FormData();
  body.append("roomType", "kitchen");
  body.append("designBrief", "Light oak cabinets and stone surfaces");
  body.append("image", new Blob([new Uint8Array(file)], { type: "image/jpeg" }), name);
  return fetch(`${origin}/api/redesigns`, { method: "POST", headers: { "x-test-user": user }, body });
}

beforeEach(async () => {
  logLines = [];
  source = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#bdaa90" } }).jpeg().toBuffer();
  edit = vi.fn().mockResolvedValue(output);
  reserve = vi.fn().mockResolvedValue(null);
  const app = express();
  app.use((req, _res, next) => {
    // Keep raw log output so the assertions can catch accidental secret leakage.
    req.log = { error: (...args: unknown[]) => { logLines.push(JSON.stringify(args)); } } as typeof req.log;
    next();
  });
  app.use("/api", createRedesignRouter({
    userId: req => req.header("x-test-user") ?? null,
    reserve,
    allowance: async () => ({ remaining: 3, limit: 3, resetsAt: "2027-01-01T00:00:00.000Z", exhaustedReason: null }),
    edit,
    apiKey: () => apiKey,
  }));
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("POST /api/redesigns (offline provider)", () => {
  it("normalizes a valid photo and returns the edited image without leaking keys or bytes to logs", async () => {
    const response = await upload();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imageBase64: output, mimeType: "image/png" });
    expect(reserve).toHaveBeenCalledWith("contractor-a");
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0][0]).toMatchObject({ apiKey, size: "1536x1024" });
    expect(await sharp(edit.mock.calls[0][0].data).metadata()).toMatchObject({ format: "png", width: 32, height: 24 });
    expect(JSON.stringify(logLines)).not.toContain(apiKey);
    expect(JSON.stringify(logLines)).not.toContain(source.toString("base64"));
    expect(JSON.stringify(logLines)).not.toContain(output);
  });

  it("rejects missing auth, corrupt images, unsupported formats, and oversized files without invoking the provider", async () => {
    expect((await upload("", source)).status).toBe(401);
    const corrupt = await upload("contractor-a", Buffer.from("not-a-photo"), "fake.jpg");
    expect(corrupt.status).toBe(400);
    const gif = await sharp(source).gif().toBuffer();
    const unsupported = await upload("contractor-a", gif, "room.gif");
    expect(unsupported.status).toBe(400);
    const oversized = await upload("contractor-a", Buffer.alloc(10 * 1024 * 1024 + 1), "huge.jpg");
    expect(oversized.status).toBe(400);
    const missing = new FormData();
    missing.append("roomType", "kitchen");
    missing.append("designBrief", "Oak cabinets");
    expect((await fetch(`${origin}/api/redesigns`, {
      method: "POST", headers: { "x-test-user": "contractor-a" }, body: missing,
    })).status).toBe(400);
    expect(edit).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("maps provider timeout and failure to safe errors, never logging provider payloads", async () => {
    edit.mockRejectedValueOnce(Object.assign(new Error(`timed out: ${apiKey} ${source.toString("base64")}`), { name: "TimeoutError" }));
    const timeout = await upload();
    expect(timeout.status).toBe(504);
    expect((await timeout.json()).error).toMatch(/took too long/);
    edit.mockRejectedValueOnce(new Error(`provider payload ${apiKey} ${output}`));
    const failure = await upload();
    expect(failure.status).toBe(502);
    expect((await failure.json()).error).toMatch(/could not create/);
    expect(JSON.stringify(logLines)).not.toContain(apiKey);
    expect(JSON.stringify(logLines)).not.toContain(source.toString("base64"));
    expect(JSON.stringify(logLines)).not.toContain(output);
  });

  it("limits concurrent work per user and across users, then releases slots after completion", async () => {
    const releases: Array<(value: string) => void> = [];
    edit.mockImplementation(() => new Promise<string>(resolve => { releases.push(resolve); }));
    const first = upload("a");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    expect((await upload("a")).status).toBe(429);
    const second = upload("b");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect((await upload("c")).status).toBe(429);
    expect(reserve).toHaveBeenCalledTimes(2);
    releases.forEach(release => release(output));
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    edit.mockResolvedValue(output);
    expect((await upload("a")).status).toBe(200);
  });

  it("enforces the hourly request cap and exhausted allowance", async () => {
    for (let i = 0; i < 5; i++) expect((await upload()).status).toBe(200);
    expect((await upload()).status).toBe(429);
    reserve.mockResolvedValueOnce({ remaining: 0, limit: 3, resetsAt: "2027-01-01T00:00:00.000Z", exhaustedReason: "Monthly allowance reached." });
    const exhausted = await upload("another-user");
    expect(exhausted.status).toBe(429);
    expect(edit).toHaveBeenCalledTimes(5);
  });
});