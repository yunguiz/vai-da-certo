import { Timestamp } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebaseAdmin';

export const BLING_AUTHORIZE_URL = 'https://www.bling.com.br/Api/v3/oauth/authorize';
export const BLING_TOKEN_ENDPOINT = 'https://www.bling.com.br/Api/v3/oauth/token';
export const BLING_TOKEN_FALLBACK_ENDPOINT = 'https://api.bling.com.br/v3/oauth/token';
export const BLING_OFFICIAL_API_BASE = 'https://www.bling.com.br/Api/v3';
export const BLING_API_BASE = 'https://api.bling.com.br/v3';
const BLING_FIRESTORE_DOC = 'integrations/bling';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const REFRESH_THRESHOLD_MS = 10 * 60 * 1000; // Renova se faltar menos de 10 minutos para vencer

export interface BlingFirestoreTokenDoc {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Timestamp UTC em milissegundos
  expires_at_iso?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  obtained_at?: number;
  updated_at?: string;
}

interface BlingTokenApiResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string | { message?: string; description?: string };
  error_description?: string;
}

let activeRefreshPromise: Promise<string> | null = null;

function getBlingBasicAuthHeader(): string {
  const clientId = (process.env.BLING_CLIENT_ID || '').trim();
  const clientSecret = (process.env.BLING_CLIENT_SECRET || '').trim();

  if (!clientId || !clientSecret) {
    throw new Error('Variáveis BLING_CLIENT_ID e BLING_CLIENT_SECRET não configuradas em process.env.');
  }

  const credentialsBase64 = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  return `Basic ${credentialsBase64}`;
}

function resolveExpiresAtMs(rawExpiresAt: unknown): number {
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    return rawExpiresAt;
  }
  if (rawExpiresAt && typeof (rawExpiresAt as Timestamp).toMillis === 'function') {
    return (rawExpiresAt as Timestamp).toMillis();
  }
  if (typeof rawExpiresAt === 'string') {
    const parsed = Date.parse(rawExpiresAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

async function postBlingTokenForm(body: URLSearchParams): Promise<{ status: number; rawText: string; ok: boolean }> {
  const headers = {
    Authorization: getBlingBasicAuthHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    'User-Agent': 'StreetStore/1.0',
  };

  let response = await fetch(BLING_TOKEN_ENDPOINT, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (response.status === 403) {
    response = await fetch(BLING_TOKEN_FALLBACK_ENDPOINT, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
  }

  const rawText = await response.text();
  return { status: response.status, rawText, ok: response.ok };
}

async function saveBlingTokensToFirestore(payload: BlingTokenApiResponse): Promise<BlingFirestoreTokenDoc> {
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error('Resposta do Bling não retornou access_token e refresh_token válidos.');
  }

  const now = Date.now();
  const expiresInSec = Number(payload.expires_in) || 21600; // 6 horas padrão Bling v3
  const expiresAtMs = now + (payload.expires_in ? expiresInSec * 1000 : SIX_HOURS_MS);

  const docData: BlingFirestoreTokenDoc = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAtMs,
    expires_at_iso: new Date(expiresAtMs).toISOString(),
    expires_in: expiresInSec,
    token_type: payload.token_type || 'Bearer',
    scope: payload.scope || '',
    obtained_at: now,
    updated_at: new Date(now).toISOString(),
  };

  // Sobrescreve ambos (access_token e refresh_token) + expires_at em integrations/bling
  const db = getAdminFirestore();
  await db.doc(BLING_FIRESTORE_DOC).set(docData, { merge: false });

  return docData;
}

/**
 * Troca o authorization_code recebido em /api/bling/callback pelos primeiros tokens
 * e grava no documento integrations/bling do Firestore.
 */
export async function exchangeBlingCodeForTokens(
  code: string,
  redirectUri?: string
): Promise<BlingFirestoreTokenDoc> {
  const cleanCode = code.trim();
  if (!cleanCode) {
    throw new Error('Parâmetro code é obrigatório para troca no Bling.');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cleanCode,
  });

  const resolvedRedirect = (process.env.BLING_REDIRECT_URI || redirectUri || '').trim();
  if (resolvedRedirect) {
    body.set('redirect_uri', resolvedRedirect);
  }

  const { status, rawText, ok } = await postBlingTokenForm(body);

  let json: BlingTokenApiResponse;
  try {
    json = JSON.parse(rawText) as BlingTokenApiResponse;
  } catch {
    throw new Error(`Bling retornou resposta não-JSON [${status}]: ${rawText}`);
  }

  if (!ok || json.error || !json.access_token || !json.refresh_token) {
    const errDetail =
      (typeof json.error === 'object' ? json.error?.message || json.error?.description : json.error) ||
      json.error_description ||
      rawText;
    throw new Error(`Erro Bling OAuth [${status}]: ${errDetail}`);
  }

  return saveBlingTokensToFirestore(json);
}

/**
 * Renova o par de tokens via grant_type=refresh_token e sobrescreve
 * o novo access_token, o novo refresh_token e o expires_at no Firestore.
 */
export async function refreshBlingTokenInFirestore(currentRefreshToken: string): Promise<string> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    const cleanRefresh = currentRefreshToken.trim();
    if (!cleanRefresh) {
      throw new Error('refresh_token ausente em integrations/bling.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cleanRefresh,
    });

    const { status, rawText, ok } = await postBlingTokenForm(body);

    let json: BlingTokenApiResponse;
    try {
      json = JSON.parse(rawText) as BlingTokenApiResponse;
    } catch {
      throw new Error(`Erro ao renovar token Bling [${status}]: ${rawText}`);
    }

    if (!ok || json.error || !json.access_token || !json.refresh_token) {
      const errDetail =
        (typeof json.error === 'object' ? json.error?.message || json.error?.description : json.error) ||
        json.error_description ||
        rawText;
      throw new Error(`Falha ao renovar refresh_token Bling [${status}]: ${errDetail}`);
    }

    const saved = await saveBlingTokensToFirestore(json);
    return saved.access_token;
  })().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

