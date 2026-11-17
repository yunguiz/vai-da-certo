import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  syncAllBlingProdutosToFirestore,
  syncBlingProdutosPageToFirestore,
  verifySyncSecret,
} from '../../lib/blingSyncProdutos';

function extractSecretFromReq(req: VercelRequest): string {
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
  const headerCron = req.headers['x-cron-secret'];
  const headerAdmin = req.headers['x-admin-secret'];
  const authHeader = req.headers.authorization || '';

  if (querySecret) return querySecret;
  if (typeof headerCron === 'string' && headerCron) return headerCron;
  if (typeof headerAdmin === 'string' && headerAdmin) return headerAdmin;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

/**
 * Vercel Serverless Function: GET/POST /api/bling/sync
 * - Sem ?pagina= (ou com ?all=true): executa auto-loop seguro de páginas via db.batch()
 *   respeitando orçamento de tempo da Vercel (retornando proximaPagina se necessário).
 * - Com ?pagina=N: processa a página N (100 produtos ativos + estoque + imagens .link) via db.batch().
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  if (process.env.CRON_SECRET?.trim()) {
    const providedSecret = extractSecretFromReq(req);
    if (!verifySyncSecret(providedSecret)) {
      return res.status(401).json({
        error: 'Não autorizado. Informe CRON_SECRET válido via header ou ?secret=.',
      });
    }
  }

  if (req.query.verify === 'true') {
    return res.status(200).json({ authorized: true });
  }

  try {
    const hasExplicitPage = typeof req.query.pagina === 'string' && req.query.pagina.trim() !== '';
    const autoAll = req.query.all === 'true' || !hasExplicitPage;

    if (autoAll) {
      const startPageRaw = typeof req.query.pagina === 'string' ? req.query.pagina : '1';
      const startPage = Math.max(1, parseInt(startPageRaw, 10) || 1);
      const maxMsRaw = typeof req.query.maxMs === 'string' ? parseInt(req.query.maxMs, 10) : 0;
      const result = await syncAllBlingProdutosToFirestore({
        startPage,
        maxExecutionMs: maxMsRaw > 0 ? Math.min(55000, maxMsRaw) : 7500,
      });
      return res.status(200).json(result);
    }

    const pagina = Math.max(1, parseInt(String(req.query.pagina), 10) || 1);
    const result = await syncBlingProdutosPageToFirestore(pagina);
    return res.status(200).json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel /api/bling/sync Error]:', message);
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}
