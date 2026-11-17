import { getApps, initializeApp } from 'firebase-admin/app';
import { ConnectorConfig, getDataConnect } from 'firebase-admin/data-connect';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';

// Credenciais protegidas via Firebase Secrets (fallback para process.env no emulador local)
export const BLING_CLIENT_ID_SECRET = defineSecret('BLING_CLIENT_ID');
export const BLING_CLIENT_SECRET_SECRET = defineSecret('BLING_CLIENT_SECRET');

const BLING_TOKEN_ENDPOINT = 'https://api.bling.com.br/v3/oauth/token';
const BLING_API_BASE = 'https://api.bling.com.br/v3';

const FIXED_INTEGRATION_ID = 'default';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // Renova automaticamente se faltar < 10 min para expiresAt

export interface BlingIntegrationRecord {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // Timestamp ISO-8601 retornado pelo Data Connect PostgreSQL
  expiresIn: number;
  tokenType: string;
  scope?: string | null;
  updatedAt?: string;
}

interface GetBlingTokenQueryData {
  blingIntegration: BlingIntegrationRecord | null;
}

interface UpsertBlingTokenVariables {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  expiresIn: number;
  tokenType: string;
  scope: string | null;
}

interface BlingOAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string | { message?: string; description?: string };
  error_description?: string;
}

let inFlightRefreshPromise: Promise<string> | null = null;

function getAdminDataConnect() {
  const app = getApps().length > 0 ? getApps()[0] : initializeApp();

  const connectorConfig: ConnectorConfig = {
    location: (process.env.DATACONNECT_LOCATION || 'southamerica-east1').trim(),
    serviceId: (process.env.DATACONNECT_SERVICE_ID || 'street-store-dataconnect').trim(),
    connector: (process.env.DATACONNECT_CONNECTOR || 'default').trim(),
  };

  return getDataConnect(connectorConfig, app);
}

function getBlingCredentials(): { clientId: string; clientSecret: string } {
  let clientId = '';
  let clientSecret = '';

  try {
    clientId = BLING_CLIENT_ID_SECRET.value().trim();
  } catch {
    clientId = (process.env.BLING_CLIENT_ID || '').trim();
  }

  try {
    clientSecret = BLING_CLIENT_SECRET_SECRET.value().trim();
  } catch {
    clientSecret = (process.env.BLING_CLIENT_SECRET || '').trim();
  }

  if (!clientId) {
    clientId = (process.env.BLING_CLIENT_ID || '').trim();
  }
  if (!clientSecret) {
    clientSecret = (process.env.BLING_CLIENT_SECRET || '').trim();
  }

  if (!clientId || !clientSecret) {
    throw new Error(
      'Credenciais BLING_CLIENT_ID e BLING_CLIENT_SECRET não configuradas nos Secrets/variáveis de ambiente.'
    );
  }

  return { clientId, clientSecret };
}

function buildBasicAuthHeader(): string {
  const { clientId, clientSecret } = getBlingCredentials();
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

function parseExpiresAtMs(rawExpiresAt: string | number | undefined): number {
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    return rawExpiresAt;
  }
  if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim()) {
    const parsed = Date.parse(rawExpiresAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Busca o registro BlingIntegration (id="default") no PostgreSQL via Data Connect Admin SDK.
 */
async function getBlingIntegrationFromDb(): Promise<BlingIntegrationRecord | null> {
  const dc = getAdminDataConnect();
  const response = await dc.executeQuery<GetBlingTokenQueryData, { id: string }>('GetBlingToken', {
    id: FIXED_INTEGRATION_ID,
  });

  return response.data?.blingIntegration ?? null;
}

/**
 * Sobrescreve ambos os tokens (accessToken, refreshToken) e expiresAt no PostgreSQL
 * via mutation protegida UpsertBlingToken (@auth(level: NO_ACCESS)).
 */
async function saveBlingIntegrationToDb(payload: BlingOAuthResponse): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}> {
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error('Resposta do Bling não contém access_token e refresh_token válidos.');
  }

  const now = Date.now();
  const expiresInSec = Number(payload.expires_in) || 21600; // 6 horas padrão Bling v3
  const expiresAtMs = now + (payload.expires_in ? expiresInSec * 1000 : SIX_HOURS_MS);
  const expiresAtIso = new Date(expiresAtMs).toISOString();

  const dc = getAdminDataConnect();
  await dc.executeMutation<Record<string, unknown>, UpsertBlingTokenVariables>('UpsertBlingToken', {
    id: FIXED_INTEGRATION_ID,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: expiresAtIso,
    expiresIn: expiresInSec,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope ?? null,
  });

  logger.info('Tokens do Bling gravados no PostgreSQL via Data Connect.', {
    id: FIXED_INTEGRATION_ID,
    expiresAt: expiresAtIso,
  });

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMs,
  };
}

/**
 * Troca o authorization code (?code=...) pelos primeiros access_token e refresh_token
 * e persiste na tabela BlingIntegration do PostgreSQL.
 */
