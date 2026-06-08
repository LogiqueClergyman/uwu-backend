import { Router } from 'express';
import { createIntent } from '../controllers/intent.controller';
import { authenticatePlatformKey } from '../middleware/auth.middleware';

const router = Router();

router.post('/create', authenticatePlatformKey, createIntent);

export default router;
