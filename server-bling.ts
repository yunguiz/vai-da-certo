import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { isProductHidden } from './src/lib/hiddenProducts';
import { extractImagesFromBlingItem, getBlingImagesForProduct, isThumbnailLikeUrl } from './server-bling-images';
import {
  getBlingTokenFromDb,
  upsertBlingTokenInDb,
  clearBlingTokenFromDb,
  BLING_ACCESS_TTL_MS
} from './server-bling-db';
import { getValidBlingToken as getFirestoreBlingToken } from './lib/blingToken';
import {
  syncAllBlingProdutosToFirestore,
  syncBlingProdutosPageToFirestore,
  verifySyncSecret,
} from './lib/blingSyncProdutos';

dotenv.config();

// Bling API v3 Official Constants
export const BLING_AUTH_BASE = 'https://www.bling.com.br/Api/v3/oauth/authorize';
export const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
export const BLING_TOKEN_FALLBACK_URL = 'https://api.bling.com.br/v3/oauth/token';
export const BLING_OFFICIAL_API_BASE = 'https://www.bling.com.br/Api/v3';
export const BLING_API_BASE = 'https://api.bling.com.br/v3';
const TEN_MINUTES_MS = 10 * 60 * 1000;

const DATA_DIR = process.env.VERCEL ? '/tmp' : process.cwd();
const TOKENS_FILE = path.resolve(DATA_DIR, '.bling_tokens.json');

export const blingRouter = express.Router();

export interface BlingTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number; // UTC timestamp in ms
  token_type?: string;
  scope?: string;
  obtained_at: number; // timestamp in ms
}

// In-memory cache + single-flight refresh lock (prevents race condition on single-use refresh_token)
let cachedTokens: BlingTokens | null = null;
let activeRefreshPromise: Promise<BlingTokens> | null = null;

// Read tokens from bling_tokens SQLite table (with automatic env/file bootstrap)
export function loadBlingTokens(): BlingTokens | null {
  const dbRow = getBlingTokenFromDb();
  if (dbRow && (dbRow.access_token || dbRow.refresh_token)) {
    cachedTokens = {
      access_token: dbRow.access_token,
      refresh_token: dbRow.refresh_token || undefined,
      expires_in: dbRow.expires_in || 21600,
      expires_at: dbRow.expires_at,
      token_type: dbRow.token_type || 'Bearer',
      scope: dbRow.scope || '',
      obtained_at: dbRow.obtained_at
    };
    return cachedTokens;
  }

  return cachedTokens;
}

// Save/overwrite access_token, refresh_token & expires_at atomically in bling_tokens DB + JSON backup
export function saveBlingTokens(tokens: BlingTokens): void {
  const obtainedAt = tokens.obtained_at || Date.now();
  const expiresInSec = Number(tokens.expires_in) || 21600;
  const expiresAt = tokens.expires_at ?? (obtainedAt + (tokens.access_token ? expiresInSec * 1000 : 0));

  const stored = upsertBlingTokenInDb({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    expires_at: expiresAt,
    expires_in: expiresInSec,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || '',
    obtained_at: obtainedAt
  });

  cachedTokens = {
    access_token: stored.access_token,
    refresh_token: stored.refresh_token || undefined,
    expires_in: stored.expires_in,
    expires_at: stored.expires_at,
    token_type: stored.token_type,
    scope: stored.scope,
    obtained_at: stored.obtained_at
  };

  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(cachedTokens, null, 2), 'utf-8');
    console.log(`[Bling DB] Tokens salvos/sobrescritos em bling_tokens (expira em ${stored.expires_at_iso}).`);
  } catch (err) {
    console.error('[Bling] Could not mirror tokens to disk:', err);
  }
}

// Clear tokens from bling_tokens DB & cache
export function clearBlingTokens(): void {
  cachedTokens = null;
  clearBlingTokenFromDb();
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      fs.unlinkSync(TOKENS_FILE);
    }
  } catch (err) {
    console.warn('[Bling] Could not delete token file:', err);
  }
}

function getClientCredentials() {
  const clientId = (process.env.BLING_CLIENT_ID || '66ada183edd39b7215178f3d05bbb4b13c013fdd').trim();
  const clientSecret = (process.env.BLING_CLIENT_SECRET || '92efd4ff0b3ca6219adf7ecdc2df633bece0925c4f4c888f071065eaa046').trim();
  const state = (process.env.BLING_STATE || '2b41de06512249e4b701e9c4fcdcef0e').trim();
  return { clientId, clientSecret, state };
}

/**
 * Exchange Authorization Code for Access & Refresh Tokens
 */