export async function exchangeBlingAuthorizationCode(
  code: string,
  redirectUri?: string
): Promise<{ accessToken: string; refreshToken: string; expiresAtMs: number }> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    throw new Error('Authorization code ausente para troca de token no Bling.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cleanCode,
  });

  const configuredRedirect = (process.env.BLING_REDIRECT_URI || redirectUri || '').trim();
  if (configuredRedirect) {
    body.set('redirect_uri', configuredRedirect);
  }

  const response = await fetch(BLING_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: buildBasicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const rawText = await response.text();
  let json: BlingOAuthResponse;
  try {
    json = JSON.parse(rawText) as BlingOAuthResponse;
  } catch {
    throw new Error(`Resposta inválida do Bling [${response.status}]: ${rawText}`);
  }

  if (!response.ok || json.error || !json.access_token || !json.refresh_token) {
    const errMsg =
      (typeof json.error === 'object' ? json.error?.message || json.error?.description : json.error) ||
      json.error_description ||
      rawText;
    throw new Error(`Falha ao trocar authorization_code no Bling [${response.status}]: ${errMsg}`);
  }

  return saveBlingIntegrationToDb(json);
}

/**
 * Renova o par de tokens via grant_type=refresh_token.
 * Regra crítica do Bling v3: o refresh_token antigo é invalidado imediatamente,
 * portanto ambos (accessToken e novo refreshToken) + expiresAt (now + 6h) são sobrescritos no PostgreSQL.
 */
export async function refreshBlingTokens(currentRefreshToken: string): Promise<string> {
  if (inFlightRefreshPromise) {
    return inFlightRefreshPromise;
  }

  inFlightRefreshPromise = (async () => {
    const cleanRefresh = currentRefreshToken.trim();
    if (!cleanRefresh) {
      throw new Error('refreshToken ausente na tabela BlingIntegration.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cleanRefresh,
    });

    const response = await fetch(BLING_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: buildBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    const rawText = await response.text();
    let json: BlingOAuthResponse;
    try {
      json = JSON.parse(rawText) as BlingOAuthResponse;
    } catch {
      throw new Error(`Erro ao renovar token Bling [${response.status}]: ${rawText}`);
    }

    if (!response.ok || json.error || !json.access_token || !json.refresh_token) {
      const errMsg =
        (typeof json.error === 'object' ? json.error?.message || json.error?.description : json.error) ||
        json.error_description ||
        rawText;
      logger.error('Erro na renovação automática do token Bling.', {
        status: response.status,
        error: errMsg,
      });
      throw new Error(`Erro ao renovar token no Bling [${response.status}]: ${errMsg}`);
    }

    const saved = await saveBlingIntegrationToDb(json);
    return saved.accessToken;
  })().finally(() => {
    inFlightRefreshPromise = null;
  });

  return inFlightRefreshPromise;
}

/**
 * Função Auxiliar (getValidBlingToken):
 * Lê o registro BlingIntegration no PostgreSQL via Data Connect antes de qualquer chamada na API do Bling.
 * Se faltar menos de 10 minutos para o expiresAt (ou se já venceu), renova automaticamente.
 */
export async function getValidBlingToken(): Promise<string> {
  const record = await getBlingIntegrationFromDb();
  if (!record) {
    throw new Error(
      'Registro BlingIntegration ("default") não encontrado no PostgreSQL. Realize a autorização inicial via blingCallback (?code=...).'
    );
  }

  const accessToken = (record.accessToken || '').trim();
  const refreshToken = (record.refreshToken || '').trim();
  const expiresAtMs = parseExpiresAtMs(record.expiresAt);

  if (!refreshToken) {
    throw new Error('Registro BlingIntegration sem refreshToken válido. Reautorize o aplicativo no Bling.');
  }

  const remainingMs = expiresAtMs - Date.now();
  const mustRefresh = !accessToken || expiresAtMs <= 0 || remainingMs < REFRESH_MARGIN_MS;

  if (mustRefresh) {
    logger.info('Token do Bling próximo do vencimento (<10min) ou expirado. Renovando automaticamente...', {
      remainingSeconds: Math.round(remainingMs / 1000),
    });
    return refreshBlingTokens(refreshToken);
  }

  return accessToken;
}

/**
 * Helper HTTP para consumir endpoints da API v3 do Bling já autenticado com getValidBlingToken().
 */
export async function blingApiFetch<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const token = await getValidBlingToken();
  const url = endpoint.startsWith('http') ? endpoint : `${BLING_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (response.status === 401) {
    const latest = await getBlingIntegrationFromDb();
    const currentRefresh = (latest?.refreshToken || '').trim();
    if (currentRefresh) {
      const freshToken = await refreshBlingTokens(currentRefresh);
      const retryResponse = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      if (!retryResponse.ok) {
        const retryText = await retryResponse.text();
        throw new Error(`Bling API [${retryResponse.status}]: ${retryText}`);
      }
      return retryResponse.json() as Promise<T>;
    }
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Bling API [${response.status}]: ${errText}`);
  }

  return response.json() as Promise<T>;
}
