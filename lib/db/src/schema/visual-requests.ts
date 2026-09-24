import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const visualRequestsTable = pgTable("visual_requests", {
  id: uuid("id").primaryKey(),
  contractorId: text("contractor_id").notNull(),
  roomType: text("room_type").notNull(),
  designBrief: text("design_brief").notNull(),
  homeownerName: text("homeowner_name").notNull(),
  homeownerEmail: text("homeowner_email").notNull(),
  homeownerPhone: text("homeowner_phone").notNull().default(""),
  homeownerNotes: text("homeowner_notes").notNull().default(""),
  originalPath: text("original_path").notNull(),
  redesignPath: text("redesign_path").notNull(),
  deletionTokenHash: text("deletion_token_hash").notNull(),
  deletionTokenCiphertext: text("deletion_token_ciphertext"),
  emailStatus: text("email_status").notNull().default("accepted"),
  emailAttemptedAt: timestamp("email_attempted_at", { withTimezone: true }),
  emailAttemptLeaseUntil: timestamp("email_attempt_lease_until", { withTimezone: true }),
  emailProviderMessageId: text("email_provider_message_id"),
  requestKey: text("request_key"),
  idempotencyHash: text("idempotency_hash"),
  redesignTokenHash: text("redesign_token_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("visual_requests_contractor_created_idx").on(table.contractorId, table.createdAt),
  uniqueIndex("visual_requests_contractor_request_key_idx").on(table.contractorId, table.requestKey),
  uniqueIndex("visual_requests_redesign_token_hash_idx").on(table.redesignTokenHash),
]);

export const insertVisualRequestSchema = createInsertSchema(visualRequestsTable).omit({ createdAt: true });
export type InsertVisualRequest = z.infer<typeof insertVisualRequestSchema>;
export type VisualRequest = typeof visualRequestsTable.$inferSelect;