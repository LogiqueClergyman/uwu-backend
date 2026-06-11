import express from 'express';
import 'dotenv/config';
import path from 'path';
import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import intentRoutes from './routes/intent.routes';
import setuRoutes from './routes/setu.routes';
import verificationRoutes from './routes/verification.routes';
import logsRoutes from './routes/logs.routes';
import { initAlgorandRelayer } from './services/algorand.service';
import { log } from './services/logger';

const app = express();
app.use(express.json());

// CORS — allow the enterprise dashboard (and other origins) to call the API.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-UwU-API-Key, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Request logging — every call in/out under [HTTP], skipping the log feed itself.
app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/logs') || req.path === '/logs') return next();
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const msg = `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
        if (res.statusCode >= 500) log.error('HTTP', msg);
        else if (res.statusCode >= 400) log.warn('HTTP', msg);
        else log.info('HTTP', msg);
    });
    next();
});

const PORT = process.env.PORT || 3000;

// Mount routes mapped to the correct modular layers
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/intent', intentRoutes);
app.use('/api/v1/mock/setu', setuRoutes);
app.use('/api/verification', verificationRoutes);

// Activity log — JSON feed + a live viewer page (shown separately from the app).
app.use('/api/v1/logs', logsRoutes);
app.get('/logs', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'logs.html')));

// Bootstrapper for the UwU Server
async function boot() {
    log.info('BOOT', 'Booting UwU backend…');

    // The Algorand relayer is only needed for the intent/settlement flow.
    // The dashboard key APIs work with just DATABASE_URL, so we boot either way.
    if (process.env.APP_ID) {
        log.info('BOOT', `Loaded environment: App ID ${process.env.APP_ID}`);
        try {
            await initAlgorandRelayer(BigInt(process.env.APP_ID));
        } catch (e) {
            log.warn('BOOT', 'Relayer init failed — continuing (key/dashboard APIs still work)', { error: String((e as Error)?.message || e) });
        }
    } else {
        log.warn('BOOT', 'APP_ID missing — skipping Algorand relayer init (key/dashboard APIs still work; run src/scripts/deploy-demo.ts for the full intent flow).');
    }

    app.listen(PORT, () => {
        log.success('BOOT', `UwU backend live on port ${PORT}`);
        log.info('BOOT', `Activity log: http://localhost:${PORT}/logs  ·  JSON: /api/v1/logs`);
    });
}

boot().catch((e) => log.error('BOOT', 'Fatal boot error', { error: String(e?.message || e) }));