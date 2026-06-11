import { pgTable, text, integer, boolean, varchar, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull()
});

export const apiKeys = pgTable("api_keys", {
    apiKey: text("api_key").primaryKey(), // The Ed25519 public key (Base64)
    platformName: varchar("platform_name", { length: 255 }).notNull(),
    setuApiKey: varchar("setu_api_key", { length: 255 }).notNull(),
    ownerEmail: varchar("owner_email", { length: 255 }), // links the key to the dashboard user
    env: varchar("env", { length: 8 }).default("live").notNull(), // live | test
    revoked: boolean("revoked").default(false).notNull(),
    usageCount: integer("usage_count").default(0).notNull(),
    successCount: integer("success_count").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull()
});

export const pendingIntents = pgTable("pending_intents", {
    refId: varchar("ref_id", { length: 64 }).primaryKey(), // 32-byte sha256 hash hex
    apiKey: text("api_key").notNull().references(() => apiKeys.apiKey),
    paymentRemarkCode: varchar("payment_remark_code", { length: 16 }).notNull().unique(), // The 16-char shortRefId
    invoiceOrRoute: text("invoice_or_route").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    contextHash: varchar("context_hash", { length: 64 }).notNull(),
    userAddress: varchar("user_address", { length: 64 }).notNull(),
    isProcessed: boolean("is_processed").default(false).notNull(),
    blockchainTxId: varchar("blockchain_tx_id", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull()
});
