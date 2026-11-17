import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as logger from 'firebase-functions/logger';
import {
  BLING_CLIENT_ID_SECRET,
  BLING_CLIENT_SECRET_SECRET,
  exchangeBlingAuthorizationCode,
  getValidBlingToken,
} from './blingAuth.js';

export { blingApiFetch, getValidBlingToken } from './blingAuth.js';

/**
 * 1. HTTP Function de Callback (blingCallback):
 * Recebe ?code=... da URL de redirecionamento do Bling OAuth 2.0,
 * troca pelos primeiros tokens via POST https://api.bling.com.br/v3/oauth/token
 * e salva na tabela BlingIntegration do PostgreSQL via Data Connect Admin SDK.
 */
export const blingCallback = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [BLING_CLIENT_ID_SECRET, BLING_CLIENT_SECRET_SECRET],
    cors: false,
  },
  async (req, res) => {
    try {
      const oauthError = typeof req.query.error === 'string' ? req.query.error.trim() : '';
      if (oauthError) {
        res.status(400).send(`Erro retornado pelo Bling OAuth: ${oauthError}`);
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
      if (!code) {
        res.status(400).send('Parâmetro "code" não encontrado na query string (?code=...).');
        return;
      }

      const forwardedProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
      const forwardedHost = (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
      const redirectUri = forwardedHost ? `${forwardedProto}://${forwardedHost}${req.path}` : undefined;

      const saved = await exchangeBlingAuthorizationCode(code, redirectUri);

      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
          <head>
            <meta charset="utf-8" />
            <title>Bling ERP Conectado</title>
          </head>
          <body style="font-family:sans-serif;background:#0e0e0e;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
            <div style="background:#171717;border:1px solid #2a2a2a;border-radius:12px;padding:32px;max-width:440px;text-align:center;">
              <h2 style="margin-top:0;color:#22c55e;">Bling ERP v3 Autorizado!</h2>
              <p style="color:#b3b3b3;font-size:14px;">
                Tokens iniciais salvos com segurança no PostgreSQL via Firebase Data Connect (<code>BlingIntegration</code>).
              </p>
              <p style="color:#737373;font-size:12px;">
                Próxima expiração do accessToken: ${new Date(saved.expiresAtMs).toISOString()}
              </p>
            </div>
          </body>
        </html>
      `);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Erro no blingCallback:', { error: message });
      res.status(500).send(`Falha ao concluir autenticação do Bling: ${message}`);
    }
  }
);

/**
 * 2. Prevenção de Inatividade (onSchedule a cada 15 dias):
 * Chama getValidBlingToken() periodicamente para rotacionar o refreshToken no PostgreSQL
 * antes do limite de 30 dias sem uso imposto pelo Bling v3.
 */
export const keepBlingTokenAlive = onSchedule(
  {
    schedule: '0 3 */15 * *', // A cada 15 dias às 03:00 (horário de Brasília)
    timeZone: 'America/Sao_Paulo',
    region: 'southamerica-east1',
    secrets: [BLING_CLIENT_ID_SECRET, BLING_CLIENT_SECRET_SECRET],
  },
  async () => {
    logger.info('Executando rotina preventiva de 15 dias do token Bling via Data Connect...');
    const token = await getValidBlingToken();
    logger.info('Token Bling validado/rotacionado com sucesso.', { hasToken: Boolean(token) });
  }
);
