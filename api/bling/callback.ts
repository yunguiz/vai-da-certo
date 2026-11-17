import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeBlingCodeForTokens } from '../../lib/blingToken';

/**
 * Vercel Serverless Function: GET /api/bling/callback
 * Recebe ?code=... do OAuth 2.0 do Bling, troca pelos tokens iniciais via
 * POST https://api.bling.com.br/v3/oauth/token e grava access_token, refresh_token
 * e expires_at no documento integrations/bling do Firestore.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }

  const oauthError = typeof req.query.error === 'string' ? req.query.error.trim() : '';
  if (oauthError) {
    return res.status(400).send(`Erro retornado pelo Bling OAuth: ${oauthError}`);
  }

  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    return res.status(400).json({
      error: 'Parâmetro "code" não informado na query string (?code=...).',
    });
  }

  try {
    const protoHeader = req.headers['x-forwarded-proto'];
    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || 'https';
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader || '';
    const redirectUri = host ? `${proto}://${host}/api/bling/callback` : undefined;

    const saved = await exchangeBlingCodeForTokens(code, redirectUri);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <title>Bling ERP Conectado</title>
        </head>
        <body style="font-family:sans-serif;background:#0e0e0e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
          <div style="background:#171717;border:1px solid #2a2a2a;border-radius:12px;padding:32px;max-width:440px;text-align:center;">
            <h2 style="margin-top:0;color:#22c55e;">Bling ERP Conectado!</h2>
            <p style="color:#b3b3b3;font-size:14px;">
              Tokens salvos com segurança no Firestore (<code>integrations/bling</code>).
            </p>
            <p style="color:#737373;font-size:12px;">
              Próxima expiração do access_token: ${saved.expires_at_iso}
            </p>
          </div>
        </body>
      </html>
    `);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel /api/bling/callback Error]:', message);
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}
