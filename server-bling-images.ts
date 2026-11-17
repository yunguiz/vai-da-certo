import fs from 'fs';
import path from 'path';
import { loadBlingTokens, fetchFromBling } from './server-bling';
import { Product } from './src/types';

const BUNDLED_IMAGES_STORE_FILE = path.resolve(process.cwd(), '.bling_product_images.json');
const IMAGES_STORE_FILE = process.env.VERCEL
  ? path.resolve('/tmp', '.bling_product_images.json')
  : BUNDLED_IMAGES_STORE_FILE;

const IMAGE_STORE_VERSION = 3;

export interface BlingImageStore {
  version?: number;
  updatedAt: string;
  bySku: Record<string, string[]>;
  byName: Record<string, string[]>;
  byId: Record<string, string[]>;
}

let cachedImageStore: BlingImageStore | null = null;
let lastSyncCompletedAt = 0;

export function getLastBlingImageSyncTime(): number {
  return lastSyncCompletedAt;
}

function isManualLocalUpload(url: string): boolean {
  const u = (url || '').trim();
  return u.startsWith('/assets/uploads/') || u.startsWith('/assets/aistudio/');
}

/**
 * Clears the cached Bling image store (preserving manual local file uploads by default)
 * and resets sync timestamp so original high-res images are re-fetched cleanly.
 */
