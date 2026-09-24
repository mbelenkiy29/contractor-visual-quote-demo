import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { z } from "zod";
import {
  db,
  contractorProfilesTable,
  visualRequestsTable,
  type ContractorProfile,
  type VisualRequest,
} from "@workspace/db";
import {
  CreatePublicWidgetRedesignResponse,
  GetContractorProfileResponse,
  GetPublicWidgetProfileResponse,
  SubmitPublicWidgetRequestResponse,
  UpdateContractorProfileBody,
  UpdateContractorProfileResponse,
} from "@workspace/api-zod";
import { reserveRedesign } from "../lib/redesign-allowance";
import { removeRequestImage, storeRequestImage } from "../lib/private-request-images";
import { sendUseSendEmail } from "../lib/usesend-email";

const router: IRouter = Router();
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const rooms = ["kitchen", "bathroom", "living-room", "bedroom", "other"] as const;
const profileInput = z.object({
  companyName: z.string().trim().min(1).max(150),
  website: z.string().trim().max(500).refine((value) => value === "" || /^https?:\/\/\S+$/i.test(value), "Enter a valid http(s) website URL."),
  quoteEmail: z.string().trim().email().max(320),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
const redesignInput = z.object({
  roomType: z.enum(rooms),
  designBrief: z.string().trim().min(3).max(500),
});
const requestInput = z.object({
  roomType: z.enum(rooms),
  designBrief: z.string().trim().min(3).max(500),
  homeownerName: z.string().trim().min(1).max(150),
  homeownerEmail: z.string().trim().email().max(320),
  homeownerPhone: z.string().trim().max(100).default(""),
  homeownerNotes: z.string().trim().max(2000).default(""),
  redesignToken: z.string().min(20).max(4096),
  requestKey: z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2, fields: 9, parts: 11 },
}).fields([{ name: "image", maxCount: 1 }, { name: "original", maxCount: 1 }, { name: "redesign", maxCount: 1 }]);
const redesignLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "This preview has reached its hourly redesign limit. Please try again later." }),
});
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many quote requests from this connection. Please try again later." }),
});

type RoomType = typeof rooms[number];
type TokenClaims = {
  version: 1;
  tenantId: string;
  ownerId: string;
  roomType: RoomType;
  briefHash: string;
  originalHash: string;
  redesignHash: string;
  checklistHash: string;
  summaryHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function currentUser(req: Request, res: Response): string | null {
  const userId = getAuth(req).userId;
  if (!userId) res.status(401).json({ error: "Contractor sign-in required." });
  return userId;
}

async function getOrCreateProfile(ownerId: string): Promise<ContractorProfile> {
  const [existing] = await db.select().from(contractorProfilesTable).where(eq(contractorProfilesTable.ownerId, ownerId)).limit(1);
  if (existing) return existing;
  const id = randomUUID();
  await db.insert(contractorProfilesTable).values({ id, ownerId }).onConflictDoNothing({ target: contractorProfilesTable.ownerId });
  const [profile] = await db.select().from(contractorProfilesTable).where(eq(contractorProfilesTable.ownerId, ownerId)).limit(1);
  if (!profile) throw new Error("Unable to create contractor profile");
  return profile;
}

function filesFor(req: Request): { [field: string]: Express.Multer.File[] } {
  return (req.files ?? {}) as { [field: string]: Express.Multer.File[] };
}

function readMultipart(req: Request, res: Response): Promise<void> {
  return new Promise((resolve) => {
    upload(req, res, (error) => {
      if (!error) {
        resolve();
        return;
      }
      const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "Each room photo must be under 10 MB."
        : "The upload could not be read. Choose valid JPG, PNG, or WebP images.";
      res.status(400).json({ error: message });
      resolve();
    });
  });
}

async function normalizeImage(file: Express.Multer.File): Promise<Buffer> {
  const source = sharp(file.buffer, { failOn: "error", limitInputPixels: 40_000_000 }).rotate();
  const metadata = await source.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported image");
  return source.resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 8 }).toBuffer();
}

