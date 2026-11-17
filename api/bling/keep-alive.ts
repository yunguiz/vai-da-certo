import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getValidBlingToken } from '../../lib/blingToken';

/**
 * Vercel Cron Job Endpoint: GET /api/bling/keep-alive
 * Executado 1 vez por semana via vercel.json para chamar getValidBlingToken()
 * e garantir que o refresh_token do Bling nunca passe de 30 dias sem uso.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Se CRON_SECRET estiver definido na Vercel, protege contra chamadas externas não autorizadas,
    // mas permite header Authorization: Bearer <CRON_SECRET>, x-cron-secret ou ?secret=
    const cronSecret = (process.env.CRON_SECRET || '').trim();
    if (cronSecret) {
      const authHeader = (req.headers.authorization || '').trim();
      const xCron = typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'].trim() : '';
      const qSecret = typeof req.query?.secret === 'string' ? req.query.secret.trim() : '';
      const valid =
        authHeader === `Bearer ${cronSecret}` ||
        xCron === cronSecret ||
        qSecret === cronSecret;

      if (!valid) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
      }
    }

    const accessToken = await getValidBlingToken();
    return res.status(200).json({
      ok: true,
      refreshedOrValid: Boolean(accessToken),
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel Cron /api/bling/keep-alive Notice]:', message);

    const isPendingAuth =
      message.includes('integrations/bling não encontrado') ||
      message.includes('sem refresh_token');

    return res.status(isPendingAuth ? 200 : 500).json({
      ok: false,
      pendingAuth: isPendingAuth,
      error: message,
      checkedAt: new Date().toISOString(),
    });
  }
}