/**
 * Função Auxiliar (getValidBlingToken):
 * Lê integrations/bling no Firestore. Se faltar menos de 10 minutos para vencer
 * (ou já estiver vencido), renova automaticamente no Bling e sobrescreve ambos os tokens no Firestore.
 */
export async function getValidBlingToken(): Promise<string> {
  const db = getAdminFirestore();
  const snap = await db.doc(BLING_FIRESTORE_DOC).get();

  if (!snap.exists) {
    throw new Error(
      'Documento integrations/bling não encontrado no Firestore. Autorize primeiro via /api/bling/callback?code=...'
    );
  }

  const data = snap.data() as Partial<BlingFirestoreTokenDoc> | undefined;
  const accessToken = (data?.access_token || '').trim();
  const refreshToken = (data?.refresh_token || '').trim();
  const expiresAtMs = resolveExpiresAtMs(data?.expires_at);

  if (!refreshToken) {
    throw new Error('Documento integrations/bling sem refresh_token. Refaça a autorização inicial do Bling.');
  }

  const remainingMs = expiresAtMs - Date.now();
  const needsRefresh = !accessToken || expiresAtMs <= 0 || remainingMs < REFRESH_THRESHOLD_MS;

  if (needsRefresh) {
    return refreshBlingTokenInFirestore(refreshToken);
  }

  return accessToken;
}

/**
 * Helper HTTP para consumir a API v3 do Bling usando getValidBlingToken().
 */
export async function blingApiRequest<T = unknown>(endpoint: string, init: RequestInit = {}): Promise<T> {
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
    const snap = await getAdminFirestore().doc(BLING_FIRESTORE_DOC).get();
    const currentRefresh = (snap.data()?.refresh_token as string | undefined) || '';
    if (currentRefresh) {
      const freshToken = await refreshBlingTokenInFirestore(currentRefresh);
      const retryRes = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
      if (!retryRes.ok) {
        throw new Error(`Bling API [${retryRes.status}]: ${await retryRes.text()}`);
      }
      return retryRes.json() as Promise<T>;
    }
  }

  if (!response.ok) {
    throw new Error(`Bling API [${response.status}]: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}
