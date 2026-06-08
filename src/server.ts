import express from 'express';
import 'dotenv/config';
import authRoutes from './routes/auth.routes';
import dashboardRoutes from './routes/dashboard.routes';
import intentRoutes from './routes/intent.routes';
import setuRoutes from './routes/setu.routes';
import { initAlgorandRelayer } from './services/algorand.service';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Mount routes mapped to the correct modular layers
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/intent', intentRoutes);
app.use('/api/v1/mock/setu', setuRoutes);

// Bootstrapper for the UwU Server
async function boot() {
    console.log("=== Booting UwU Server ===");
    
    if (!process.env.APP_ID) {
        console.error("❌ process.env.APP_ID is missing! Please run 'npx ts-node src/scripts/deploy-demo.ts' or configure Render environment variables.");
        process.exit(1);
    }

    console.log(`Loaded Environment: App ID ${process.env.APP_ID}`);

    // Initialize the Relayer with the persisted App ID
    await initAlgorandRelayer(BigInt(process.env.APP_ID));

    app.listen(PORT, () => {
        console.log(`===================================================`);
        console.log(`UwU Protocol E2E Demo Server live on port: ${PORT}`);
        console.log(`===================================================`);
    });
}

boot().catch(console.error);