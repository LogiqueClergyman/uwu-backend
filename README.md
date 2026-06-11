# uwu-api

Backend for the UwU Protocol — Algorand proof-of-payment. Express + Drizzle ORM
(Neon serverless Postgres) + algosdk. Handles merchant API-key onboarding, signed
payment intents, Setu AA consent proxying, and on-chain attestation relaying.

## Setup

```bash
npm install
cp .env.example .env          # then fill in real values (see below)
npx drizzle-kit push          # create/update tables on your Neon database
npm start                     # tsc build + run on PORT (default 4000)
```

### Environment (`.env`)

Copy `.env.example` and fill in:

| var | what |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres connection string |
| `DEPLOYER_MNEMONIC` | 25-word Algorand mnemonic for the relayer (funded on the target network) |
| `DVN_KEY_1..3` | base64 Ed25519 secret keys for the threshold (DVN) signers |
| `APP_ID` | Registry app id (optional; only the intent/settlement relayer needs it) |

> **Never commit `.env`.** Only `.env.example` (placeholders) is tracked.

## API surfaces

- `POST /api/v1/keys/generate`, `GET /api/v1/keys`, `POST /api/v1/keys/revoke` — dashboard key management
- `POST /api/v1/intent/create`, `GET /api/v1/intent/status/:refId` — signed payment intents
- `POST /api/v1/mock/setu/callback` — bank-statement reconciliation → threshold sign → on-chain anchor
- `POST /api/verification/consent`, `GET /api/verification/status` — Setu AA consent proxy
- `GET /api/v1/logs` (JSON) and `GET /logs` (live viewer) — structured, secret-redacting backend logs

## Tests

```bash
npm test            # vitest: unit suites for controllers, services, middleware, logger
```

Unit tests mock the database and Algorand relay, so they need no live services.
A gated live end-to-end test exercises the real testnet + a running server:

```bash
UWU_E2E=1 UWU_TEST_API_KEY=<base64 pubkey> UWU_TEST_SECRET_KEY=<base64 secret> npm test
```
