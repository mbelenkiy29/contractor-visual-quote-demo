import { afterEach, describe, expect, it, vi } from "vitest";
import { sendUseSendEmail } from "../src/lib/usesend-email";

const apiKey = "test-only-use-send-key";
const idempotencyKey = "stable-request-key";
const message = {
  from: "quotes@example.com",
  to: ["contractor@example.com"],
  replyTo: "homeowner@example.net",
  subject: "New Benchmark visual quote request",
  html: "<p>Quote request</p>",
  text: "Quote request",
  attachments: [
    { filename: "original-room.png", content: Buffer.from("original").toString("base64") },
    { filename: "redesign-concept.png", content: Buffer.from("redesign").toString("base64") },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("useSend email adapter", () => {
  it("sends the documented wire format and accepts only an emailId response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ emailId: "email_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendUseSendEmail({ apiKey, message, idempotencyKey });

    expect(result).toEqual({
      configured: true,
      accepted: true,
      definiteFailure: false,
      providerMessageId: "email_123",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.usesend.com/api/v1/emails");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual(message);
  });

  it("treats processing and NOT_UNIQUE 409 responses as ambiguous, not definite rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "NOT_UNIQUE" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "still processing" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await sendUseSendEmail({ apiKey, message, idempotencyKey });
    const retry = await sendUseSendEmail({ apiKey, message, idempotencyKey });

    expect(first).toMatchObject({ configured: true, accepted: false, definiteFailure: false });
    expect(retry).toMatchObject({ configured: true, accepted: false, definiteFailure: false });
    expect(fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"]))
      .toEqual([idempotencyKey, idempotencyKey]);
  });

  it("does not confirm a 200 response that omits the documented emailId", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "not-the-useSend-contract" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendUseSendEmail({ apiKey, message, idempotencyKey }))
      .toMatchObject({ configured: true, accepted: false, definiteFailure: false, providerMessageId: null });
  });

  it("keeps server/transport failures ambiguous but identifies a definite client rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("provider error", { status: 503 }))
      .mockResolvedValueOnce(new Response("invalid message", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendUseSendEmail({ apiKey, message, idempotencyKey }))
      .toMatchObject({ accepted: false, definiteFailure: false });
    expect(await sendUseSendEmail({ apiKey, message, idempotencyKey }))
      .toMatchObject({ accepted: false, definiteFailure: true });
  });

  it("refuses to call the provider without credentials or a sender", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendUseSendEmail({ apiKey: "", message, idempotencyKey }))
      .toMatchObject({ configured: false, accepted: false, definiteFailure: true });
    expect(await sendUseSendEmail({ apiKey, message: { ...message, from: "" }, idempotencyKey }))
      .toMatchObject({ configured: false, accepted: false, definiteFailure: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});