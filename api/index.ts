import app from '../server';
import { blingRouter } from '../server-bling';

// Garante que o router /api/bling esteja explicitamente montado no handler principal da Vercel
app.use('/api/bling', blingRouter);

export default app;
