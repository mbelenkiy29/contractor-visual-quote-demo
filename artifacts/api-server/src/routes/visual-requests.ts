import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, lt, gt } from "drizzle-orm";
import multer from "multer";
import sharp from "sharp";
import { z } from "zod";
import { db, visualRequestsTable, type VisualRequest } from "@workspace/db";
import { removeRequestImage, storeRequestImage, streamRequestImage } from "../lib/private-request-images";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use("/visual-requests", (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});
const idSchema = z.string().uuid();
const inputSchema = z.object({
  roomType: z.enum(["kitchen", "bathroom", "living-room", "bedroom", "other"]),
  designBrief: z.string().trim().min(3).max(500),
  homeownerName: z.string().trim().min(1).max(150),
  homeownerEmail: z.string().trim().email().max(320),
  homeownerPhone: z.string().max(100).default(""),
  homeownerNotes: z.string().max(2000).default(""),
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2, fields: 6 } }).fields([{ name: "original", maxCount: 1 }, { name: "redesign", maxCount: 1 }]);

function owner(req: Request, res: Response) {
  const id = getAuth(req).userId;
  if (!id) res.status(401).json({ error: "Contractor sign-in required." });
  return id;
}

function response(row: VisualRequest) {
  return {
    id: row.id, roomType: row.roomType, designBrief: row.designBrief,
    homeownerName: row.homeownerName, homeownerEmail: row.homeownerEmail,
    homeownerPhone: row.homeownerPhone, homeownerNotes: row.homeownerNotes,
    originalImageUrl: `/api/visual-requests/${row.id}/images/original`,
    redesignImageUrl: `/api/visual-requests/${row.id}/images/redesign`,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  };
}

async function deleteRequest(row: VisualRequest) {
  await Promise.all([removeRequestImage(row.originalPath), removeRequestImage(row.redesignPath)]);
  await db.delete(visualRequestsTable).where(eq(visualRequestsTable.id, row.id));
}

// Expired data is never served. A daily sweep removes both objects and the row;
// failures leave the row in place for the next retry, but do not expose it.
async function purgeExpired() {
  const expired = await db.select().from(visualRequestsTable).where(lt(visualRequestsTable.expiresAt, new Date()));
  for (const row of expired) {
    try { await deleteRequest(row); }
    catch (error) { logger.error({ err: error, requestId: row.id }, "Unable to purge expired visual request"); }
  }
}
const sweep = () => void purgeExpired().catch((error) => logger.error({ err: error }, "Visual request retention sweep failed"));
setTimeout(sweep, 15_000).unref();
setInterval(sweep, 24 * 60 * 60 * 1000).unref();

router.get("/visual-requests", async (req, res): Promise<void> => {
  const contractorId = owner(req, res);
  if (!contractorId) return;
  const rows = await db.select().from(visualRequestsTable)
    .where(and(eq(visualRequestsTable.contractorId, contractorId), eq(visualRequestsTable.emailStatus, "accepted"), gt(visualRequestsTable.expiresAt, new Date())))
    .orderBy(desc(visualRequestsTable.createdAt)).limit(100);
  res.json(rows.map(response));
});

