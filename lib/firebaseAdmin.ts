import fs from 'fs';
import path from 'path';
import { App, cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

type ParsedServiceAccount = ServiceAccount & {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function parseServiceAccountFromEnv(): ParsedServiceAccount {
  const rawJsonOrBase64 = (
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    ''
  ).trim();

  if (rawJsonOrBase64) {
    let jsonString = rawJsonOrBase64;
    if (!rawJsonOrBase64.startsWith('{')) {
      try {
        jsonString = Buffer.from(rawJsonOrBase64, 'base64').toString('utf8').trim();
      } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT inválida: não é JSON nem Base64 válido.');
      }
    }

    let parsed: ParsedServiceAccount;
    try {
      parsed = JSON.parse(jsonString) as ParsedServiceAccount;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Falha ao fazer parse do JSON do Firebase Service Account: ${msg}`);
    }

    if (typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    if (!parsed.projectId && parsed.project_id) {
      parsed.projectId = parsed.project_id;
    }
    if (!parsed.clientEmail && parsed.client_email) {
      parsed.clientEmail = parsed.client_email;
    }
    if (!parsed.privateKey && parsed.private_key) {
      parsed.privateKey = parsed.private_key;
    }

    return parsed;
  }

  // Fallback para variáveis individuais da Vercel: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const rawPrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();

  if (projectId && clientEmail && rawPrivateKey) {
    const privateKey = rawPrivateKey.replace(/\\n/g, '\n');
    return {
      projectId,
      clientEmail,
      privateKey,
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }

  throw new Error(
    'Credenciais do Firebase Admin não configuradas. Defina FIREBASE_SERVICE_ACCOUNT (ou FIREBASE_SERVICE_ACCOUNT_KEY) em JSON/Base64 ou as variáveis individuais FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY.'
  );
}

let cachedProjectId = '';

function resolveDatabaseId(projectId?: string): string {
  const envDbId = (process.env.FIREBASE_DATABASE_ID || '').trim();
  if (envDbId) {
    return envDbId;
  }

  try {
    const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        projectId?: string;
        firestoreDatabaseId?: string;
      };
      if (
        parsed?.firestoreDatabaseId &&
        (!projectId || !parsed.projectId || parsed.projectId === projectId)
      ) {
        return parsed.firestoreDatabaseId;
      }
    }
  } catch {
    // Nunca crasha caso firebase-applet-config.json esteja ausente no bundle serverless
  }

  return '(default)';
}

export function getFirebaseAdminApp(): App {
  if (!getApps().length) {
    const serviceAccount = parseServiceAccountFromEnv();
    cachedProjectId = String(serviceAccount.projectId || serviceAccount.project_id || '');
    return initializeApp({
      credential: cert(serviceAccount),
    });
  }

  return getApps()[0];
}

/**
 * Retorna a instância do Firestore com privilégios Admin SDK.
 * Usa FIREBASE_DATABASE_ID, o banco provisionado se o projectId coincidir, ou "(default)".
 */
export function getAdminFirestore(): Firestore {
  const app = getFirebaseAdminApp();
  const projectId = cachedProjectId || app.options.projectId;
  const databaseId = resolveDatabaseId(projectId);

  if (databaseId && databaseId !== '(default)') {
    return getFirestore(app, databaseId);
  }

  return getFirestore(app);
}