function derivedSecret(purpose: "redesign-token" | "homeowner-deletion"): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("SESSION_SECRET must contain at least 32 bytes");
  return createHmac("sha256", secret).update(`benchmark:${purpose}:v1`).digest();
}

function signClaims(claims: TokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", derivedSecret("redesign-token")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(token: string, allowExpired = false): TokenClaims | null {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = createHmac("sha256", derivedSecret("redesign-token")).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    if (claims.version !== 1 || (!allowExpired && claims.expiresAt < Date.now()) || claims.issuedAt > Date.now() + 30_000) return null;
    return claims;
  } catch {
    return null;
  }
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function makeChecklist(roomType: RoomType, brief: string): string[] {
  const byRoom: Record<RoomType, string[]> = {
    kitchen: [
      "Assess cabinet fronts, finish, hardware, and visible storage scope against the photo and brief.",
      "Review countertop, backsplash, sink, faucet, and appliance-finish categories only where visible or requested.",
      "Confirm any plumbing, electrical, or appliance relocation on site; the concept cannot establish hidden conditions.",
    ],
    bathroom: [
      "Assess visible tile, grout, wall finish, and flooring scope against the photo and brief.",
      "Review vanity, countertop, mirror, sink, and fixture-finish categories only where visible or requested.",
      "Confirm waterproofing, plumbing, ventilation, and any concealed conditions on site before defining scope.",
    ],
    bedroom: [
      "Assess visible flooring, wall finish, and paint scope against the photo and brief.",
      "Review storage, wardrobe, lighting, and window-treatment categories only where visible or requested.",
      "Confirm any built-in changes and electrical work on site before defining scope.",
    ],
    "living-room": [
      "Assess visible flooring, wall finish, and paint scope against the photo and brief.",
      "Review lighting, built-ins, storage, and window-treatment categories only where visible or requested.",
      "Confirm any electrical or built-in changes on site before defining scope.",
    ],
    other: [
      "Identify visible surfaces and finishes that the brief asks to change.",
      "Review fixture, storage, and lighting categories only where visible or requested.",
      "Confirm room conditions and any concealed work on site before defining scope.",
    ],
  };
  const requirements = brief.split(/[.;\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 5);
  const grounded = requirements.map((item) => `Confirm the requested detail: ${item.slice(0, 200)}`);
  grounded.unshift(...byRoom[roomType]);
  grounded.push("Review the concept alongside the supplied room photo and confirm the existing layout on site.");
  grounded.push("Confirm actual measurements and any material selections before preparing a quote.");
  return [...new Set(grounded)].slice(0, 10);
}

function makeDesignSummary(roomType: RoomType, brief: string): string {
  return `A ${roomType.replace("-", " ")} concept based on the homeowner's brief: ${brief}`;
}

function encryptDeletionToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedSecret("homeowner-deletion"), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptDeletionToken(serialized: string): string | null {
  try {
    const [ivText, tagText, ciphertextText, extra] = serialized.split(".");
    if (!ivText || !tagText || !ciphertextText || extra !== undefined) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedSecret("homeowner-deletion"),
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const token = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

async function assertRoomPhoto(apiKey: string, image: Buffer): Promise<boolean> {
  const openai = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Classify only whether this image visibly depicts an indoor residential room or interior space suitable for a room redesign. Return JSON only: {\"isRoomPhoto\": boolean}. Do not infer unseen spaces. Set false for portraits, documents, products, landscapes, and non-room images." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.toString("base64")}`, detail: "low" } },
      ],
    }],
  });
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("Image preflight returned no classification");
  const parsed = z.object({ isRoomPhoto: z.boolean() }).safeParse(JSON.parse(content));
  if (!parsed.success) throw new Error("Image preflight returned an invalid classification");
  return parsed.data.isRoomPhoto;
}

function promptFor(roomType: string, brief: string): string {
  return [
    `Photorealistically redesign this ${roomType.replace("-", " ")} according to the homeowner's design brief: ${brief}.`,
    "Treat the uploaded photograph as the exact source scene, not loose inspiration.",
    "Preserve the camera position, crop, room dimensions, wall geometry, floor plan, doors, windows, openings, and all major architectural structure.",
    "Do not add, remove, move, widen, or shrink windows, doors, walls, columns, stairs, or built-in openings.",
    "Only change finishes, colors, lighting fixtures, cabinetry faces, furnishings, and decor requested or implied by the brief.",
    "Keep materials realistic and suitable as an early contractor conversation concept.",
    "Do not include text, labels, people, watermarks, split screens, or before-and-after framing.",
  ].join(" ");
}

async function editRoomImage(apiKey: string, original: Buffer, roomType: string, brief: string): Promise<Buffer> {
  const metadata = await sharp(original).metadata();
  const size = (metadata.width ?? 0) >= (metadata.height ?? 0) ? "1536x1024" : "1024x1536";
  const openai = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 0 });
  const image = await toFile(original, "room.png", { type: "image/png" });
  const result = await openai.images.edit({
    model: "gpt-image-1",
    image,
    prompt: promptFor(roomType, brief),
    size,
    quality: "medium",
    output_format: "png",
  }, { signal: AbortSignal.timeout(120_000) });
  const encoded = result.data?.[0]?.b64_json;
  if (!encoded) throw new Error("Image provider returned no concept");
  return Buffer.from(encoded, "base64");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

async function sendRequestEmail(
  profile: ContractorProfile,
  input: z.infer<typeof requestInput>,
  original: Buffer,
  redesign: Buffer,
  referenceId: string,
  checklist: string[],
  summary: string,
  providerIdempotencyKey: string,
) {
  const apiKey = process.env.USESEND_API_KEY?.trim();
  const from = process.env.USESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from || !z.string().email().safeParse(from).success) {
    return { configured: false as const, accepted: false as const, definiteFailure: true, providerMessageId: null };
  }
  const safeCompany = escapeHtml(profile.companyName);
  const safeName = escapeHtml(input.homeownerName);
  const safeEmail = escapeHtml(input.homeownerEmail);
  const safePhone = escapeHtml(input.homeownerPhone || "Not provided");
  const safeNotes = escapeHtml(input.homeownerNotes || "None provided");
  const safeBrief = escapeHtml(input.designBrief);
  const safeRoom = escapeHtml(input.roomType.replace("-", " "));
  const safeSummary = escapeHtml(summary);
  const checklistHtml = checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const checklistText = checklist.map((item) => `- ${item}`).join("\n");
  return sendUseSendEmail({
    apiKey,
    idempotencyKey: providerIdempotencyKey,
    message: {
      from,
      to: [profile.quoteEmail],
      replyTo: input.homeownerEmail,
      subject: "New Benchmark visual quote request",
      html: `<h2>New visual quote request</h2><p>For ${safeCompany}</p><p><strong>Homeowner:</strong> ${safeName}<br><strong>Email:</strong> ${safeEmail}<br><strong>Phone:</strong> ${safePhone}</p><p><strong>Room:</strong> ${safeRoom}</p><p><strong>Design summary:</strong><br>${safeSummary}</p><p><strong>Design brief:</strong><br>${safeBrief.replace(/\n/g, "<br>")}</p><p><strong>Contractor checklist (verify on site):</strong></p><ul>${checklistHtml}</ul><p><strong>Additional notes:</strong><br>${safeNotes.replace(/\n/g, "<br>")}</p><p>Original room photo and redesign concept are attached. Reference: ${referenceId}</p>`,
      text: `New visual quote request for ${profile.companyName}\nHomeowner: ${input.homeownerName}\nEmail: ${input.homeownerEmail}\nPhone: ${input.homeownerPhone || "Not provided"}\nRoom: ${input.roomType}\nDesign summary: ${summary}\nBrief: ${input.designBrief}\nContractor checklist (verify on site):\n${checklistText}\nAdditional notes: ${input.homeownerNotes || "None provided"}\nReference: ${referenceId}`,
      attachments: [
        { filename: "original-room.png", content: original.toString("base64") },
        { filename: "redesign-concept.png", content: redesign.toString("base64") },
      ],
    },
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

router.get("/contractor-profile", async (req, res): Promise<void> => {
  const ownerId = currentUser(req, res);
  if (!ownerId) return;
  const profile = await getOrCreateProfile(ownerId);
  res.json(GetContractorProfileResponse.parse({
    id: profile.id,
    companyName: profile.companyName,
    website: profile.website,
    quoteEmail: profile.quoteEmail,
    accentColor: profile.accentColor,
  }));
});

router.put("/contractor-profile", async (req, res): Promise<void> => {
  const ownerId = currentUser(req, res);
  if (!ownerId) return;
  const parsed = UpdateContractorProfileBody.safeParse(req.body);
  const validInput = profileInput.safeParse(req.body);
  if (!parsed.success || !validInput.success) {
    res.status(400).json({ error: "Enter a company name, valid quote email and website URL, and a six-digit accent color." });
    return;
  }
  const profile = await getOrCreateProfile(ownerId);
  const [updated] = await db.update(contractorProfilesTable)
    .set(validInput.data)
    .where(and(eq(contractorProfilesTable.id, profile.id), eq(contractorProfilesTable.ownerId, ownerId)))
    .returning();
  res.json(UpdateContractorProfileResponse.parse({
    id: updated.id,
    companyName: updated.companyName,
    website: updated.website,
    quoteEmail: updated.quoteEmail,
    accentColor: updated.accentColor,
  }));
});

router.get("/widget/:id", async (req, res): Promise<void> => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.sendStatus(404); return; }
  const [profile] = await db.select().from(contractorProfilesTable).where(eq(contractorProfilesTable.id, id.data)).limit(1);
  if (!profile) { res.sendStatus(404); return; }
  res.set("Cache-Control", "public, max-age=60");
  res.json(GetPublicWidgetProfileResponse.parse({ id: profile.id, companyName: profile.companyName, accentColor: profile.accentColor }));
});

router.post("/widget/:id/redesign", redesignLimiter, async (req, res): Promise<void> => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.sendStatus(404); return; }
  const [profile] = await db.select().from(contractorProfilesTable).where(eq(contractorProfilesTable.id, id.data)).limit(1);
  if (!profile) { res.sendStatus(404); return; }
  try { derivedSecret("redesign-token"); } catch {
    req.log.error("Benchmark redesign token signing is not configured");
    res.status(503).json({ error: "Public redesign verification is not configured yet. Please contact the site owner." });
    return;
  }
  await readMultipart(req, res);
  if (res.headersSent) return;
  const parsed = redesignInput.safeParse(req.body);
  const image = filesFor(req).image?.[0];
  if (!parsed.success || !image) {
    res.status(400).json({ error: "Add a room photo and a short design brief before creating a redesign." });
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    req.log.error("Public room redesign provider is not configured");
    res.status(503).json({ error: "Room redesign is not configured yet. Please contact the site owner." });
    return;
  }
  let original: Buffer;
  try {
    original = await normalizeImage(image);
  } catch {
    res.status(400).json({ error: "Choose a valid JPG, PNG, or WebP room photo." });
    return;
  }
  const exhausted = await reserveRedesign(profile.ownerId);
  if (exhausted) {
    res.status(429).json({ error: `${exhausted.exhaustedReason} Resets ${new Date(exhausted.resetsAt).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" })}.` });
    return;
  }
  let isRoom: boolean;
  try {
    isRoom = await assertRoomPhoto(apiKey, original);
  } catch (error) {
    req.log.error({ failure: errorText(error) }, "Room photo classification failed");
    res.status(502).json({ error: "The room photo could not be checked right now. Please try again shortly." });
    return;
  }
  if (!isRoom) {
    res.status(400).json({ error: "This does not appear to be an indoor room photo. Choose a clear kitchen, bathroom, bedroom, or living-space photo." });
    return;
  }
  try {
    const redesign = await editRoomImage(apiKey, original, parsed.data.roomType, parsed.data.designBrief);
    const now = Date.now();
    const checklist = makeChecklist(parsed.data.roomType, parsed.data.designBrief);
    const summary = makeDesignSummary(parsed.data.roomType, parsed.data.designBrief);
    const token = signClaims({
      version: 1,
      tenantId: profile.id,
      ownerId: profile.ownerId,
      roomType: parsed.data.roomType,
      briefHash: sha256(parsed.data.designBrief),
      originalHash: sha256(original),
      redesignHash: sha256(redesign),
      checklistHash: sha256(JSON.stringify(checklist)),
      summaryHash: sha256(summary),
      issuedAt: now,
      expiresAt: now + 60 * 60 * 1000,
      nonce: randomUUID(),
    });
    res.json(CreatePublicWidgetRedesignResponse.parse({
      imageBase64: redesign.toString("base64"),
      mimeType: "image/png",
      checklist,
      designSummary: summary,
      redesignToken: token,
    }));
  } catch (error) {
    req.log.error({ failure: errorText(error) }, "Public room redesign failed");
    res.status(502).json({ error: "The room redesign could not be created. Please check the photo and try again." });
  }
});

