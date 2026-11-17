import type { VercelRequest, VercelResponse } from '@vercel/node';
import { syncBlingProdutosPageToFirestore, verifySyncSecret } from '../../lib/blingSyncProdutos';

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
 * Vercel Serverless Function: GET /api/bling/sync-produtos?pagina=1&secret=...
 * Protegida por CRON_SECRET (query ?secret= ou header Authorization/x-cron-secret).
 * Consulta lotes de 100 produtos ativos no Bling v3, agrupa variações/grades
 * e grava em lote (WriteBatch) na coleção `products` do Firestore com { merge: true }.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }

  if (!process.env.CRON_SECRET?.trim()) {
    return res.status(500).json({
      error: 'Variável CRON_SECRET não configurada no servidor.',
    });
  }

  const providedSecret = extractSecretFromReq(req);
  if (!verifySyncSecret(providedSecret)) {
    return res.status(401).json({
      error: 'Não autorizado. Informe CRON_SECRET válido via header ou ?secret=.',
    });
  }

  // Modo de validação de senha para desbloquear a tela /admin/bling sem consumir cota do Bling
  if (req.query.verify === 'true') {
    return res.status(200).json({ authorized: true });
  }

  try {
    const paginaRaw = typeof req.query.pagina === 'string' ? req.query.pagina : '1';
    const pagina = Math.max(1, parseInt(paginaRaw, 10) || 1);

    const resultado = await syncBlingProdutosPageToFirestore(pagina);
    return res.status(200).json(resultado);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel /api/bling/sync-produtos Error]:', message);
    return res.status(500).json({
      error: message,
    });
  }
}