export function clearImageCache(preserveManualUploads: boolean = true): BlingImageStore {
  const prev = cachedImageStore || (() => {
    try {
      if (fs.existsSync(IMAGES_STORE_FILE)) {
        return JSON.parse(fs.readFileSync(IMAGES_STORE_FILE, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return null;
  })();

  const fresh: BlingImageStore = {
    version: IMAGE_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    bySku: {},
    byName: {},
    byId: {}
  };

  if (preserveManualUploads && prev) {
    for (const bucket of ['bySku', 'byName', 'byId'] as const) {
      const src = prev[bucket] || {};
      for (const [k, urls] of Object.entries(src)) {
        if (Array.isArray(urls)) {
          const kept = urls.filter((u) => typeof u === 'string' && isManualLocalUpload(u));
          if (kept.length > 0) fresh[bucket][k] = kept;
        }
      }
    }
  }

  lastSyncCompletedAt = 0;
  saveImageStore(fresh);
  console.log('[Bling Images] Image cache cleared cleanly (high-res schema v2).');
  return fresh;
}

export function loadImageStore(): BlingImageStore {
  if (cachedImageStore && cachedImageStore.version === IMAGE_STORE_VERSION) {
    return cachedImageStore;
  }
  try {
    const sourceFile = fs.existsSync(IMAGES_STORE_FILE)
      ? IMAGES_STORE_FILE
      : (fs.existsSync(BUNDLED_IMAGES_STORE_FILE) ? BUNDLED_IMAGES_STORE_FILE : null);
    if (sourceFile) {
      const raw = fs.readFileSync(sourceFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== IMAGE_STORE_VERSION) {
        return clearImageCache(true);
      }
      cachedImageStore = {
        version: parsed.version,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        bySku: parsed.bySku || {},
        byName: parsed.byName || {},
        byId: parsed.byId || {}
      };
      return cachedImageStore;
    }
  } catch (err) {
    console.warn('[Bling Images] Could not read image store file:', err);
  }

  cachedImageStore = {
    version: IMAGE_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    bySku: {},
    byName: {},
    byId: {}
  };
  return cachedImageStore;
}

export function saveImageStore(store: BlingImageStore): void {
  store.version = IMAGE_STORE_VERSION;
  cachedImageStore = store;
  store.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(IMAGES_STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Bling Images] Could not save image store file:', err);
  }
}

export function isLegacyExternalUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return u.includes('mitiendanube.com') || u.includes('tiendanube.com');
}

export function isPlaceholderImageUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return true;
  const u = url.trim().toLowerCase();
  if (!u) return true;
  if (u.includes('unsplash.com')) return true;
  if (
    u.startsWith('/src/assets/images/product_') ||
    u.startsWith('/src/assets/images/lookview_') ||
    u.startsWith('/src/assets/images/hero_')
  ) {
    return true;
  }
  return false;
}

/**
 * Normalizes product name for robust matching (e.g. "TENIS TESLA HERTZ BLACK:39" -> "tenis tesla hertz black")
 */
export function normalizeProductName(name: string): string {
  let n = (name || '').toLowerCase().trim();
  if (n.includes(':')) n = n.split(':')[0].trim();
  if (n.includes(' // ')) n = n.split(' // ')[0].trim();
  n = n.replace(/\s+-\s+(pp|p|m|g|gg|xg|xgg|g1|g2|g3|g4|\d{2})$/i, '').trim();
  return n.replace(/\s+/g, ' ');
}

const RESIZE_QUERY_PARAMS = new Set([
  'w', 'h', 'width', 'height', 'max-w', 'max-h', 'maxwidth', 'maxheight',
  'size', 'resize', 'quality', 'q', 'auto', 'fit', 'crop', 'dpr',
  'compress', 'compression', 'format', 'fm', 'fl', 'scale',
  'thumb', 'thumbnail', 'mini', 'miniatura', 'mode', 'blur', 'pixel', 'opt', 'optimize'
]);

/**
 * Strips resize/compression query parameters and filename suffixes from external image URLs
 * while preserving signed URL tokens/auth params (X-Amz-*, Signature, Expires, Policy, etc.).
 */
export function stripResizeAndCompressionParams(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed || trimmed.startsWith('data:image') || trimmed.startsWith('/')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_val, key) => {
      if (RESIZE_QUERY_PARAMS.has(key.toLowerCase())) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }

    // Remove common resize/compression path suffixes before extension (skipping mitiendanube fixed asset hashes)
    if (!parsed.hostname.includes('mitiendanube.com') && !parsed.hostname.includes('tiendanube.com')) {
      parsed.pathname = parsed.pathname.replace(
        /(?:_miniatura|-miniatura|_mini|-mini|_thumb|-thumb|_small|-small|_medium|-medium|_low|-low|_\d{2,4}x\d{2,4}|-\d{2,4}x\d{2,4})(?=\.(?:jpe?g|png|webp|avif|gif)$)/i,
        ''
      );
    }

    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function isThumbnailLikeUrl(url: string): boolean {
  const u = (url || '').toLowerCase();
  if (!u) return false;
  if (
    u.includes('miniatura') ||
    u.includes('/thumb/') ||
    u.includes('_thumb.') ||
    u.includes('-thumb.') ||
    u.includes('_mini.') ||
    u.includes('-mini.')
  ) {
    return true;
  }
  // Bling S3 thumbnails live under /<tenant>/t/<hash> while full-res originals omit /t/
  if (u.includes('orgbling.s3.amazonaws.com') || u.includes('bling.com')) {
    try {
      const parsed = new URL(u);
      if (/\/t\/[^/]+$/i.test(parsed.pathname) || /\/t\/[a-z0-9_-]{8,}/i.test(parsed.pathname)) {
        return true;
      }
    } catch {
      if (/\/t\/[a-z0-9_-]{8,}/i.test(u)) return true;
    }
  }
  return false;
}

const AUTH_SIGNATURE_PARAMS = new Set([
  'awsaccesskeyid',
  'expires',
  'signature',
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-signedheaders',
  'x-amz-signature',
  'x-amz-security-token'
]);

/**
 * Produces a canonical comparison key for image deduplication so the exact same
 * Bling S3 object with different Expires/Signature timestamps isn't saved multiple times.
 */
function getCanonicalImageKey(url: string): string {
  const clean = (url || '').trim();
  if (!clean || clean.startsWith('data:image') || clean.startsWith('/')) return clean;
  try {
    const parsed = new URL(clean);
    const toDelete: string[] = [];
    parsed.searchParams.forEach((_v, k) => {
      if (AUTH_SIGNATURE_PARAMS.has(k.toLowerCase())) {
        toDelete.push(k);
      }
    });
    for (const k of toDelete) {
      parsed.searchParams.delete(k);
    }
    return parsed.toString();
  } catch {
    return clean;
  }
}

function normalizeImageUrl(val: any, allowThumbnailFallback: boolean = false): string | null {
  if (!val) return null;
  if (typeof val === 'object') {
    const primaryCandidate =
      val.link ||
      val.url ||
      val.caminho ||
      val.src ||
      val.imagemURL ||
      val.urlImagem ||
      val.foto ||
      val.anexo?.link ||
      val.anexo?.url;
    if (typeof primaryCandidate === 'string' && primaryCandidate.trim()) {
      return normalizeImageUrl(primaryCandidate, allowThumbnailFallback);
    }
    if (allowThumbnailFallback) {
      const thumbCandidate = val.linkMiniatura || val.thumbnail;
      if (typeof thumbCandidate === 'string' && thumbCandidate.trim()) {
        return normalizeImageUrl(thumbCandidate, true);
      }
    }
    return null;
  }
  if (typeof val !== 'string') return null;
  let clean = val.trim();
  if (!clean || clean === 'null' || clean === 'undefined') return null;
  if (clean.startsWith('//')) {
    clean = `https:${clean}`;
  }
  if (
    clean.startsWith('http://') ||
    clean.startsWith('https://') ||
    clean.startsWith('/') ||
    clean.startsWith('data:image')
  ) {
    return stripResizeAndCompressionParams(clean);
  }
  return null;
}

function extractImagesFromSingleObject(
  item: any,
  urls: string[],
  allowThumbnailFallback: boolean = false
) {
  if (!item || typeof item !== 'object') return;

  const push = (val: any, forceAllowThumb: boolean = allowThumbnailFallback) => {
    const normalized = normalizeImageUrl(val, forceAllowThumb);
    if (normalized && !urls.includes(normalized)) {
      urls.push(normalized);
    }
  };

  const pushArray = (arr: any, forceAllowThumb: boolean = allowThumbnailFallback) => {
    if (!Array.isArray(arr)) return;
    const sorted = [...arr].sort((a: any, b: any) => (a?.ordem ?? 0) - (b?.ordem ?? 0));
    for (const entry of sorted) {
      push(entry, forceAllowThumb);
    }
  };

  if (!allowThumbnailFallback) {
    // PRIMARY PASS: High-resolution original URLs ONLY (never read linkMiniatura or thumbnail here)
    // 1. item.midia.imagens.internas[x].link & externas[x].link first
    if (item.midia) {
      const imagens = item.midia.imagens;
      if (Array.isArray(imagens)) {
        pushArray(imagens, false);
      } else if (imagens && typeof imagens === 'object') {
        if (Array.isArray(imagens.internas)) {
          const sortedInternas = [...imagens.internas].sort((a: any, b: any) => (a?.ordem ?? 0) - (b?.ordem ?? 0));
          for (const imgObj of sortedInternas) {
            if (typeof imgObj === 'string') {
              push(imgObj, false);
            } else if (imgObj && typeof imgObj === 'object') {
              push(imgObj.link || imgObj.url, false);
            }
          }
        }
        if (Array.isArray(imagens.externas)) {
          const sortedExternas = [...imagens.externas].sort((a: any, b: any) => (a?.ordem ?? 0) - (b?.ordem ?? 0));
          for (const imgObj of sortedExternas) {
            if (typeof imgObj === 'string') {
              push(imgObj, false);
            } else if (imgObj && typeof imgObj === 'object') {
              push(imgObj.link || imgObj.url, false);
            }
          }
        }
        pushArray(imagens.imagensURL, false);
        pushArray(imagens.url, false);
      }
      if (Array.isArray(item.midia.fotos)) {
        pushArray(item.midia.fotos, false);
      }
    }

    // 2. item.imagens (nested internas/externas or array)
    if (Array.isArray(item.imagens)) {
      pushArray(item.imagens, false);
    } else if (item.imagens && typeof item.imagens === 'object') {
      if (Array.isArray(item.imagens.internas)) pushArray(item.imagens.internas, false);
      if (Array.isArray(item.imagens.externas)) pushArray(item.imagens.externas, false);
      if (Array.isArray(item.imagens.imagensURL)) pushArray(item.imagens.imagensURL, false);
    }

    // 3. Standard Bling direct URL fields (high-res only)
    push(item.imagemURL, false);
    push(item.urlImagem, false);
    push(item.imagem, false);

    // 4. item.anexos / item.anexo
    if (Array.isArray(item.anexos)) pushArray(item.anexos, false);
    if (item.anexo) push(item.anexo, false);

    // 5. item.fotos
    if (Array.isArray(item.fotos)) {
      pushArray(item.fotos, false);
    } else if (item.fotos && typeof item.fotos === 'object' && Array.isArray(item.fotos.foto)) {
      pushArray(item.fotos.foto, false);
    }
  } else {
    // LAST-RESORT FALLBACK PASS: Only executed if zero .link / original high-res URLs were found anywhere
    if (item.midia?.imagens && typeof item.midia.imagens === 'object' && !Array.isArray(item.midia.imagens)) {
      if (Array.isArray(item.midia.imagens.internas)) {
        const sortedInternas = [...item.midia.imagens.internas].sort((a: any, b: any) => (a?.ordem ?? 0) - (b?.ordem ?? 0));
        for (const imgObj of sortedInternas) {
          if (imgObj && typeof imgObj === 'object') {
            push(imgObj.linkMiniatura || imgObj.thumbnail, true);
          }
        }
      }
      if (Array.isArray(item.midia.imagens.externas)) {
        const sortedExternas = [...item.midia.imagens.externas].sort((a: any, b: any) => (a?.ordem ?? 0) - (b?.ordem ?? 0));
        for (const imgObj of sortedExternas) {
          if (imgObj && typeof imgObj === 'object') {
            push(imgObj.linkMiniatura || imgObj.thumbnail, true);
          }
        }
      }
    }
    if (item.imagens && typeof item.imagens === 'object' && !Array.isArray(item.imagens)) {
      if (Array.isArray(item.imagens.internas)) pushArray(item.imagens.internas, true);
      if (Array.isArray(item.imagens.externas)) pushArray(item.imagens.externas, true);
    }
    push(item.thumbnail, true);
  }
}

/**
 * Extracts all valid image URLs from any Bling API v3 or webhook product payload.
 * Always prioritizes original high-resolution URLs (midia.imagens.internas[x].link / externas[x].link),
 * leaving linkMiniatura strictly as a last-resort fallback when .link is empty.
 */
export function extractImagesFromBlingItem(rawItem: any, includeVariations: boolean = true): string[] {
  if (!rawItem) return [];
  const item = rawItem?.data && typeof rawItem.data === 'object' && !Array.isArray(rawItem.data)
    ? rawItem.data
    : rawItem;

  const highResUrls: string[] = [];
  extractImagesFromSingleObject(item, highResUrls, false);

  if (includeVariations && Array.isArray(item.variacoes)) {
    for (const v of item.variacoes) {
      extractImagesFromSingleObject(v, highResUrls, false);
    }
  }

  // Filter out thumbnail-like URLs if true full-res URLs are present
  const nonThumbHighRes = highResUrls.filter(u => !isThumbnailLikeUrl(u));
  if (nonThumbHighRes.length > 0) {
    return nonThumbHighRes;
  }
  if (highResUrls.length > 0) {
    return highResUrls;
  }

  // Last resort fallback to linkMiniatura / thumbnail ONLY if no .link / original URL exists
  const fallbackUrls: string[] = [];
  extractImagesFromSingleObject(item, fallbackUrls, true);
  if (includeVariations && Array.isArray(item.variacoes)) {
    for (const v of item.variacoes) {
      extractImagesFromSingleObject(v, fallbackUrls, true);
    }
  }

  return fallbackUrls;
}

function mergeImageArrays(existing: string[] | undefined, incoming: string[]): string[] {
  const cleanedIncoming = incoming
    .map(u => stripResizeAndCompressionParams(u))
    .filter(Boolean);
  const cleanedExisting = (Array.isArray(existing) ? existing : [])
    .map(u => stripResizeAndCompressionParams(u))
    .filter(img => Boolean(img) && !isPlaceholderImageUrl(img) && !isLegacyExternalUrl(img));

  const incomingHasFullRes = cleanedIncoming.some(u => !isThumbnailLikeUrl(u));
  const existingHasFullRes = cleanedExisting.some(u => !isThumbnailLikeUrl(u));
  const preferFullResOnly = incomingHasFullRes || existingHasFullRes;

  const result: string[] = [];
  const seenKeys = new Set<string>();
  const addUnique = (img: string) => {
    if (!img) return;
    if (preferFullResOnly && isThumbnailLikeUrl(img)) return;
    const key = getCanonicalImageKey(img);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      result.push(img);
    }
  };

  for (const img of cleanedIncoming) {
    addUnique(img);
  }
  for (const img of cleanedExisting) {
    addUnique(img);
  }
  return result.slice(0, 12);
}

