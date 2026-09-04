import '../shared/load-server-environment.js';
import cors from 'cors';
import express from 'express';
import { handleApiRoute } from '../server/api-router.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', handleApiRoute);
app.listen(3000, '127.0.0.1');
