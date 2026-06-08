export interface User {
    id: string;
    email: string;
}

export interface ApiKeyRegistry {
    apiKey: string; // The Ed25519 public key (Base64) uniquely identifies the client
    platformName: string;
    setuApiKey: string;
    usageCount: number;
    successCount: number;
}

export interface IntentBlock {
    invoiceOrRoute: string;
    amountPaise: number;
    contextHash: string;
    userAddress: string;
}

export interface PendingIntent {
    refId: string;           // 32-byte sha256 hash hex
    apiKey: string;          // The client's public key identifier
    invoiceOrRoute: string;
    amountPaise: number;
    contextHash: string;
    userAddress: string;
    isProcessed: boolean;
}

// In-Memory Data Stores for the E2E Demo
export const USERS: Map<string, User> = new Map(); // email -> User
export const API_KEYS: Map<string, ApiKeyRegistry> = new Map(); // apiKey (pubKey) -> Registry
export const PENDING_INTENTS: Map<string, PendingIntent> = new Map(); // 16-char shortRefId -> Intent