export async function exchangeCodeForTokens(code: string, redirectUri?: string): Promise<BlingTokens> {
  const { clientId, clientSecret } = getClientCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const bodyParams = new URLSearchParams();
  bodyParams.append('grant_type', 'authorization_code');
  bodyParams.append('code', code.trim());
  if (redirectUri) {
    bodyParams.append('redirect_uri', redirectUri);
  }

  console.log(`[Bling] Exchanging code for token with client_id: ${clientId}`);

  let res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'StreetStore/1.0'
    },
    body: bodyParams.toString()
  });

  if (res.status === 403) {
    res = await fetch(BLING_TOKEN_FALLBACK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'StreetStore/1.0'
      },
      body: bodyParams.toString()
    });
  }

  const responseText = await res.text();
  let json: any;
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`Bling token endpoint returned non-JSON [${res.status}]: ${responseText}`);
  }

  if (!res.ok || json.error) {
    console.error('[Bling Token Error]:', json);
    const errDesc = json.error?.message || json.error_description || json.error || responseText;
    throw new Error(`Erro Bling OAuth: ${errDesc}`);
  }

  const obtainedAt = Date.now();
  const expiresInSec = Number(json.expires_in) || 21600; // 6 hours
  const expiresAt = obtainedAt + (json.expires_in ? expiresInSec * 1000 : BLING_ACCESS_TTL_MS);

  const tokenData: BlingTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: expiresInSec,
    expires_at: expiresAt,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || '',
    obtained_at: obtainedAt
  };

  saveBlingTokens(tokenData);
  return tokenData;
}

/**
 * Refresh access_token using rolling refresh_token (single-flight lock prevents parallel race conditions).
 * Overwrites BOTH access_token & refresh_token and sets new expires_at = now + 6 hours in bling_tokens.
 */
export async function refreshBlingToken(): Promise<BlingTokens> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    const tokens = loadBlingTokens();
    if (!tokens?.refresh_token) {
      throw new Error('Nenhum refresh_token disponível no banco para renovar sessão do Bling.');
    }

    const { clientId, clientSecret } = getClientCredentials();
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const bodyParams = new URLSearchParams();
    bodyParams.append('grant_type', 'refresh_token');
    bodyParams.append('refresh_token', tokens.refresh_token);

    console.log('[Bling] Renovando par de tokens (access_token + refresh_token) via OAuth v3...');

    let res = await fetch(BLING_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'StreetStore/1.0'
      },
      body: bodyParams.toString()
    });

    if (res.status === 403) {
      res = await fetch(BLING_TOKEN_FALLBACK_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'StreetStore/1.0'
        },
        body: bodyParams.toString()
      });
    }

    const responseText = await res.text();
    let json: any;
    try {
      json = JSON.parse(responseText);
    } catch {
      throw new Error(`Bling refresh endpoint returned non-JSON [${res.status}]: ${responseText}`);
    }

    if (!res.ok || json.error || !json.access_token) {
      const errorMsg = json.error?.message || json.error_description || json.error || responseText;
      const isInvalidGrant = String(errorMsg).includes('invalid_grant') || String(responseText).includes('invalid_grant');

      if (isInvalidGrant) {
        console.warn('[Bling] Refresh token inválido ou expirado (invalid_grant). Limpando registro de bling_tokens.');
        clearBlingTokens();
      }
      throw new Error(`Erro ao renovar token Bling: ${errorMsg}`);
    }

    const now = Date.now();
    const expiresInSec = Number(json.expires_in) || 21600; // 6 hours
    const expiresAt = now + (json.expires_in ? expiresInSec * 1000 : BLING_ACCESS_TTL_MS);

    // CRITICAL BLING v3 RULE: Overwrite BOTH access_token and the new refresh_token + expires_at (now + 6h)
    const newTokens: BlingTokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || tokens.refresh_token,
      expires_in: expiresInSec,
      expires_at: expiresAt,
      token_type: json.token_type || 'Bearer',
      scope: json.scope || tokens.scope,
      obtained_at: now
    };

    saveBlingTokens(newTokens);
    return newTokens;
  })().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

/**
 * Função Automática (getValidBlingToken):
 * Busca o token no banco (bling_tokens). Se faltar menos de 10 minutos para o expires_at
 * (ou se já venceu), renova automaticamente antes de retornar o access_token.
 */
export async function getValidBlingToken(): Promise<string> {
  if (
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  ) {
    return getFirestoreBlingToken();
  }

  const tokens = loadBlingTokens();
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    throw new Error('Bling ERP não conectado. Realize a autorização inicial via OAuth (/bling/callback).');
  }

  const expiresAtMs =
    tokens.expires_at !== undefined
      ? tokens.expires_at
      : tokens.obtained_at + (tokens.expires_in || 21600) * 1000;

  const timeRemainingMs = expiresAtMs - Date.now();
  const needsRefresh = !tokens.access_token || timeRemainingMs <= TEN_MINUTES_MS;

  if (needsRefresh) {
    if (tokens.refresh_token) {
      try {
        const refreshed = await refreshBlingToken();
        return refreshed.access_token;
      } catch (err: any) {
        const isInvalidGrant = String(err?.message || '').includes('invalid_grant');
        if (isInvalidGrant || !tokens.access_token || timeRemainingMs <= 0) {
          throw new Error(err?.message || 'Sessão do Bling expirada (invalid_grant).');
        }
        console.warn('[Bling] Aviso ao renovar antecipadamente (<10min):', err?.message || err);
        return tokens.access_token;
      }
    } else {
      clearBlingTokens();
      throw new Error('Sessão do Bling expirada sem refresh_token.');
    }
  }

  return tokens.access_token;
}

export const getValidAccessToken = getValidBlingToken;

/**
 * Automatically ensures Bling OAuth session is valid/refreshed in background (without any manual click)
 */
export async function ensureBlingAuthorized(): Promise<boolean> {
  const tokens = loadBlingTokens();
  if (!tokens) return false;
  try {
    const token = await getValidBlingToken();
    return Boolean(token);
  } catch (err: any) {
    console.warn('[Bling Auto-Auth] Aviso ao validar/renovar sessão:', err?.message || err);
    return false;
  }
}

