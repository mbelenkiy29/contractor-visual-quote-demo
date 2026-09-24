import { createInsertSchema } from "drizzle-zod";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const contractorProfilesTable = pgTable("contractor_profiles", {
  id: uuid("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  companyName: text("company_name").notNull().default(""),
  website: text("website").notNull().default(""),
  quoteEmail: text("quote_email").notNull().default(""),
  accentColor: text("accent_color").notNull().default("#2563eb"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [uniqueIndex("contractor_profiles_owner_id_idx").on(table.ownerId)]);

export const insertContractorProfileSchema = createInsertSchema(contractorProfilesTable).omit({ createdAt: true, updatedAt: true });
export type InsertContractorProfile = z.infer<typeof insertContractorProfileSchema>;
export type ContractorProfile = typeof contractorProfilesTable.$inferSelect;