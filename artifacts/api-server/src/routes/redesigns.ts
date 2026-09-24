import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { getAuth } from "@clerk/express";
import { getRedesignAllowance, reserveRedesign } from "../lib/redesign-allowance";
import {
  CreateRoomRedesignBody,
  CreateRoomRedesignResponse,
  GetRedesignAllowanceResponse,
} from "@workspace/api-zod";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 },
});

function uploadRoomImage(
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single("image")(req, res, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createPrompt(roomType: string, designBrief: string): string {
  return [
    `Photorealistically redesign this ${roomType.replace("-", " ")} according to this homeowner brief: ${designBrief}.`,
    "Treat the uploaded photograph as the exact source scene, not loose inspiration.",
    "Preserve the camera position, lens perspective, crop, room dimensions, ceiling height, wall geometry, floor plan, doors, windows, openings, and all major architectural structure.",
    "Do not add, remove, move, widen, or shrink windows, doors, walls, columns, stairs, or built-in openings.",
    "Only change renovation finishes, colors, lighting fixtures, cabinetry faces, furnishings, decor, and other non-structural visual elements needed by the brief.",
    "Keep lighting physically plausible, edges straight, materials realistic, and the result suitable as an early contractor conversation concept.",
    "Do not include text, labels, people, watermarks, split screens, or before-and-after framing.",
  ].join(" ");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.message.toLowerCase().includes("timed out")
  );
}

type EditImage = (input: { apiKey: string; data: Buffer; prompt: string; size: "1536x1024" | "1024x1536" }) => Promise<string | undefined>;

async function editImage({ apiKey, data, prompt, size }: Parameters<EditImage>[0]): Promise<string | undefined> {
  const openai = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });
  const image = await toFile(data, "room.png", { type: "image/png" });
  const result = await openai.images.edit(
    { model: "gpt-image-1", image, prompt, size, quality: "medium", output_format: "png" },
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  return result.data?.[0]?.b64_json;
}

// Injectable boundaries keep routine tests completely offline and independent of Clerk/DB.
export function createRedesignRouter(deps: {
  userId?: (req: Request) => string | null;
  allowance?: typeof getRedesignAllowance;
  reserve?: typeof reserveRedesign;
  edit?: EditImage;
  apiKey?: () => string | undefined;
} = {}): IRouter {
  const router: IRouter = Router();
  const getUserId = deps.userId ?? ((req: Request) => getAuth(req).userId);
  const activeClients = new Set<string>();
  let activeRequests = 0;
  const redesignLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "This preview has reached its hourly redesign limit. Please try again later." });
    },
  });
  function contractorId(req: Request, res: Response): string | null {
    const userId = getUserId(req);
    if (!userId) res.status(401).json({ error: "Sign in as a contractor to create a redesign." });
    return userId;
  }
  router.get("/redesigns/allowance", async (req, res): Promise<void> => {
    const userId = contractorId(req, res);
    if (!userId) return;
    res.json(GetRedesignAllowanceResponse.parse(await (deps.allowance ?? getRedesignAllowance)(userId)));
  });
  router.post(
  "/redesigns",
  (req, res, next) => {
    if (!contractorId(req, res)) return;
    next();
  },
  redesignLimiter,
  async (req, res): Promise<void> => {
    const userId = getUserId(req)!;
    try {
      await uploadRoomImage(req, res);
    } catch (error) {
      const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
        ? "The photo is too large. Choose an image under 10 MB."
        : "The upload could not be read. Choose one JPG, PNG, or WebP image.";
      res.status(400).json({ error: message });
      return;
    }

    const parsed = CreateRoomRedesignBody.safeParse({
      ...req.body,
      image: req.file?.originalname ?? "",
    });
    if (!parsed.success || !req.file) {
      res.status(400).json({
        error: "Add a room photo and a short design brief before creating a redesign.",
      });
      return;
    }

    const clientId = userId;
    if (activeRequests >= 2 || activeClients.has(clientId)) {
      res.status(429).json({
        error: "A redesign is already being created. Please wait for it to finish.",
      });
      return;
    }

    const apiKey = (deps.apiKey ?? (() => process.env["OPENAI_API_KEY"]))();
    if (!apiKey) {
      req.log.error("Room redesign provider is not configured");
      res.status(500).json({
        error: "Room redesign is not configured yet. Please contact the site owner.",
      });
      return;
    }

    activeClients.add(clientId);
    activeRequests += 1;

    try {
      const source = sharp(req.file.buffer, {
        failOn: "error",
        limitInputPixels: 40_000_000,
      }).rotate();
      let metadata: Awaited<ReturnType<typeof source.metadata>>;
      try {
        metadata = await source.metadata();
      } catch {
        res.status(400).json({ error: "Choose a valid JPG, PNG, or WebP room photo." });
        return;
      }
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) {
        res.status(400).json({
          error: "Choose a valid JPG, PNG, or WebP room photo.",
        });
        return;
      }

      const normalized = await source
        .resize({
          width: 1536,
          height: 1536,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 8 })
        .toBuffer({ resolveWithObject: true });

      const size = normalized.info.width >= normalized.info.height
        ? "1536x1024"
        : "1024x1536";
      const exhausted = await (deps.reserve ?? reserveRedesign)(userId);
      if (exhausted) {
        res.status(429).json({ error: `${exhausted.exhaustedReason} Resets ${new Date(exhausted.resetsAt).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" })}.` });
        return;
      }
      const imageBase64 = await (deps.edit ?? editImage)({
        apiKey, data: normalized.data,
        prompt: createPrompt(parsed.data.roomType, parsed.data.designBrief),
        size,
      });
      if (!imageBase64) {
        throw new Error("OpenAI returned no edited image");
      }

      const response = CreateRoomRedesignResponse.parse({
        imageBase64,
        mimeType: "image/png",
      });
      res.json(response);
    } catch (error) {
      const status = isTimeout(error) ? 504 : 502;
      // Provider error objects may contain request headers or image payloads.
      req.log.error({ failure: status === 504 ? "timeout" : "provider", providerStatus: error instanceof OpenAI.APIError ? error.status : undefined }, "Room redesign failed");
      res.status(status).json({
        error: status === 504
          ? "The redesign took too long. Please try again with a smaller photo."
          : "OpenAI could not create this redesign. Check the photo and try again.",
      });
    } finally {
      activeClients.delete(clientId);
      activeRequests -= 1;
    }
  },
);
  return router;
}

export default createRedesignRouter();