/**
 * Mutates an in-memory store object without writing disk yet (used for batch sync)
 */
export function applyImageRecordToStore(
  store: BlingImageStore,
  identifier: { sku?: string; name?: string; id?: string | number; parentId?: string | number },
  images: string[]
): boolean {
  if (!images || images.length === 0) return false;
  const validImages = images
    .map(u => normalizeImageUrl(u, true))
    .filter((u): u is string => Boolean(u) && !isPlaceholderImageUrl(u!));

  if (validImages.length === 0) return false;

  if (identifier.sku) {
    const s = String(identifier.sku).toUpperCase().trim();
    if (s) store.bySku[s] = mergeImageArrays(store.bySku[s], validImages);
  }
  if (identifier.id) {
    const i = String(identifier.id).trim();
    if (i) store.byId[i] = mergeImageArrays(store.byId[i], validImages);
  }
  if (identifier.parentId) {
    const pid = String(identifier.parentId).trim();
    if (pid) store.byId[pid] = mergeImageArrays(store.byId[pid], validImages);
  }
  if (identifier.name) {
    const n = normalizeProductName(identifier.name);
    if (n) store.byName[n] = mergeImageArrays(store.byName[n], validImages);
  }

  return true;
}

/**
 * Saves image URLs for a specific product
 */