// Track last verified status so /api/bling/status can confirm live token health without spamming Bling
let lastVerifiedAuth: {
  token: string;
  valid: boolean;
  error?: string;
  checkedAt: number;
} | null = null;

export function clearBlingAuthCache(): void {
  lastVerifiedAuth = null;
}

/**
 * Fetch authenticated resource from Bling v3 API
 */
export async function fetchFromBling(endpoint: string, options: RequestInit = {}, retryCount: number = 0): Promise<any> {
  const token = await getValidAccessToken();
  const url = endpoint.startsWith('http') ? endpoint : `${BLING_API_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (res.status === 429 && retryCount < 3) {
    const waitMs = 600 * (retryCount + 1);
    console.warn(`[Bling] 429 Rate Limit em ${endpoint}. Aguardando ${waitMs}ms antes de tentar novamente...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return fetchFromBling(endpoint, options, retryCount + 1);
  }

  if (!res.ok) {
    const errorText = await res.text();
    if (res.status === 401) {
      const currentTokens = loadBlingTokens();
      if (currentTokens?.refresh_token) {
        console.log('[Bling] 401 recebido. Tentando renovação de token...');
        try {
          const refreshed = await refreshBlingToken();
          const retryRes = await fetch(url, {
            ...options,
            headers: {
              'Authorization': `Bearer ${refreshed.access_token}`,
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              ...(options.headers || {})
            }
          });
          if (retryRes.ok) {
            lastVerifiedAuth = { token: refreshed.access_token, valid: true, checkedAt: Date.now() };
            return retryRes.json();
          }
          if (retryRes.status === 401) {
            clearBlingTokens();
            clearBlingAuthCache();
            throw new Error('Token do Bling inválido ou expirado (401). Por favor, reconecte via OAuth.');
          }
        } catch (refreshErr: any) {
          console.warn('[Bling] Tentativa de renovação pós-401 falhou:', refreshErr?.message || refreshErr);
          clearBlingTokens();
          clearBlingAuthCache();
          throw new Error('Sessão do Bling expirada ou inválida (401). Por favor, reconecte via OAuth.');
        }
      } else {
        console.warn('[Bling] 401 recebido e não há refresh_token. Limpando token inválido.');
        clearBlingTokens();
        clearBlingAuthCache();
        throw new Error('Token do Bling inválido ou expirado (401). Por favor, autorize novamente via OAuth.');
      }
    }
    throw new Error(`Bling API [${res.status}]: ${errorText}`);
  }

  lastVerifiedAuth = { token, valid: true, checkedAt: Date.now() };
  return res.json();
}

/**
 * Register all Bling ERP routes on the Express app
 */
