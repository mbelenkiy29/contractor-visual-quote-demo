import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const redesignUsageTable = pgTable("redesign_usage", {
  id: serial("id").primaryKey(),
  contractorId: text("contractor_id").notNull(),
  month: text("month").notNull(),
  reservedCents: integer("reserved_cents").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertRedesignUsageSchema = createInsertSchema(redesignUsageTable).omit({ id: true, createdAt: true });
export type InsertRedesignUsage = z.infer<typeof insertRedesignUsageSchema>;
export type RedesignUsage = typeof redesignUsageTable.$inferSelect;