router.post("/widget/:id/requests", requestLimiter, async (req, res): Promise<void> => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.sendStatus(404); return; }
  const [profile] = await db.select().from(contractorProfilesTable).where(eq(contractorProfilesTable.id, id.data)).limit(1);
  if (!profile) { res.sendStatus(404); return; }
  try {
    derivedSecret("redesign-token");
    derivedSecret("homeowner-deletion");
  } catch {
    req.log.error("Benchmark redesign token verification is not configured");
    res.status(503).json({ error: "Public redesign verification is not configured yet. Please contact the site owner." });
    return;
  }
  await readMultipart(req, res);
  if (res.headersSent) return;
  const parsed = requestInput.safeParse(req.body);
  const files = filesFor(req);
  if (!parsed.success || !files.original?.[0] || !files.redesign?.[0]) {
    res.status(400).json({ error: "Add the original photo, redesign concept, and valid contact details." });
    return;
  }
  if (!profile.quoteEmail || !z.string().email().safeParse(profile.quoteEmail).success) {
    res.status(503).json({ error: "This contractor has not configured a valid quote recipient." });
    return;
  }
  const sendEmailApiKey = process.env.USESEND_API_KEY?.trim();
  const sender = process.env.USESEND_FROM_EMAIL?.trim();
  if (!sendEmailApiKey || !sender || !z.string().email().safeParse(sender).success) {
    res.status(503).json({ error: "Quote email provider credentials or verified sender identity are not configured. Please contact the site owner." });
    return;
  }
  let original: Buffer;
  let redesign: Buffer;
  try {
    [original, redesign] = await Promise.all([normalizeImage(files.original[0]), normalizeImage(files.redesign[0])]);
  } catch {
    res.status(400).json({ error: "Choose valid JPG, PNG, or WebP original and redesign images." });
    return;
  }
  const input = parsed.data;
  const checklist = makeChecklist(input.roomType, input.designBrief);
  const summary = makeDesignSummary(input.roomType, input.designBrief);
  const tokenHash = sha256(input.redesignToken);
  const contentHash = sha256(JSON.stringify({
    roomType: input.roomType,
    designBrief: input.designBrief,
    homeownerName: input.homeownerName,
    homeownerEmail: input.homeownerEmail,
    homeownerPhone: input.homeownerPhone,
    homeownerNotes: input.homeownerNotes,
    originalHash: sha256(original),
    redesignHash: sha256(redesign),
  }));
  const [existing] = await db.select().from(visualRequestsTable).where(and(
    eq(visualRequestsTable.contractorId, profile.ownerId),
    eq(visualRequestsTable.requestKey, input.requestKey),
  )).limit(1);
  if (existing) {
    if (existing.idempotencyHash !== contentHash) {
      res.status(409).json({ error: "This request key was already used for different request details." });
      return;
    }
    if (existing.emailStatus === "accepted") {
      const deletionToken = existing.deletionTokenCiphertext
        ? decryptDeletionToken(existing.deletionTokenCiphertext)
        : null;
      if (!deletionToken) {
        req.log.error({ requestId: existing.id }, "Unable to recover accepted request deletion token");
        res.status(503).json({ error: "The accepted request could not be recovered securely. Please contact the contractor." });
        return;
      }
      res.json(SubmitPublicWidgetRequestResponse.parse({
        referenceId: existing.id,
        requestId: existing.id,
        deletionToken,
      }));
      return;
    }
    if (existing.redesignTokenHash !== tokenHash) {
      res.status(400).json({ error: "The redesign verification token does not match this pending request. Create a new redesign." });
      return;
    }
  }
  const claims = verifyToken(
    input.redesignToken,
    Boolean(existing && existing.emailStatus !== "accepted"),
  );
  if (
    !claims || claims.tenantId !== profile.id || claims.ownerId !== profile.ownerId
    || claims.roomType !== input.roomType || claims.briefHash !== sha256(input.designBrief)
    || claims.originalHash !== sha256(original) || claims.redesignHash !== sha256(redesign)
    || claims.checklistHash !== sha256(JSON.stringify(checklist))
    || claims.summaryHash !== sha256(summary)
  ) {
    res.status(400).json({ error: "The redesign verification token does not match this contractor, room photo, concept, design brief, or server-generated checklist. Create a new redesign." });
    return;
  }

  let requestRow: VisualRequest | undefined = existing;
  const savedPaths: string[] = [];
  if (!requestRow) {
    const referenceId = randomUUID();
    const deletionToken = randomBytes(32).toString("hex");
    try {
      const originalPath = await storeRequestImage(referenceId, "original", original);
      savedPaths.push(originalPath);
      const redesignPath = await storeRequestImage(referenceId, "redesign", redesign);
      savedPaths.push(redesignPath);
      const [inserted] = await db.insert(visualRequestsTable).values({
        id: referenceId,
        contractorId: profile.ownerId,
        roomType: input.roomType,
        designBrief: input.designBrief,
        homeownerName: input.homeownerName,
        homeownerEmail: input.homeownerEmail,
        homeownerPhone: input.homeownerPhone,
        homeownerNotes: input.homeownerNotes,
        originalPath,
        redesignPath,
        deletionTokenHash: sha256(deletionToken),
        deletionTokenCiphertext: encryptDeletionToken(deletionToken),
        emailStatus: "pending",
        requestKey: input.requestKey,
        idempotencyHash: contentHash,
        redesignTokenHash: tokenHash,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      }).returning();
      requestRow = inserted;
    } catch (error) {
      await Promise.allSettled(savedPaths.map(removeRequestImage));
      const [raced] = await db.select().from(visualRequestsTable).where(and(
        eq(visualRequestsTable.contractorId, profile.ownerId),
        eq(visualRequestsTable.requestKey, input.requestKey),
      )).limit(1);
      if (raced?.idempotencyHash === contentHash && raced.emailStatus === "accepted") {
        const deletionToken = raced.deletionTokenCiphertext
          ? decryptDeletionToken(raced.deletionTokenCiphertext)
          : null;
        if (deletionToken) {
          res.json(SubmitPublicWidgetRequestResponse.parse({
            referenceId: raced.id,
            requestId: raced.id,
            deletionToken,
          }));
        } else {
          res.status(503).json({ error: "The accepted request could not be recovered securely. Please contact the contractor." });
        }
        return;
      }
      if (raced?.idempotencyHash === contentHash && raced.emailStatus !== "accepted" && raced.redesignTokenHash === tokenHash) {
        requestRow = raced;
      } else if (raced) {
        res.status(409).json({ error: "This request key is already being processed or was used with different details." });
        return;
      } else if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
        res.status(400).json({ error: "This redesign token has already been used. Create a new redesign." });
        return;
      } else {
        req.log.error({ failure: errorText(error) }, "Unable to save widget quote request");
        res.status(503).json({ error: "The quote request could not be saved. Please try again." });
        return;
      }
    }
  }
  if (!requestRow) {
    res.status(503).json({ error: "The quote request could not be saved. Please try again." });
    return;
  }

  const respondIfAccepted = (row: VisualRequest | undefined): boolean => {
    if (row?.emailStatus !== "accepted") return false;
    const deletionToken = row.deletionTokenCiphertext
      ? decryptDeletionToken(row.deletionTokenCiphertext)
      : null;
    if (!deletionToken) {
      req.log.error({ requestId: row.id }, "Unable to recover accepted request deletion token");
      res.status(503).json({ error: "The accepted request could not be recovered securely. Please contact the contractor." });
      return true;
    }
    res.json(SubmitPublicWidgetRequestResponse.parse({
      referenceId: row.id,
      requestId: row.id,
      deletionToken,
    }));
    return true;
  };

  if (requestRow.emailAttemptedAt && Date.now() - requestRow.emailAttemptedAt.getTime() > 23 * 60 * 60 * 1000) {
    res.status(409).json({ error: "The email outcome is still uncertain and the safe provider retry window has passed. Do not submit a new request key; contact the contractor to reconcile this request." });
    return;
  }

  const referenceId = requestRow.id;
  const providerIdempotencyKey = sha256(`${profile.id}:${input.requestKey}`);
  const leaseStartedAt = new Date();
  const leaseUntil = new Date(leaseStartedAt.getTime() + 3 * 60 * 1000);
  const [leasedRow] = await db.update(visualRequestsTable)
    .set({
      emailAttemptedAt: sql`COALESCE(${visualRequestsTable.emailAttemptedAt}, ${leaseStartedAt})`,
      emailAttemptLeaseUntil: leaseUntil,
    })
    .where(and(
      eq(visualRequestsTable.id, referenceId),
      eq(visualRequestsTable.emailStatus, "pending"),
      or(
        isNull(visualRequestsTable.emailAttemptLeaseUntil),
        lte(visualRequestsTable.emailAttemptLeaseUntil, leaseStartedAt),
      ),
    ))
    .returning();
  if (!leasedRow) {
    const [refreshed] = await db.select().from(visualRequestsTable).where(eq(visualRequestsTable.id, referenceId)).limit(1);
    if (respondIfAccepted(refreshed)) return;
    if (!refreshed) {
      res.status(503).json({ error: "The request state could not be safely recovered. Please retry with the same request key." });
      return;
    }
    if (refreshed.emailAttemptedAt && Date.now() - refreshed.emailAttemptedAt.getTime() > 23 * 60 * 60 * 1000) {
      res.status(409).json({ error: "The email outcome is still uncertain and the safe provider retry window has passed. Do not submit a new request key; contact the contractor to reconcile this request." });
      return;
    }
    res.status(409).json({ error: "This request is already being processed. Retry the identical request with the same request key." });
    return;
  }
  requestRow = leasedRow;
  const attemptedAt = leasedRow.emailAttemptedAt;
  if (!attemptedAt || Date.now() - attemptedAt.getTime() > 23 * 60 * 60 * 1000) {
    await db.update(visualRequestsTable)
      .set({ emailAttemptLeaseUntil: null })
      .where(and(
        eq(visualRequestsTable.id, referenceId),
        eq(visualRequestsTable.emailStatus, "pending"),
        eq(visualRequestsTable.emailAttemptLeaseUntil, leaseUntil),
      ));
    res.status(409).json({ error: "The email outcome is still uncertain and the safe provider retry window has passed. Do not submit a new request key; contact the contractor to reconcile this request." });
    return;
  }

  const releaseLease = async () => {
    await db.update(visualRequestsTable)
      .set({ emailAttemptLeaseUntil: null })
      .where(and(
        eq(visualRequestsTable.id, referenceId),
        eq(visualRequestsTable.emailStatus, "pending"),
        eq(visualRequestsTable.emailAttemptLeaseUntil, leaseUntil),
      ));
  };
  const deletePendingUnderLease = async (): Promise<boolean> => {
    const [deleted] = await db.delete(visualRequestsTable)
      .where(and(
        eq(visualRequestsTable.id, referenceId),
        eq(visualRequestsTable.emailStatus, "pending"),
        eq(visualRequestsTable.emailAttemptLeaseUntil, leaseUntil),
      ))
      .returning({
        originalPath: visualRequestsTable.originalPath,
        redesignPath: visualRequestsTable.redesignPath,
      });
    if (!deleted) return false;
    const paths = new Set([deleted.originalPath, deleted.redesignPath, ...savedPaths]);
    await Promise.allSettled([...paths].map(removeRequestImage));
    return true;
  };
  const email = await sendRequestEmail(
    profile,
    input,
    original,
    redesign,
    referenceId,
    checklist,
    summary,
    providerIdempotencyKey,
  );
  if (!email.configured) {
    const deleted = await deletePendingUnderLease();
    if (!deleted) {
      const [refreshed] = await db.select().from(visualRequestsTable).where(eq(visualRequestsTable.id, referenceId)).limit(1);
      if (respondIfAccepted(refreshed)) return;
      await releaseLease();
    }
    res.status(503).json({ error: "Quote email sender identity is not configured. Please contact the site owner." });
    return;
  }
  if (!email.accepted) {
    if (email.definiteFailure) {
      const deleted = await deletePendingUnderLease();
      if (!deleted) {
        const [refreshed] = await db.select().from(visualRequestsTable).where(eq(visualRequestsTable.id, referenceId)).limit(1);
        if (respondIfAccepted(refreshed)) return;
      }
    } else {
      try {
        await releaseLease();
      } catch (error) {
        req.log.error({ failure: errorText(error), requestId: referenceId }, "Unable to release ambiguous email attempt lease");
      }
    }
    req.log.error({ failure: "email-not-accepted" }, "Widget quote email was not accepted");
    res.status(502).json({
      error: email.definiteFailure
        ? "The email provider rejected this request. No confirmation was issued; retry using the same request key."
        : "The email outcome is uncertain. Retry the identical request with the same request key within 23 hours; do not create a new key.",
    });
    return;
  }
  let acceptedRow: VisualRequest | undefined;
  try {
    [acceptedRow] = await db.update(visualRequestsTable)
      .set({
        emailStatus: "accepted",
        emailAttemptLeaseUntil: null,
        emailProviderMessageId: email.providerMessageId,
      })
      .where(and(
        eq(visualRequestsTable.id, referenceId),
        eq(visualRequestsTable.emailStatus, "pending"),
      ))
      .returning();
  } catch (error) {
    req.log.error({ failure: errorText(error), requestId: referenceId }, "Email accepted but request state update failed");
  }
  if (!acceptedRow) {
    const [refreshed] = await db.select().from(visualRequestsTable).where(eq(visualRequestsTable.id, referenceId)).limit(1);
    acceptedRow = refreshed;
  }
  if (respondIfAccepted(acceptedRow)) return;
  if (acceptedRow?.emailStatus !== "accepted") {
    res.status(503).json({ error: "The email may have been accepted, but the request state is not confirmed. Retry the identical request with the same request key within 23 hours; no confirmation has been issued." });
    return;
  }
});

export default router;