import { Router } from 'express';
import { setuCallback } from '../controllers/setu.controller';

const router = Router();

router.post('/callback', setuCallback);

export default router;