export function registerBlingRoutes(app: express.Express, hooks?: { onTokensUpdated?: () => void }) {
  const { clientId, state } = getClientCredentials();

  function resolveAppUrl(req: Request): string {
    const envUrl = process.env.APP_URL;
    if (envUrl) return envUrl.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || req.get('host');
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  // 1. Get OAuth Authorization URL & Status Info
  app.get('/api/bling/auth-url', (req: Request, res: Response) => {
    const appUrl = resolveAppUrl(req);
    const redirectUri = `${appUrl}/auth/callback`;

    const authUrlWithoutRedirect = `${BLING_AUTH_BASE}?response_type=code&client_id=${clientId}&state=${state}`;
    const authUrlWithRedirect = `${BLING_AUTH_BASE}?response_type=code&client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    res.json({
      url: authUrlWithoutRedirect,
      urlWithRedirect: authUrlWithRedirect,
      redirectUri,
      clientId,
      state
    });
  });

  // Direct 1-click redirect to Bling authorization
  app.get('/api/bling/authorize', (req: Request, res: Response) => {
    const appUrl = resolveAppUrl(req);
    const redirectUri = `${appUrl}/auth/callback`;
    const authUrl = req.query.strict === 'true'
      ? `${BLING_AUTH_BASE}?response_type=code&client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
      : `${BLING_AUTH_BASE}?response_type=code&client_id=${clientId}&state=${state}`;
    res.redirect(authUrl);
  });

  // Helper to verify a candidate token against Bling API v3 before saving
  async function validateAndSaveToken(rawInput: string, refreshToken?: string, expiresIn: number = 21600, scope: string = '', redirectUri?: string) {
    const trimmed = rawInput.trim();

    // If user pasted a callback URL (?code=...) or explicitly flagged code, exchange it via OAuth
    let extractedCode: string | null = null;
    if (trimmed.includes('code=')) {
      try {
        const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://dummy.local/?${trimmed.replace(/^\?/, '')}`);
        extractedCode = parsed.searchParams.get('code');
      } catch {
        const m = trimmed.match(/[?&]code=([^&\s]+)/);
        if (m) extractedCode = m[1];
      }
    }

    if (extractedCode) {
      const tokens = await exchangeCodeForTokens(extractedCode, redirectUri);
      clearBlingAuthCache();
      return { tokens, mode: 'code_exchange' as const };
    }

    const candidate: BlingTokens = {
      access_token: trimmed,
      refresh_token: refreshToken ? String(refreshToken).trim() : undefined,
      expires_in: Number(expiresIn) || 21600,
      token_type: 'Bearer',
      scope,
      obtained_at: Date.now()
    };

    // Test the token live on Bling v3 API
    const testRes = await fetch(`${BLING_API_BASE}/produtos?pagina=1&limite=1`, {
      headers: {
        'Authorization': `Bearer ${candidate.access_token}`,
        'Accept': 'application/json'
      }
    });

    if (testRes.ok) {
      saveBlingTokens(candidate);
      lastVerifiedAuth = { token: candidate.access_token, valid: true, checkedAt: Date.now() };
      return { tokens: candidate, mode: 'direct_token' as const };
    }

    // If 401 and input looks like an OAuth authorization code (40 hex chars without refresh_token), try exchanging it as code as fallback
    if (testRes.status === 401 && !refreshToken && /^[a-f0-9]{32,64}$/i.test(trimmed)) {
      try {
        const exchanged = await exchangeCodeForTokens(trimmed);
        clearBlingAuthCache();
        return { tokens: exchanged, mode: 'code_exchange' as const };
      } catch {
        // Fall through to clear invalid token message
      }
    }

    const errText = await testRes.text().catch(() => '');
    clearBlingTokens();
    clearBlingAuthCache();
    throw new Error(`Token rejeitado pelo Bling (${testRes.status}). Gere um novo token clicando em "Autorizar Conexão no Bling ERP (1 Clique)". Detalhe: ${errText.slice(0, 120)}`);
  }

  // Set or update Bling API tokens directly (supports access_token, callback URL with ?code=, or OAuth code)
  app.post('/api/bling/token', async (req: Request, res: Response) => {
    try {
      const { access_token, refresh_token, expires_in = 21600, code } = req.body;
      const inputVal = String(code || access_token || '').trim();
      if (!inputVal) {
        return res.status(400).json({ success: false, error: 'Informe o token de acesso ou link de retorno com ?code= do Bling.' });
      }
      const appUrl = resolveAppUrl(req);
      const { mode } = await validateAndSaveToken(inputVal, refresh_token, Number(expires_in), '', `${appUrl}/auth/callback`);
      hooks?.onTokensUpdated?.();
      res.json({
        success: true,
        mode,
        message: 'Bling ERP validado e conectado com sucesso!'
      });
    } catch (err: any) {
      res.status(401).json({
        success: false,
        error: err.message || 'Token do Bling inválido ou expirado.'
      });
    }
  });

  // 2. OAuth Callback Route (/bling/callback & /auth/callback - exchanges code for initial tokens & saves to DB)
  app.get(['/bling/callback', '/bling/callback/', '/auth/callback', '/auth/callback/'], async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const reqState = req.query.state as string;
    const error = req.query.error as string;

    console.log(`[Bling Callback] Path: ${req.path}, Received code: ${code ? code.slice(0, 8) + '...' : 'none'}, state: ${reqState}, error: ${error}`);

    if (error) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Erro de Autenticação Bling</title>
            <style>
              body { background: #0E0E0E; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .card { background: #181818; border: 1px solid #333; border-radius: 16px; padding: 32px; max-width: 480px; text-align: center; }
              h2 { color: #E50914; margin-top: 0; }
              p { color: #888; font-size: 14px; }
              button { background: #E50914; color: #fff; border: 0; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>Falha na Autorização</h2>
              <p>O Bling retornou o seguinte erro: ${error}</p>
              <button onclick="window.close()">Fechar Janela</button>
            </div>
          </body>
        </html>
      `);
    }

    if (!code) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="utf-8" /><title>Código não informado</title></head>
          <body style="background:#0E0E0E;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
            <div style="background:#181818;border:1px solid #333;border-radius:16px;padding:32px;text-align:center;">
              <h3 style="color:#E50914;">Nenhum código de autorização recebido</h3>
              <p style="color:#888;">Por favor, tente autorizar novamente pela Street Store.</p>
              <button onclick="window.close()" style="background:#333;color:#fff;border:0;padding:8px 16px;border-radius:8px;cursor:pointer;">Fechar</button>
            </div>
          </body>
        </html>
      `);
    }

    try {
      // Exchange authorization code for token using identical APP_URL resolution & matched callback path
      const appUrl = resolveAppUrl(req);
      const callbackPath = req.path.startsWith('/bling/callback') ? '/bling/callback' : '/auth/callback';
      const redirectUri = `${appUrl}${callbackPath}`;

      await exchangeCodeForTokens(code, redirectUri);
      hooks?.onTokensUpdated?.();

      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <title>Bling ERP Conectado com Sucesso</title>
            <style>
              body {
                background: #0E0E0E;
                color: #ffffff;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .card {
                background: #141414;
                border: 1px solid #282828;
                border-radius: 16px;
                padding: 40px;
                max-width: 440px;
                text-align: center;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8);
              }
              .badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 60px;
                height: 60px;
                background: #166534;
                color: #4ade80;
                border-radius: 50%;
                font-size: 28px;
                margin-bottom: 20px;
              }
              h2 {
                font-size: 20px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 1px;
                margin: 0 0 8px 0;
                color: #fff;
              }
              p {
                color: #9ca3af;
                font-size: 13px;
                line-height: 1.5;
                margin: 0 0 20px 0;
              }
              .status {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: #22c55e;
                font-weight: 700;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <div class="badge">✓</div>
              <h2>Bling ERP Conectado!</h2>
              <p>Sua conta da Street Store agora está autorizada e sincronizada com o Bling ERP v3.</p>
              <div class="status">Sincronizando dados com o site...</div>
              <script>
                if (window.opener) {
                  window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'bling' }, '*');
                  setTimeout(function() {
                    window.close();
                  }, 1200);
                } else {
                  setTimeout(function() {
                    window.location.href = '/';
                  }, 1500);
                }
              </script>
            </div>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error('[Bling Callback Exchange Error]:', err);
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="utf-8" /><title>Erro na troca do token Bling</title></head>
          <body style="background:#0E0E0E;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
            <div style="background:#181818;border:1px solid #441111;border-radius:16px;padding:32px;max-width:500px;text-align:center;">
              <h3 style="color:#E50914;">Erro ao trocar código por token no Bling</h3>
              <p style="color:#bbb;font-size:13px;">${err.message || String(err)}</p>
              <p style="color:#888;font-size:12px;">Dica: Verifique se a URL de redirecionamento está configurada no app do Bling ou cole o token manualmente no painel.</p>
              <button onclick="window.close()" style="background:#E50914;color:#fff;border:0;padding:10px 20px;border-radius:8px;font-weight:bold;cursor:pointer;">Fechar</button>
            </div>
          </body>
        </html>
      `);
    }
  });

  // 3. Manual exchange of code via API
  app.post('/api/bling/exchange-code', async (req: Request, res: Response) => {
    try {
      const { code, redirectUri } = req.body;
      if (!code) {
        return res.status(400).json({ error: 'Parâmetro code é obrigatório' });
      }
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      hooks?.onTokensUpdated?.();
      res.json({
        success: true,
        message: 'Conectado com sucesso ao Bling ERP!',
        tokens: {
          scope: tokens.scope,
          expires_in: tokens.expires_in,
          obtained_at: tokens.obtained_at
        }
      });
    } catch (err: any) {
      console.error('[API Exchange Error]:', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Falha ao trocar código do Bling'
      });
    }
  });

  // 4. Manual set token (direct paste for instant connection)
  app.post('/api/bling/set-token', async (req: Request, res: Response) => {
    try {
      const { access_token, refresh_token, expires_in, scope } = req.body;
      if (!access_token) {
        return res.status(400).json({ success: false, error: 'access_token é obrigatório' });
      }

      const appUrl = resolveAppUrl(req);
      const { tokens } = await validateAndSaveToken(
        String(access_token),
        refresh_token,
        Number(expires_in) || 21600,
        scope || '',
        `${appUrl}/auth/callback`
      );
      hooks?.onTokensUpdated?.();

      res.json({
        success: true,
        message: 'Token do Bling validado e configurado com sucesso!',
        status: {
          connected: true,
          expires_in: tokens.expires_in
        }
      });
    } catch (err: any) {
      res.status(401).json({ success: false, error: err.message });
    }
  });

  // 5. Connection Status (verifies token health against Bling API v3)
  app.get('/api/bling/status', async (req: Request, res: Response) => {
    const appUrl = resolveAppUrl(req);
    const redirectUri = `${appUrl}/auth/callback`;
    const authorizeUrl = `${BLING_AUTH_BASE}?response_type=code&client_id=${clientId}&state=${state}`;

    let tokens = loadBlingTokens();
    if (!tokens || !tokens.access_token) {
      return res.json({
        connected: false,
        clientId,
        redirectUri,
        authorizeUrl
      });
    }

    const forceVerify = req.query.verify === 'true';
    const cacheRecent =
      !forceVerify &&
      lastVerifiedAuth &&
      lastVerifiedAuth.token === tokens.access_token &&
      Date.now() - lastVerifiedAuth.checkedAt < 25 * 1000;

    if (!cacheRecent) {
      try {
        await fetchFromBling('/produtos?pagina=1&limite=1');
        tokens = loadBlingTokens();
      } catch (verifyErr: any) {
        return res.json({
          connected: false,
          tokenInvalid: true,
          error: verifyErr?.message || 'Token do Bling expirado ou inválido. Reconecte via OAuth.',
          clientId,
          redirectUri,
          authorizeUrl
        });
      }
    }

    if (!tokens || !tokens.access_token) {
      return res.json({
        connected: false,
        tokenInvalid: true,
        clientId,
        redirectUri,
        authorizeUrl
      });
    }

    const expiresInMs = (tokens.expires_in || 21600) * 1000;
    const expiresAt = tokens.expires_at ?? (tokens.obtained_at + expiresInMs);
    const isExpired = Date.now() >= expiresAt;

    res.json({
      connected: true,
      clientId,
      redirectUri,
      callbackUri: `${appUrl}/bling/callback`,
      authorizeUrl,
      scope: tokens.scope,
      hasRefreshToken: Boolean(tokens.refresh_token),
      isExpired,
      expiresAt: new Date(expiresAt).toISOString(),
      obtainedAt: new Date(tokens.obtained_at).toISOString()
    });
  });

  // 5b. Keep-Alive Cron Endpoint mounted on /api/bling/keep-alive & blingRouter
  blingRouter.get('/keep-alive', async (req: Request, res: Response) => {
    try {
      const cronSecret = (process.env.CRON_SECRET || '').trim();
      if (cronSecret) {
        const authHeader = (req.headers.authorization || '').trim();
        const xCron = typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'].trim() : '';
        const qSecret = typeof req.query.secret === 'string' ? req.query.secret.trim() : '';
        if (authHeader !== `Bearer ${cronSecret}` && xCron !== cronSecret && qSecret !== cronSecret) {
          return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
      }
      const token = await getValidBlingToken();
      return res.status(200).json({
        ok: true,
        refreshedOrValid: Boolean(token),
        checkedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(200).json({
        ok: false,
        error: message,
        checkedAt: new Date().toISOString(),
      });
    }
  });

  // 5c. Automated Auto-Loop / Paginated Catalog Sync (/api/bling/sync)
  blingRouter.all('/sync', async (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
    }

    if (process.env.CRON_SECRET?.trim()) {
      const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
      const headerCron = typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'] : '';
      const headerAdmin = typeof req.headers['x-admin-secret'] === 'string' ? req.headers['x-admin-secret'] : '';
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearerSecret = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      const providedSecret = querySecret || headerCron || headerAdmin || bearerSecret;

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
          maxExecutionMs: maxMsRaw > 0 ? Math.min(55000, maxMsRaw) : (process.env.VERCEL ? 7500 : 45000),
        });
        return res.status(200).json(result);
      }

      const pagina = Math.max(1, parseInt(String(req.query.pagina), 10) || 1);
      const result = await syncBlingProdutosPageToFirestore(pagina);
      return res.status(200).json(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Express /api/bling/sync Error]:', message);
      return res.status(500).json({ success: false, error: message });
    }
  });

  // 5d. Batch Catalog Sync (Bling API v3 -> Firestore WriteBatch), protected by CRON_SECRET
  blingRouter.all('/sync-produtos', async (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
    }

    if (process.env.CRON_SECRET?.trim()) {
      const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
      const headerCron = typeof req.headers['x-cron-secret'] === 'string' ? req.headers['x-cron-secret'] : '';
      const headerAdmin = typeof req.headers['x-admin-secret'] === 'string' ? req.headers['x-admin-secret'] : '';
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearerSecret = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
      const providedSecret = querySecret || headerCron || headerAdmin || bearerSecret;

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
      const paginaRaw = typeof req.query.pagina === 'string' ? req.query.pagina : '1';
      const pagina = Math.max(1, parseInt(paginaRaw, 10) || 1);
      const resultado = await syncBlingProdutosPageToFirestore(pagina);
      return res.status(200).json(resultado);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Express /api/bling/sync-produtos Error]:', message);
      return res.status(500).json({ error: message });
    }
  });

  app.use('/api/bling', blingRouter);

  // 6. Fetch Products from Bling API v3 (Pulls up to 1500 active products with real stock & images)
  app.get('/api/bling/products', async (req: Request, res: Response) => {
    try {
      const pagina = req.query.pagina ? String(req.query.pagina) : '1';
      const limiteParam = parseInt(String(req.query.limite || '100'), 10);
      const maxProducts = Math.min(1500, parseInt(String(req.query.max || '1500'), 10) || 1500);
      const includeZeroStock = req.query.includeZeroStock === 'true';
      const fetchAll = req.query.all === 'true' || req.query.todos === 'true' || limiteParam > 100 || (!req.query.pagina && !req.query.limite);

      let rawProducts: any[] = [];
      if (fetchAll) {
        const seenIds = new Set<number>();
        const pushUnique = (items: any[]) => {
          for (const it of items) {
            if (it?.situacao === 'I' || it?.situacao === 'E') continue;
            if (it?.id && !seenIds.has(it.id) && rawProducts.length < maxProducts) {
              seenIds.add(it.id);
              rawProducts.push(it);
            }
          }
        };

        // 1. Fetch newest products first (criterio=1: Últimos incluídos, pages 1..3)
        for (let p = 1; p <= 3 && rawProducts.length < maxProducts; p++) {
          const latestData = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=1&tipo=T`);
          const latestItems = latestData?.data || [];
          if (latestItems.length > 0) pushUnique(latestItems);
          if (latestItems.length < 100) break;
          await new Promise(resolve => setTimeout(resolve, 160));
        }

        // 2. Paginate all active products (criterio=2: Ativos) up to 1500 items
        for (let p = 1; p <= 16 && rawProducts.length < maxProducts; p++) {
          try {
            const pageData = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=2&tipo=T`);
            const items = pageData?.data || [];
            if (items.length > 0) pushUnique(items);
            if (items.length < 100) break;
            await new Promise(resolve => setTimeout(resolve, 160));
          } catch (pageErr: any) {
            console.warn(`[Bling Products] Stopped pagination at page ${p}:`, pageErr?.message || pageErr);
            break;
          }
        }
      } else {
        const data = await fetchFromBling(`/produtos?pagina=${pagina}&limite=${limiteParam}&criterio=2`);
        rawProducts = (data?.data || []).slice(0, maxProducts);
      }

      // Fetch real stock balances in chunks of 50 product IDs
      const stockMap: Record<number, number> = {};
      let stockApiSucceeded = false;
      const allIds = rawProducts.map((p: any) => p.id).filter(Boolean);
      for (let i = 0; i < allIds.length; i += 50) {
        const chunk = allIds.slice(i, i + 50);
        try {
          const qs = chunk.map((id: number) => `idsProdutos[]=${id}`).join('&');
          const stockData = await fetchFromBling(`/estoques/saldos?${qs}`);
          stockApiSucceeded = true;
          (stockData.data || []).forEach((item: any) => {
            const pId = item.produto?.id;
            const balance = item.saldoVirtualTotal ?? item.saldoFisicoTotal ?? item.saldoFisico ?? 0;
            if (pId) stockMap[pId] = Number(balance) || 0;
          });
          if (i + 50 < allIds.length) {
            await new Promise(resolve => setTimeout(resolve, 120));
          }
        } catch (stockErr) {
          console.warn('[Bling] Could not fetch stock balances chunk:', stockErr);
        }
      }

      // Map to consistent format extracting all Bling image fields & real stock
      const formatted = rawProducts.map((p: any) => {
        const directImages = extractImagesFromBlingItem(p);
        const directFullRes = directImages.filter(u => !isThumbnailLikeUrl(u));
        const cachedImgs = getBlingImagesForProduct({ name: p.nome, sku: p.codigo, blingId: String(p.id) }) || [];
        const cachedFullRes = cachedImgs.filter(u => !isThumbnailLikeUrl(u));
        const combinedFullRes = Array.from(new Set([...directFullRes, ...cachedFullRes]));
        const storedImages = combinedFullRes.length > 0
          ? combinedFullRes
          : (cachedImgs.length > 0 ? cachedImgs : directImages);
        const realStock = stockMap[p.id] !== undefined
          ? stockMap[p.id]
          : (p.estoque?.saldoVirtualTotal ?? p.estoque?.saldoFisicoTotal ?? p.estoque?.saldoFisico ?? (stockApiSucceeded ? 0 : 0));
        return {
          id: `bling-${p.id}`,
          blingId: p.id,
          idProdutoPai: p.idProdutoPai || null,
          name: p.nome,
          code: p.codigo,
          sku: p.codigo,
          price: p.preco || 0,
          stock: Math.max(0, Number(realStock) || 0),
          stockCount: Math.max(0, Number(realStock) || 0),
          status: p.situacao,
          format: p.formato,
          type: p.tipo,
          shortDescription: p.descricaoCurta || '',
          imageUrl: storedImages[0] || '',
          images: storedImages,
        };
      });

      const visible = formatted.filter((p: any) => !isProductHidden(p) && (includeZeroStock || p.stock > 0));

      res.json({
        success: true,
        count: visible.length,
        products: visible,
        rawCount: rawProducts.length
      });
    } catch (err: any) {
      console.error('[Bling Products Error]:', err);
      const isAuthErr = String(err?.message || '').includes('401') || String(err?.message || '').includes('OAuth');
      res.status(isAuthErr ? 401 : 500).json({
        success: false,
        error: err.message || 'Falha ao buscar produtos do Bling ERP',
        connected: Boolean(loadBlingTokens())
      });
    }
  });

  // 7. Fetch Sales Orders from Bling API v3
  app.get('/api/bling/orders', async (req: Request, res: Response) => {
    try {
      const pagina = req.query.pagina || '1';
      const limite = req.query.limite || '50';

      const data = await fetchFromBling(`/pedidos/vendas?pagina=${pagina}&limite=${limite}`);
      const rawOrders = data.data || [];

      const formatted = rawOrders.map((o: any) => ({
        id: o.id,
        numero: o.numero,
        data: o.data,
        total: o.total,
        situacao: o.situacao?.valor || o.situacao?.id || 'Pendente',
        cliente: o.contato?.nome || 'Cliente Street Store',
        documento: o.contato?.numeroDocumento || '',
        itens: (o.itens || []).map((it: any) => ({
          codigo: it.codigo,
          descricao: it.descricao,
          quantidade: it.quantidade,
          valor: it.valor
        }))
      }));

      res.json({
        success: true,
        count: formatted.length,
        orders: formatted
      });
    } catch (err: any) {
      console.error('[Bling Orders Error]:', err);
      // Fallback to local stored orders
      const localOrders = loadLocalBlingOrders();
      res.json({
        success: true,
        count: localOrders.length,
        orders: localOrders
      });
    }
  });

  // 7.1 Create Sales Order in Bling ERP
  app.post('/api/bling/orders', async (req: Request, res: Response) => {
    try {
      const result = await createBlingOrder(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Falha ao criar pedido no Bling'
      });
    }
  });

  // 8. Fetch Stock Balances
  app.get('/api/bling/stock', async (_req: Request, res: Response) => {
    try {
      const data = await fetchFromBling('/estoques/saldos?pagina=1&limite=100');
      res.json({
        success: true,
        stock: data.data || []
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Falha ao buscar estoque do Bling'
      });
    }
  });

  // 9. Disconnect / Logout Bling
  app.post('/api/bling/disconnect', (_req: Request, res: Response) => {
    clearBlingTokens();
    res.json({ success: true, message: 'Bling desconectado com sucesso.' });
  });
}

const LOCAL_ORDERS_FILE = path.resolve(process.env.VERCEL ? '/tmp' : process.cwd(), '.bling_orders.json');

export interface BlingOrderParams {
  numero?: string | number;
  customer: {
    name: string;
    email: string;
    cpf?: string;
    phone?: string;
  };
  shippingAddress?: {
    address: string;
    number: string;
    locality?: string;
    city: string;
    province: string;
    zipcode: string;
    complement?: string;
  };
  shippingCarrier?: string;
  shippingCost?: number;
  items: Array<{
    id?: string | number;
    name: string;
    sku?: string;
    quantity: number;
    price: number;
    selectedSize?: string;
  }>;
  total: number;
  paymentMethod: 'pix' | 'credit_card' | string;
  paymentId?: string | number;
}

export function loadLocalBlingOrders(): any[] {
  try {
    if (fs.existsSync(LOCAL_ORDERS_FILE)) {
      const raw = fs.readFileSync(LOCAL_ORDERS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[Bling] Could not read local orders file:', err);
  }
  return [];
}

export function saveLocalBlingOrder(order: any): void {
  try {
    const list = loadLocalBlingOrders();
    const updated = [order, ...list.filter((o: any) => o.numero !== order.numero && o.id !== order.id)];
    fs.writeFileSync(LOCAL_ORDERS_FILE, JSON.stringify(updated.slice(0, 200), null, 2), 'utf-8');
  } catch (err) {
    console.error('[Bling] Could not save order to local store:', err);
  }
}

/**
 * Creates sales order in Bling ERP (API v3 /pedidos/vendas) with local store backup
 */
export async function createBlingOrder(params: BlingOrderParams): Promise<{
  success: boolean;
  orderNumber: string;
  orderId: string | number;
  status: string;
  order: any;
  blingSynced: boolean;
  error?: string;
}> {
  const orderNumber = params.numero 
    ? String(params.numero) 
    : `ST-${Date.now().toString().slice(-6)}`;
  
  const todayStr = new Date().toISOString().split('T')[0];

  const blingPayload = {
    numero: parseInt(orderNumber.replace(/\D/g, '') || String(Date.now()).slice(-5), 10),
    data: todayStr,
    dataPrevista: todayStr,
    contato: {
      nome: params.customer.name || 'Cliente Street Store',
      tipoPessoa: 'F',
      numeroDocumento: (params.customer.cpf || '').replace(/\D/g, ''),
      email: params.customer.email,
      telefone: (params.customer.phone || '').replace(/\D/g, '')
    },
    itens: params.items.map((it) => ({
      codigo: it.sku || `SKU-${String(it.id || 'ITEM').replace(/\D/g, '') || '01'}`,
      descricao: `${it.name}${it.selectedSize ? ` - Tam ${it.selectedSize}` : ''}`,
      quantidade: it.quantity || 1,
      valor: it.price || 139.90
    })),
    transporte: {
      transportadora: {
        nome: params.shippingCarrier || 'Melhor Envio'
      },
      etiqueta: params.shippingAddress ? {
        nome: params.customer.name || 'Cliente Street Store',
        endereco: params.shippingAddress.address || '',
        numero: params.shippingAddress.number || 'S/N',
        complemento: params.shippingAddress.complement || '',
        bairro: params.shippingAddress.locality || '',
        municipio: params.shippingAddress.city || '',
        uf: params.shippingAddress.province || 'MG',
        cep: (params.shippingAddress.zipcode || '').replace(/\D/g, '')
      } : undefined
    },
    pagamento: {
      formas: [
        {
          valor: params.total,
          formaPagamento: {
            id: 1
          }
        }
      ]
    },
    observacoes: `Street Store Oficial - Pedido #${orderNumber} | Pagamento: ${params.paymentMethod} (${params.paymentId || 'Aprovado Mercado Pago'}) | Frete: ${params.shippingCarrier || 'Melhor Envio'}`
  };

  let blingSynced = false;
  let remoteId: any = orderNumber;

  try {
    const tokens = loadBlingTokens();
    if (tokens?.access_token) {
      console.log(`[Bling] Submitting order #${orderNumber} to Bling API v3...`);
      const res = await fetchFromBling('/pedidos/vendas', {
        method: 'POST',
        body: JSON.stringify(blingPayload)
      });
      if (res?.data?.id) {
        remoteId = res.data.id;
        blingSynced = true;
        console.log(`[Bling] Order #${orderNumber} registered successfully in Bling ERP (ID: ${remoteId})`);
      }
    }
  } catch (apiErr: any) {
    console.warn('[Bling] Notice syncing order to remote Bling API (saved locally):', apiErr.message);
  }

  const storedOrder = {
    id: remoteId,
    numero: orderNumber,
    data: todayStr,
    total: params.total,
    situacao: 'Em Aberto / Pago',
    cliente: params.customer.name,
    email: params.customer.email,
    documento: params.customer.cpf || '',
    transporte: params.shippingCarrier || 'Melhor Envio',
    rastreio: null,
    itens: params.items.map((it) => ({
      codigo: it.sku || `SKU-${it.id || 'ITEM'}`,
      descricao: `${it.name}${it.selectedSize ? ` (${it.selectedSize})` : ''}`,
      quantidade: it.quantity,
      valor: it.price
    })),
    blingSynced,
    createdAt: new Date().toISOString()
  };

  saveLocalBlingOrder(storedOrder);

  return {
    success: true,
    orderNumber,
    orderId: remoteId,
    status: 'pago',
    order: storedOrder,
    blingSynced
  };
}