export function recordProductImage(
  identifier: { sku?: string; name?: string; id?: string | number; parentId?: string | number },
  images: string[]
): void {
  const store = loadImageStore();
  if (applyImageRecordToStore(store, identifier, images)) {
    saveImageStore(store);
  }
}

/**
 * Gets real Bling images for a given product
 */
export function getBlingImagesForProduct(product: Partial<Product> | any): string[] | null {
  const store = loadImageStore();

  const sanitizeUrls = (urls?: string[]): string[] | null => {
    if (!urls || urls.length === 0) return null;
    const cleaned = urls
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0 && !isPlaceholderImageUrl(u))
      .map(u => stripResizeAndCompressionParams(u));
    if (cleaned.length === 0) return null;
    const fullRes = cleaned.filter(u => !isThumbnailLikeUrl(u));
    return fullRes.length > 0 ? fullRes : cleaned;
  };

  // 1. By SKU
  const sku = product.integration?.sku || product.sku;
  if (sku) {
    const s = String(sku).toUpperCase().trim();
    if (store.bySku[s] && store.bySku[s].length > 0) {
      const clean = sanitizeUrls(store.bySku[s]);
      if (clean) return clean;
    }
  }

  // 2. By variant SKUs or IDs
  if (Array.isArray(product.variantsList)) {
    for (const v of product.variantsList) {
      if (v.sku) {
        const vs = String(v.sku).toUpperCase().trim();
        if (store.bySku[vs] && store.bySku[vs].length > 0) {
          const clean = sanitizeUrls(store.bySku[vs]);
          if (clean) return clean;
        }
      }
      if (v.id) {
        const vId = String(v.id).trim();
        if (store.byId[vId] && store.byId[vId].length > 0) {
          const clean = sanitizeUrls(store.byId[vId]);
          if (clean) return clean;
        }
      }
    }
  }

  // 3. By Bling ID
  const blingId = product.integration?.blingId || product.blingId;
  if (blingId) {
    const bId = String(blingId).trim();
    if (store.byId[bId] && store.byId[bId].length > 0) {
      const clean = sanitizeUrls(store.byId[bId]);
      if (clean) return clean;
    }
  }

  // 4. By normalized product name
  if (product.name) {
    const n = normalizeProductName(product.name);
    if (store.byName[n] && store.byName[n].length > 0) {
      const clean = sanitizeUrls(store.byName[n]);
      if (clean) return clean;
    }

    // Substring / fuzzy match across stored names
    for (const [storedName, imgs] of Object.entries(store.byName)) {
      if (imgs.length > 0 && storedName.length >= 8 && (n.includes(storedName) || storedName.includes(n))) {
        const clean = sanitizeUrls(imgs);
        if (clean) return clean;
      }
    }
  }

  return null;
}