router.post("/visual-requests", (req, res, next) => {
  if (!owner(req, res)) return;
  upload(req, res, (error) => {
    if (error) { res.status(400).json({ error: "Add two valid images under 10 MB each." }); return; }
    next();
  });
}, async (req, res): Promise<void> => {
  const contractorId = owner(req, res);
  if (!contractorId) return;
  const parsed = inputSchema.safeParse(req.body);
  const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
  if (!parsed.success || !files?.original?.[0] || !files?.redesign?.[0]) {
    res.status(400).json({ error: "Add a room photo, concept image, and valid contact details." });
    return;
  }
  let original: Buffer;
  let redesign: Buffer;
  try {
    async function normalize(file: Express.Multer.File) {
      const source = sharp(file.buffer, { failOn: "error", limitInputPixels: 40_000_000 }).rotate();
      const metadata = await source.metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("Unsupported image");
      return source.resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    }
    [original, redesign] = await Promise.all([normalize(files.original[0]), normalize(files.redesign[0])]);
  } catch {
    res.status(400).json({ error: "Choose valid JPG, PNG, or WebP images." });
    return;
  }
  const id = randomUUID();
  const deletionToken = randomBytes(32).toString("hex");
  const paths: string[] = [];
  try {
    const originalPath = await storeRequestImage(id, "original", original);
    paths.push(originalPath);
    const redesignPath = await storeRequestImage(id, "redesign", redesign);
    paths.push(redesignPath);
    const [row] = await db.insert(visualRequestsTable).values({
      id, contractorId, ...parsed.data, originalPath, redesignPath,
      deletionTokenHash: createHash("sha256").update(deletionToken).digest("hex"),
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }).returning();
    res.status(201).json({ request: response(row), deletionToken });
  } catch (error) {
    req.log.error({ err: error }, "Unable to save visual request");
    await Promise.allSettled(paths.map(removeRequestImage));
    res.status(503).json({ error: "The request could not be saved. Please try again." });
  }
});

router.get("/visual-requests/:id", async (req, res): Promise<void> => {
  const contractorId = owner(req, res);
  if (!contractorId) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) { res.sendStatus(404); return; }
  const [row] = await db.select().from(visualRequestsTable).where(and(eq(visualRequestsTable.id, id.data), eq(visualRequestsTable.contractorId, contractorId), eq(visualRequestsTable.emailStatus, "accepted"), gt(visualRequestsTable.expiresAt, new Date())));
  if (!row) { res.sendStatus(404); return; }
  res.json(response(row));
});

router.get("/visual-requests/:id/images/:kind", async (req, res): Promise<void> => {
  const contractorId = owner(req, res);
  if (!contractorId) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success || !["original", "redesign"].includes(String(req.params.kind))) { res.sendStatus(404); return; }
  const [row] = await db.select().from(visualRequestsTable).where(and(eq(visualRequestsTable.id, id.data), eq(visualRequestsTable.contractorId, contractorId), eq(visualRequestsTable.emailStatus, "accepted"), gt(visualRequestsTable.expiresAt, new Date())));
  if (!row) { res.sendStatus(404); return; }
  res.set({ "Content-Type": "image/png", "Cache-Control": "private, no-store" });
  const stream = streamRequestImage(req.params.kind === "original" ? row.originalPath : row.redesignPath);
  stream.on("error", (error) => {
    req.log.error({ err: error }, "Unable to read private image");
    if (!res.headersSent) res.sendStatus(503);
    else res.destroy(error);
  });
  stream.pipe(res);
});

router.delete("/visual-requests/:id", async (req, res): Promise<void> => {
  const contractorId = owner(req, res);
  if (!contractorId) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) { res.sendStatus(404); return; }
  const [row] = await db.select().from(visualRequestsTable).where(and(eq(visualRequestsTable.id, id.data), eq(visualRequestsTable.contractorId, contractorId)));
  if (!row) { res.sendStatus(404); return; }
  await deleteRequest(row);
  res.sendStatus(204);
});

router.post("/visual-requests/:id/homeowner-delete", async (req, res): Promise<void> => {
  const id = idSchema.safeParse(req.params.id);
  const token = req.body?.deletionToken;
  if (!id.success || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) { res.sendStatus(404); return; }
  const [row] = await db.select().from(visualRequestsTable).where(eq(visualRequestsTable.id, id.data));
  const hash = createHash("sha256").update(token).digest();
  if (!row || !timingSafeEqual(hash, Buffer.from(row.deletionTokenHash, "hex"))) { res.sendStatus(404); return; }
  await deleteRequest(row);
  res.sendStatus(204);
});

export default router;