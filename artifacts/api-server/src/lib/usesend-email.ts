export type UseSendMessage = {
  from: string;
  to: string[];
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  attachments: Array<{ filename: string; content: string }>;
};

export type UseSendEmailResult = {
  configured: boolean;
  accepted: boolean;
  definiteFailure: boolean;
  providerMessageId: string | null;
};

type SendUseSendEmailOptions = {
  apiKey: string | undefined;
  message: UseSendMessage;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
};

const USESEND_EMAILS_URL = "https://app.usesend.com/api/v1/emails";

export async function sendUseSendEmail({
  apiKey,
  message,
  idempotencyKey,
  fetchImpl = fetch,
}: SendUseSendEmailOptions): Promise<UseSendEmailResult> {
  const token = apiKey?.trim();
  const from = message.from.trim();
  if (!token || !from) {
    return { configured: false, accepted: false, definiteFailure: true, providerMessageId: null };
  }

  try {
    const response = await fetchImpl(USESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ ...message, from }),
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status !== 200) {
      const definiteFailure = response.status >= 400
        && response.status < 500
        && ![408, 409, 425, 429].includes(response.status);
      return { configured: true, accepted: false, definiteFailure, providerMessageId: null };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return { configured: true, accepted: false, definiteFailure: false, providerMessageId: null };
    }
    if (
      typeof responseBody === "object"
      && responseBody !== null
      && "emailId" in responseBody
      && typeof responseBody.emailId === "string"
      && responseBody.emailId.length > 0
    ) {
      return {
        configured: true,
        accepted: true,
        definiteFailure: false,
        providerMessageId: responseBody.emailId,
      };
    }
    return { configured: true, accepted: false, definiteFailure: false, providerMessageId: null };
  } catch {
    return { configured: true, accepted: false, definiteFailure: false, providerMessageId: null };
  }
}