/**
 * Injects real Bling images into products array, giving them top priority and eliminating placeholders
 */
export function applyBlingImageOverrides<T extends { images?: string[]; [key: string]: any } = Product>(products: T[]): T[] {
  return products.map(product => {
    const realImages = getBlingImagesForProduct(product);
    if (realImages && realImages.length > 0) {
      const hasNativeBling = realImages.some(u => !isLegacyExternalUrl(u));
      const hasFullRes = realImages.some(u => !isThumbnailLikeUrl(u));
      const existingReal = Array.isArray(product.images)
        ? product.images
            .filter((img: string) =>
              !isPlaceholderImageUrl(img) &&
              (!hasNativeBling || !isLegacyExternalUrl(img)) &&
              (!hasFullRes || !isThumbnailLikeUrl(img))
            )
            .map((img: string) => stripResizeAndCompressionParams(img))
        : [];
      const combined = [
        ...realImages,
        ...existingReal.filter((img: string) => !realImages.includes(img))
      ];
      return {
        ...product,
        images: combined
      };
    }
    return product;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let activeSyncPromise: Promise<any> | null = null;
let catalogFetchInProgress = false;

export function isImageSyncRunning(): boolean {
  return Boolean(activeSyncPromise);
}

export function setCatalogFetchInProgress(val: boolean): void {
  catalogFetchInProgress = val;
}

/**
 * Synchronizes all internal/external images directly from Bling ERP API v3.
 * Queries /produtos to list all products and calls GET /produtos/{id} on each unique product
 * to extract data.midia.imagens.internas (.link / .linkMiniatura), data.midia.imagens.externas (.link), and imagemURL.
 */
export async function syncImagesFromBling(options?: {
  maxDetailFetches?: number;
  clearCache?: boolean;
  onBatchSaved?: () => void;
}): Promise<{
  success: boolean;
  updatedCount: number;
  detailedFetched: number;
  totalWithImages: number;
  sources: { bling: number };
  connected: boolean;
  message: string;
  error?: string;
}> {
  if (activeSyncPromise) {
    return activeSyncPromise;
  }

  activeSyncPromise = (async () => {
    const store = options?.clearCache ? clearImageCache(true) : loadImageStore();
    let blingCount = 0;
    let detailedFetched = 0;
    const maxDetailFetches = options?.maxDetailFetches ?? Infinity;

    const tokens = loadBlingTokens();
    if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
      console.log('[Bling Image Sync] Bling OAuth token not connected yet; skipped direct API fetch.');
      const totalWithImages = Object.keys(store.bySku).length + Object.keys(store.byName).length;
      return {
        success: true,
        updatedCount: 0,
        detailedFetched: 0,
        totalWithImages,
        sources: { bling: 0 },
        connected: false,
        message: `Banco de imagens local ativo (${totalWithImages} mapeamentos). Conecte o Bling ERP para puxar as fotos armazenadas no Bling.`
      };
    }

    try {
      console.log('[Bling Image Sync] Querying Bling API v3 /produtos to collect up to 1500 product IDs...');
      const allItems: any[] = [];
      const seenItemIds = new Set<number>();
      const MAX_ITEMS = 1500;

      const pushUniqueItems = (items: any[]) => {
        for (const it of items) {
          if (it?.situacao === 'I' || it?.situacao === 'E') continue;
          if (it?.id && !seenItemIds.has(it.id) && allItems.length < MAX_ITEMS) {
            seenItemIds.add(it.id);
            allItems.push(it);
          }
        }
      };

      // Prioritize newest registered products first (criterio=1, pages 1..3) so new drops always sync images immediately
      for (let p = 1; p <= 3 && allItems.length < MAX_ITEMS; p++) {
        const latestPage = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=1&tipo=T`);
        const latestItems = latestPage?.data || [];
        if (latestItems.length === 0) break;
        pushUniqueItems(latestItems);
        if (latestItems.length < 100) break;
        await sleep(160);
      }

      for (let p = 1; p <= 16 && allItems.length < MAX_ITEMS; p++) {
        const pageData = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=2&tipo=T`);
        const items = pageData?.data || [];
        if (items.length === 0) break;
        pushUniqueItems(items);
        if (items.length < 100) break;
        await sleep(180);
      }

      console.log(`[Bling Image Sync] Listed ${allItems.length} Bling items. Extracting summary & preparing GET /produtos/{id} detail sync...`);

      // Collect unique parent/standalone product IDs first (in Bling v3, GET /produtos/{id} returns full midia.imagens.internas + variacoes)
      const detailTargetMap = new Map<number, any>();
      const childItems: any[] = [];

      for (const item of allItems) {
        // Save ONLY non-thumbnail URLs from /produtos list summary; /t/ thumbnails await GET /produtos/{id} full-res .link
        const listImgs = extractImagesFromBlingItem(item).filter(u => !isThumbnailLikeUrl(u));
        if (listImgs.length > 0) {
          applyImageRecordToStore(store, {
            sku: item.codigo,
            id: item.id,
            parentId: item.idProdutoPai,
            name: item.nome
          }, listImgs);
        }

        if (item.id && !item.idProdutoPai) {
          detailTargetMap.set(item.id, item);
        } else if (item.id) {
          childItems.push(item);
        }
      }

      // If any child item references a parent ID not present in page results, ensure parent ID is fetched too
      for (const child of childItems) {
        if (child.idProdutoPai && !detailTargetMap.has(child.idProdutoPai)) {
          detailTargetMap.set(child.idProdutoPai, {
            id: child.idProdutoPai,
            nome: child.nome,
            codigo: child.codigo
          });
        }
      }

      const detailTargets = Array.from(detailTargetMap.values()).slice(0, maxDetailFetches);
      console.log(`[Bling Image Sync] Fetching GET /produtos/{id} for ${detailTargets.length} products to read midia.imagens.internas...`);

      const parentsWithImages = new Set<number>();

      for (let idx = 0; idx < detailTargets.length; idx++) {
        while (catalogFetchInProgress) {
          await sleep(400);
        }
        const item = detailTargets[idx];
        try {
          const detail = await fetchFromBling(`/produtos/${item.id}`);
          const fullData = detail?.data || detail;
          detailedFetched++;

          const fullImgs = extractImagesFromBlingItem(fullData);
          if (fullImgs.length > 0) {
            parentsWithImages.add(item.id);
            applyImageRecordToStore(store, {
              sku: fullData?.codigo || item.codigo,
              id: fullData?.id || item.id,
              parentId: fullData?.idProdutoPai || item.idProdutoPai,
              name: fullData?.nome || item.nome
            }, fullImgs);
            blingCount++;
          }

          // Map all variations returned by GET /produtos/{id}
          if (Array.isArray(fullData?.variacoes)) {
            for (const v of fullData.variacoes) {
              const vImgs = extractImagesFromBlingItem(v, false);
              const effectiveVarImgs = vImgs.length > 0 ? vImgs : fullImgs;
              if (effectiveVarImgs.length > 0) {
                applyImageRecordToStore(store, {
                  sku: v.codigo,
                  id: v.id,
                  parentId: fullData?.id || item.id,
                  name: v.nome || fullData?.nome || item.nome
                }, effectiveVarImgs);
              }
            }
          }

          // Save incrementally every 20 items so the storefront reflects new photos right away
          if (detailedFetched % 20 === 0) {
            saveImageStore(store);
            options?.onBatchSaved?.();
          }

          // Respect Bling API v3 rate limit (~2.3 req/sec leaving headroom for live storefront calls)
          await sleep(420);
        } catch (detailErr: any) {
          console.warn(`[Bling Image Sync] Detail fetch skipped for ID ${item.id}:`, detailErr?.message || detailErr);
        }
      }

      // Fallback: if a child variation has no images from its parent yet, fetch its own /produtos/{child.id}
      if (detailedFetched < maxDetailFetches) {
        const orphanChildren = childItems.filter(
          c => c.id && (!c.idProdutoPai || !parentsWithImages.has(c.idProdutoPai))
        );
        for (const child of orphanChildren) {
          if (detailedFetched >= maxDetailFetches) break;
          while (catalogFetchInProgress) {
            await sleep(400);
          }
          const normName = child.nome ? normalizeProductName(child.nome) : '';
          const alreadyHasByName = normName && store.byName[normName]?.some(u => !isLegacyExternalUrl(u));
          if (alreadyHasByName) continue;

          try {
            const detail = await fetchFromBling(`/produtos/${child.id}`);
            const fullData = detail?.data || detail;
            detailedFetched++;
            const childImgs = extractImagesFromBlingItem(fullData);
            if (childImgs.length > 0) {
              applyImageRecordToStore(store, {
                sku: fullData?.codigo || child.codigo,
                id: fullData?.id || child.id,
                parentId: fullData?.idProdutoPai || child.idProdutoPai,
                name: fullData?.nome || child.nome
              }, childImgs);
              blingCount++;
            }
            await sleep(340);
          } catch {
            // continue
          }
        }
      }

      saveImageStore(store);
      lastSyncCompletedAt = Date.now();
      options?.onBatchSaved?.();

      console.log(`[Bling Image Sync] Finished: ${blingCount} Bling products synced (${detailedFetched} /produtos/{id} detail requests).`);

      const totalWithImages = Object.keys(store.bySku).length + Object.keys(store.byName).length;

      return {
        success: true,
        updatedCount: blingCount,
        detailedFetched,
        totalWithImages,
        sources: { bling: blingCount },
        connected: true,
        message: blingCount > 0
          ? `Sincronização concluída! ${blingCount} produtos atualizados com fotos reais armazenadas no Bling ERP.`
          : `Conexão com Bling verificada (${allItems.length} itens consultados), porém nenhuma imagem interna/externa foi retornada em midia.imagens ou imagemURL.`
      };
    } catch (blingErr: any) {
      const errMessage = blingErr?.message || String(blingErr);
      console.warn('[Bling Image Sync] Error during Bling API fetch:', errMessage);
      saveImageStore(store);
      const totalWithImages = Object.keys(store.bySku).length + Object.keys(store.byName).length;
      return {
        success: false,
        updatedCount: blingCount,
        detailedFetched,
        totalWithImages,
        sources: { bling: blingCount },
        connected: Boolean(loadBlingTokens()?.access_token),
        error: errMessage,
        message: `Erro ao consultar API do Bling: ${errMessage}`
      };
    }
  })().finally(() => {
    activeSyncPromise = null;
  });

  return activeSyncPromise;
}
