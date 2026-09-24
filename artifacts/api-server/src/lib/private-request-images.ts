import { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";

// Replit App Storage uses the local sidecar for server credentials.
const endpoint = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${endpoint}/token`,
    type: "external_account",
    credential_source: {
      url: `${endpoint}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function privateDir() {
  const path = process.env.PRIVATE_OBJECT_DIR;
  if (!path) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  const [bucket, ...prefix] = path.replace(/^\/|\/$/g, "").split("/");
  if (!bucket) throw new Error("Invalid private object directory");
  return { bucket, prefix: prefix.join("/") };
}

function fileFor(path: string) {
  if (!/^\/objects\/visual-requests\/[a-f0-9-]{36}\/(original|redesign)-[a-f0-9-]{36}\.png$/.test(path)) {
    throw new Error("Invalid private image path");
  }
  const { bucket, prefix } = privateDir();
  return storage.bucket(bucket).file(`${prefix ? `${prefix}/` : ""}${path.slice("/objects/".length)}`);
}

export async function storeRequestImage(id: string, kind: "original" | "redesign", bytes: Buffer) {
  const path = `/objects/visual-requests/${id}/${kind}-${randomUUID()}.png`;
  await fileFor(path).save(bytes, { resumable: false, contentType: "image/png", metadata: { cacheControl: "private, no-store" } });
  return path;
}

export function streamRequestImage(path: string) {
  return fileFor(path).createReadStream();
}

export async function removeRequestImage(path: string) {
  await fileFor(path).delete({ ignoreNotFound: true });
}