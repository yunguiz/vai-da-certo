import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { registerBlingRoutes, blingRouter, fetchFromBling, loadBlingTokens, ensureBlingAuthorized, refreshBlingToken } from './server-bling';
import { registerMelhorEnvioRoutes, startMelhorEnvioAutoSync } from './server-melhor-envio';
import { BLING_STOCK_PRODUCTS, BLING_CATALOG_META } from './src/data/blingCatalog';
import { filterVisibleProducts } from './src/lib/hiddenProducts';
import {
  applyBlingImageOverrides,
  recordProductImage,
  syncImagesFromBling,
  extractImagesFromBlingItem,
  loadImageStore,
  saveImageStore,
  clearImageCache,
  stripResizeAndCompressionParams,
  applyImageRecordToStore,
  getBlingImagesForProduct,
  isPlaceholderImageUrl,
  isLegacyExternalUrl,
  isThumbnailLikeUrl,
  isImageSyncRunning,
  setCatalogFetchInProgress,
  getLastBlingImageSyncTime
} from './server-bling-images';
import {
  createStoreOrder,
  trackStoreOrders,
  requestStoreOrderReturn
} from './server-orders';

dotenv.config();

const __filename =
  typeof import.meta?.url === 'string'
    ? fileURLToPath(import.meta.url)
    : path.resolve(process.cwd(), 'server.ts');
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// In-memory catalog cache for instant responses and automatic background sync (up to 1350 Bling products)
let catalogCache: {
  products: any[];
  count: number;
  blingConnected: boolean;
  blingCount: number;
  blingRawCount: number;
  blingError: string | null;
  hiddenCount?: number;
  totalRegisteredItems?: number;
  uniqueModels?: number;
  totalUnitsInStock?: number;
  timestamp: number;
} | null = null;
const CATALOG_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes fresh TTL with silent stale-while-revalidate

export function invalidateCatalogCache() {
  catalogCache = null;
  console.log('[Catalog Cache] Invalidated. Rebuilding fresh catalog from Bling ERP...');
}

export function reapplyImagesToCachedCatalog() {
  if (catalogCache && Array.isArray(catalogCache.products)) {
    catalogCache = {
      ...catalogCache,
      products: applyBlingImageOverrides(catalogCache.products),
    };
  }
}

// Mercado Pago Credentials
const MERCADO_PAGO_PUBLIC_KEY = process.env.MERCADO_PAGO_PUBLIC_KEY || 'APP_USR-b72ab0f6-ad03-4238-9070-602d5bfd942a';
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || 'APP_USR-1812187507012211-102712-308c387108d8d06e1d2de659247d0294-2461933848';
const MERCADO_PAGO_CLIENT_ID = process.env.MERCADO_PAGO_CLIENT_ID || '1812187507012211';
const MERCADO_PAGO_CLIENT_SECRET = process.env.MERCADO_PAGO_CLIENT_SECRET || 'TOLV7NTDfnsd0F1HsbQFwU2CmOfXG1z9';
const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';

// Robust HTML cleaning function that strips <p>, <br>, tags and entities
function cleanDescription(raw?: string): string {
  if (!raw) return '';
  let text = String(raw);
  text = text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');

  text = text
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div[^>]*>/gi, '')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-zA-Z0-9#]+;/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

const COLOR_PALETTE: { name: string; regex: RegExp; hex: string }[] = [
  { name: 'Preto', regex: /\b(preto|preta|black|all black|negro)\b/i, hex: '#111111' },
  { name: 'Branco', regex: /\b(branco|branca|white)\b/i, hex: '#FFFFFF' },
  { name: 'Off-White', regex: /\b(off white|off-white|off withe|off)\b/i, hex: '#EAE6DF' },
  { name: 'Cinza', regex: /\b(cinza|grey|gray|chumbo|grafite|estonado|estonada)\b/i, hex: '#6B7280' },
  { name: 'Azul', regex: /\b(azul|navy|blue|safira|jeans|marinho)\b/i, hex: '#1E3A8A' },
  { name: 'Verde', regex: /\b(verde|green|militar|musgo)\b/i, hex: '#14532D' },
  { name: 'Vermelho', regex: /\b(vermelho|vermelha|red)\b/i, hex: '#DC2626' },
  { name: 'Rosa / Rose Gold', regex: /\b(rosa|pink|rose|rose gold)\b/i, hex: '#F472B6' },
  { name: 'Roxo', regex: /\b(roxo|roxa|purple)\b/i, hex: '#6B21A8' },
  { name: 'Marrom / Bege', regex: /\b(marrom|brown|caramelo|bege|areia|khaki)\b/i, hex: '#78350F' },
  { name: 'Prata', regex: /\b(prata|prateado|prateada|silver)\b/i, hex: '#9CA3AF' },
  { name: 'Dourado', regex: /\b(dourado|dourada|ouro|gold)\b/i, hex: '#F59E0B' },
  { name: 'Amarelo', regex: /\b(amarelo|amarela|yellow)\b/i, hex: '#EAB308' },
  { name: 'Laranja', regex: /\b(laranja|orange)\b/i, hex: '#EA580C' }
];

function detectColorFromName(name: string): { name: string; hex: string } | null {
  for (const c of COLOR_PALETTE) {
    if (c.regex.test(name)) {
      return { name: c.name, hex: c.hex };
    }
  }
  return null;
}

// Map product category and title to app categories
function mapCategoryAndSubcategory(
  productName: string,
  categories?: Array<{ name?: { pt?: string } | string }>
): { category: 'roupas' | 'calcados' | 'acessorios'; subcategory: 'hoodies' | 'camisetas' | 'calcas' | 'shorts' | 'sneakers' | 'bones' | 'bags' | 'acessorios-metal' } {
  const allCatNames = (categories || [])
    .map(c => (typeof c.name === 'object' && c.name?.pt ? c.name.pt : (c.name || '')))
    .join(' ')
    .toLowerCase();

  const titleLower = productName.toLowerCase();
  const text = `${allCatNames} ${titleLower}`;

  // Accessories checked first if explicit in title or category (avoids socks/laces being called sneakers)
  if (text.includes('boné') || text.includes('bone') || text.includes('bucket') || text.includes('gorro')) {
    return { category: 'acessorios', subcategory: 'bones' };
  }
  if (text.includes('bag') || text.includes('shoulder') || text.includes('mochila') || text.includes('pochete') || text.includes('mala')) {
    return { category: 'acessorios', subcategory: 'bags' };
  }
  if (
    text.includes('óculos') || text.includes('oculos') || 
    text.includes('radar') || text.includes('juliet') || text.includes('penny') ||
    text.includes('oakley') || text.includes('cartier') || text.includes('descanço') || text.includes('descanso') ||
    text.includes('cinto') || text.includes('carteira') || text.includes('relógio') || text.includes('relogio') || 
    text.includes('isqueiro') || text.includes('corrente') || text.includes('chaveiro') || text.includes('anel') || text.includes('pulseira') ||
    titleLower.includes('meia') || titleLower.includes('cadarço') || titleLower.includes('cadarco') || titleLower.includes('lace')
  ) {
    return { category: 'acessorios', subcategory: 'acessorios-metal' };
  }

  // Sneakers / Calçados
  if (text.includes('tênis') || text.includes('tenis') || text.includes('sneaker') || text.includes('chinelo') || text.includes('calçado') || text.includes('calcado')) {
    return { category: 'calcados', subcategory: 'sneakers' };
  }

  // Roupas
  if (text.includes('moletom') || text.includes('hoodie') || text.includes('jaqueta') || text.includes('corta vento') || text.includes('casaco')) {
    return { category: 'roupas', subcategory: 'hoodies' };
  }
  if (text.includes('calça') || text.includes('calca') || text.includes('cargo') || text.includes('jogger')) {
    return { category: 'roupas', subcategory: 'calcas' };
  }
  if (text.includes('bermuda') || text.includes('short')) {
    return { category: 'roupas', subcategory: 'shorts' };
  }

  // Default to camisetas / oversize
  return { category: 'roupas', subcategory: 'camisetas' };
}

let activeCatalogBuildPromise: Promise<{
  success: boolean;
  count: number;
  products: any[];
  blingConnected: boolean;
  blingCount: number;
  blingRawCount: number;
  blingError: string | null;
  hiddenCount: number;
  totalRegisteredItems: number;
  blingRegisteredSKUs: number;
  uniqueModels: number;
  totalUnitsInStock: number;
  syncedAt: string;
}> | null = null;

async function buildAndCacheCatalog(options?: { forceImageSync?: boolean }) {
  if (activeCatalogBuildPromise) {
    return activeCatalogBuildPromise;
  }

  activeCatalogBuildPromise = (async () => {
    const products: any[] = [];
    let blingConnected = false;
    let blingCount = 0;
    let blingRawCount = 0;
    let blingError: string | null = null;
    const zeroStockFromBlingKeys = new Set<string>();

    // Merge all live products from Bling ERP seamlessly when connected (up to 1350 items)
    try {
      const blingTokens = loadBlingTokens();
      if (blingTokens?.access_token || blingTokens?.refresh_token) {
        setCatalogFetchInProgress(true);
        const MAX_BLING_PRODUCTS = 1500;
        const blingRaw: any[] = [];
        const seenBlingIds = new Set<number>();
        const pushUniqueBling = (items: any[]) => {
          for (const it of items) {
            if (it?.situacao === 'I' || it?.situacao === 'E') continue;
            if (it?.id && !seenBlingIds.has(it.id) && blingRaw.length < MAX_BLING_PRODUCTS) {
              seenBlingIds.add(it.id);
              blingRaw.push(it);
            }
          }
        };

        // 1. Fetch newest registered products first (criterio=1: Últimos incluídos, pages 1..3)
        for (let p = 1; p <= 3 && blingRaw.length < MAX_BLING_PRODUCTS; p++) {
          const latestPage = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=1&tipo=T`);
          const latestItems = latestPage?.data || [];
          if (latestItems.length > 0) {
            pushUniqueBling(latestItems);
          }
          if (latestItems.length < 100) break;
          await new Promise(resolve => setTimeout(resolve, 160));
        }

        // 2. Fetch ALL active pages (up to 16 pages = up to 1500 items)
        for (let p = 1; p <= 16 && blingRaw.length < MAX_BLING_PRODUCTS; p++) {
          try {
            const pageData = await fetchFromBling(`/produtos?pagina=${p}&limite=100&criterio=2&tipo=T`);
            const items = pageData?.data || [];
            if (items.length > 0) {
              pushUniqueBling(items);
            }
            if (items.length < 100) break;
            await new Promise(resolve => setTimeout(resolve, 160));
          } catch (pageErr: any) {
            console.warn(`[Bling Sync] Stopped pagination at page ${p}:`, pageErr?.message || pageErr);
            break;
          }
        }

        blingConnected = true;
        blingRawCount = blingRaw.length;
        console.log(`[Bling Sync] Fetched ${blingRaw.length} total raw active items (limit ${MAX_BLING_PRODUCTS}) from Bling ERP.`);

        // 3. Fetch REAL stock balances via /estoques/saldos in chunks of 50 so zero-stock items are hidden accurately
        const realStockMap = new Map<number, number>();
        let stockApiQueried = false;
        const allBlingIds = blingRaw.map((bp: any) => bp.id).filter(Boolean);
        for (let i = 0; i < allBlingIds.length; i += 50) {
          const chunk = allBlingIds.slice(i, i + 50);
          try {
            const qs = chunk.map((id: number) => `idsProdutos[]=${id}`).join('&');
            const stockRes = await fetchFromBling(`/estoques/saldos?${qs}`);
            stockApiQueried = true;
            const entries = stockRes?.data || [];
            for (const entry of entries) {
              const pId = entry?.produto?.id;
              if (pId) {
                const bal = entry.saldoVirtualTotal ?? entry.saldoFisicoTotal ?? entry.saldoFisico ?? 0;
                realStockMap.set(Number(pId), Math.max(0, Number(bal) || 0));
              }
            }
            if (i + 50 < allBlingIds.length) {
              await new Promise(resolve => setTimeout(resolve, 340));
            }
          } catch (stockChunkErr: any) {
            console.warn(`[Bling Stock] Chunk fetch notice:`, stockChunkErr?.message || stockChunkErr);
          }
        }

        // When explicitly requested, ensure high-res internal Bling images sync without racing catalog build
        if (options?.forceImageSync && Date.now() - getLastBlingImageSyncTime() > 3 * 60 * 1000) {
          syncImagesFromBling({ onBatchSaved: () => reapplyImagesToCachedCatalog() })
            .then(() => reapplyImagesToCachedCatalog())
            .catch(() => {});
        }

        // Index by Bling ID so parent products (formato === 'V') & their child variations (idProdutoPai) always stay unified
        const byBlingId = new Map<number, any>();
        blingRaw.forEach((bp: any) => {
          if (bp.id) byBlingId.set(bp.id, bp);
        });
        const referencedParentIds = new Set<number>();
        blingRaw.forEach((bp: any) => {
          if (bp.idProdutoPai) referencedParentIds.add(bp.idProdutoPai);
        });

        const productGroups: Record<string, {
          id: number;
          baseName: string;
          items: any[];
          price: number;
          category: 'roupas' | 'calcados' | 'acessorios';
          subcategory: any;
        }> = {};

        blingRaw.forEach((bp: any) => {
          const parentId = bp.idProdutoPai
            ? Number(bp.idProdutoPai)
            : (bp.formato === 'V' || referencedParentIds.has(bp.id) ? Number(bp.id) : null);
          const parentItem = parentId ? byBlingId.get(parentId) : null;
          const sourceForTitle = parentItem || bp;
          const rawName = (sourceForTitle.nome || bp.nome || '').trim();
          const baseName = rawName.split(':')[0].trim();
          const groupKey = parentId ? `parent:${parentId}` : `name:${baseName.toUpperCase()}`;

          if (!productGroups[groupKey]) {
            const { category, subcategory } = mapCategoryAndSubcategory(baseName);
            productGroups[groupKey] = {
              id: parentId || bp.id,
              baseName,
              items: [],
              price: parseFloat(sourceForTitle.preco || bp.preco || '99.90'),
              category,
              subcategory,
            };
          }

          if (parentId && bp.id === parentId) {
            productGroups[groupKey].items.unshift(bp);
            if (bp.preco && parseFloat(bp.preco) > 0) {
              productGroups[groupKey].price = parseFloat(bp.preco);
            }
          } else {
            productGroups[groupKey].items.push(bp);
          }
        });

        // Sort newest Bling product IDs first so recently registered products show up right at the top
        const sortedGroups = Object.values(productGroups).sort((a, b) => Number(b.id) - Number(a.id));

        const existingSkus = new Set(products.map(p => p.integration?.sku));
        const existingNames = new Set(products.map(p => p.name.toLowerCase().trim()));

        // Curated high-res imagery for Bling catalog categories
        const imagePresets: Record<string, string[]> = {
          sneakers: [
            '/src/assets/images/product_sneaker_chunky_1793275501375.jpg',
            'https://images.unsplash.com/photo-1552346154-21d32810aba3?auto=format&fit=crop&w=1000&q=85',
            'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=1000&q=85'
          ],
          camisetas: [
            '/src/assets/images/lookview_fullkit_model_1793275500631.jpg',
            '/src/assets/images/hero_streetwear_urban_1793275500555.jpg',
            'https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?auto=format&fit=crop&w=1000&q=85'
          ],
          hoodies: [
            '/src/assets/images/product_hoodie_oversized_1793275501387.jpg',
            '/src/assets/images/lookview_fullkit_model_1793275500631.jpg'
          ],
          calcas: [
            '/src/assets/images/product_cargo_heavy_1793275501361.jpg'
          ],
          acessorios: [
            '/src/assets/images/product_chain_silver_1793275501382.jpg',
            '/src/assets/images/product_cap_streetwear_1793275501370.jpg'
          ],
          chinelos: [
            'https://images.unsplash.com/photo-1608256246200-53e635b5b65f?auto=format&fit=crop&w=1000&q=85',
            'https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=1000&q=85'
          ]
        };

        let addedFromBlingCount = 0;
        const imageStore = loadImageStore();
        let imageStoreDirty = false;
        const groupsNeedingDetailFetch: Array<{ id: number; sku: string; baseName: string; productRef: any }> = [];

        for (const [gIdx, group] of sortedGroups.entries()) {
          const firstItem = group.items[0];
          const groupSku = firstItem?.codigo || `BLING-${group.id}`;
          const normalizedBaseName = group.baseName.toLowerCase().trim();

          // Extract ALL images across parent & variation items (preferring full-res over /produtos list /t/ thumbnails)
          const blingImagesSet = new Set<string>();
          for (const it of group.items) {
            const itemImgs = extractImagesFromBlingItem(it);
            for (const url of itemImgs) {
              blingImagesSet.add(url);
            }
            const fullResItemImgs = itemImgs.filter(u => !isThumbnailLikeUrl(u));
            if (fullResItemImgs.length > 0) {
              if (
                applyImageRecordToStore(
                  imageStore,
                  {
                    sku: it.codigo,
                    id: it.id,
                    parentId: it.idProdutoPai || group.id,
                    name: group.baseName
                  },
                  fullResItemImgs
                )
              ) {
                imageStoreDirty = true;
              }
            }
          }
          const blingExtractedImages = Array.from(blingImagesSet);
          const fullResBlingExtracted = blingExtractedImages.filter(u => !isThumbnailLikeUrl(u));

          if (fullResBlingExtracted.length > 0) {
            if (
              applyImageRecordToStore(
                imageStore,
                {
                  sku: groupSku,
                  id: group.id,
                  name: group.baseName
                },
                fullResBlingExtracted
              )
            ) {
              imageStoreDirty = true;
            }
          }

          // If product already in catalog, sync stock, price, and any newly extracted Bling images
          if (existingNames.has(normalizedBaseName)) {
            const match = products.find(p => p.name.toLowerCase().trim() === normalizedBaseName);
            if (match) {
              const totalBlingStock = group.items.reduce((acc, it) => acc + (it.estoque?.saldoVirtualTotal || it.estoque?.saldoFisico || 0), 0);
              if (totalBlingStock > 0) match.stockCount = totalBlingStock;
              if (group.price > 0) match.price = group.price;
              if (blingExtractedImages.length > 0) {
                const existingReal = (match.images || []).filter((u: string) => !isPlaceholderImageUrl(u));
                match.images = Array.from(new Set([...blingExtractedImages, ...existingReal]));
              }
            }
            continue;
          }

          // Build sizes array from item variants
          const sizesList: string[] = [];
          group.items.forEach(it => {
            const parts = (it.nome || '').split(':');
            if (parts.length > 1) {
              const sz = parts[1].trim();
              if (sz && !sizesList.includes(sz)) sizesList.push(sz);
            }
          });

          // Determine sizes: If item has variants, sort them cleanly. If no size variations, use 'Tamanho Único'.
          let finalSizes: string[] = [];
          if (sizesList.length > 0) {
            const isNumericSizes = sizesList.every(s => !isNaN(Number(s)));
            if (isNumericSizes) {
              finalSizes = [...sizesList].sort((a, b) => Number(a) - Number(b));
            } else {
              const clothesOrder = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'G1', 'G2', 'G3', 'G4'];
              finalSizes = [...sizesList].sort((a, b) => {
                const idxA = clothesOrder.indexOf(a.toUpperCase());
                const idxB = clothesOrder.indexOf(b.toUpperCase());
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                return a.localeCompare(b);
              });
            }
          } else {
            // Pieces without size variants (sunglasses, watches, hats, single-sized items)
            finalSizes = ['Tamanho Único'];
          }

          // Determine real colors from item names and variants
          const detectedColorsMap = new Map<string, { name: string; hex: string }>();
          group.items.forEach(it => {
            const colorFound = detectColorFromName(it.nome || '');
            if (colorFound) {
              detectedColorsMap.set(colorFound.name, colorFound);
            }
          });

          let finalColors: { name: string; hex: string }[] = [];
          if (detectedColorsMap.size > 0) {
            finalColors = Array.from(detectedColorsMap.values());
          } else {
            // Single color piece or uniform color
            finalColors = [{ name: 'Cor Única', hex: '#1C1C1C' }];
          }

          const resolveItemStock = (it: any): number => {
            if (realStockMap.has(Number(it.id))) {
              return realStockMap.get(Number(it.id))!;
            }
            const summaryStock = it.estoque?.saldoVirtualTotal ?? it.estoque?.saldoFisicoTotal ?? it.estoque?.saldoFisico;
            if (summaryStock !== undefined && summaryStock !== null) {
              return Math.max(0, Number(summaryStock) || 0);
            }
            return stockApiQueried ? 0 : 0;
          };

          const variantsList = group.items.map(it => {
            const szParts = (it.nome || '').split(':');
            const vSize = szParts.length > 1 ? szParts[1].trim() : (finalSizes[0] || 'Tamanho Único');
            const vStock = resolveItemStock(it);
            return {
              id: it.id,
              sku: it.codigo || `${groupSku}-${vSize}`,
              price: parseFloat(it.preco || String(group.price || '119.90')),
              stock: vStock,
              size: vSize
            };
          });

          // Total stock across parent/variants
          const totalStock = variantsList.reduce((acc, v) => acc + Math.max(0, v.stock), 0);

          // Automatically hide out-of-stock products from the storefront
          if (totalStock <= 0) {
            zeroStockFromBlingKeys.add(normalizedBaseName);
            if (groupSku) zeroStockFromBlingKeys.add(String(groupSku).toUpperCase().trim());
            for (const it of group.items) {
              if (it.codigo) zeroStockFromBlingKeys.add(String(it.codigo).toUpperCase().trim());
            }
            continue;
          }

          // Keep only in-stock sizes if product has size variations
          const inStockSizes = sizesList.length > 0
            ? finalSizes.filter(sz => variantsList.some(v => v.size === sz && v.stock > 0))
            : finalSizes;
          const activeSizes = inStockSizes.length > 0 ? inStockSizes : finalSizes;

          // Select images: 1. Full-res live/cached midia.imagens.internas[0].link -> 2. List fallback -> 3. Presets
          const cachedBlingImages = getBlingImagesForProduct({
            name: group.baseName,
            integration: { sku: groupSku, blingId: String(group.id) },
            variantsList
          }) || [];
          const cachedFullRes = cachedBlingImages.filter(u => !isThumbnailLikeUrl(u));
          const combinedFullRes = Array.from(new Set([...fullResBlingExtracted, ...cachedFullRes]));

          let images: string[] = [];
          if (combinedFullRes.length > 0) {
            images = combinedFullRes;
          } else if (cachedBlingImages.length > 0) {
            images = cachedBlingImages;
          } else if (blingExtractedImages.length > 0) {
            images = blingExtractedImages;
          } else if (normalizedBaseName.includes('chinelo') || normalizedBaseName.includes('havaianas')) {
            images = imagePresets.chinelos;
          } else if (group.category === 'calcados') {
            images = imagePresets.sneakers;
          } else if (group.subcategory === 'hoodies') {
            images = imagePresets.hoodies;
          } else if (group.category === 'acessorios') {
            images = imagePresets.acessorios;
          } else {
            images = imagePresets.camisetas;
          }

          const priceVal = isNaN(group.price) || group.price <= 0 ? 119.90 : group.price;

          // Clean HTML tags (<p>, <br>, etc.) from product description
          const rawBlingDesc = firstItem?.descricaoCurta || firstItem?.descricaoComplementar || '';
          const cleanedBlingDesc = cleanDescription(rawBlingDesc) || `${group.baseName} - Produto autêntico da Street Store. Acabamento reforçado, resistência e caimento streetwear impecável para compor seu kit no dia a dia.`;

          const productObj = {
            id: `bling-${group.id}`,
            name: group.baseName,
            category: group.category,
            subcategory: group.subcategory,
            price: priceVal,
            originalPrice: Math.round(priceVal * 1.3),
            tag: totalStock <= 3 ? 'POUCAS UNIDADES' : (gIdx < 12 ? 'NOVO DROP' : null),
            rating: 4.8 + ((group.id % 3) / 10),
            reviewsCount: 15 + (group.id % 40),
            images,
            sizes: activeSizes,
            colors: finalColors,
            description: cleanedBlingDesc,
            stockCount: totalStock,
            details: {
              composition: group.category === 'calcados' ? 'Solado em borracha vulcanizada de alta durabilidade' : (group.category === 'acessorios' ? 'Material premium de alta durabilidade' : '100% Algodão Premium Heavyweight'),
              weight: group.category === 'calcados' ? '900g o par' : (group.category === 'acessorios' ? '120g' : '380g/m² Heavyweight'),
              modelInfo: group.category === 'acessorios' ? 'Tamanho e formato ergonômico' : 'Modelagem autêntica da marca',
              origin: 'Itabira - MG // Fabricado no Brasil',
            },
            integration: {
              sku: groupSku,
              barcode: firstItem?.codigo || `789${group.id}`,
              blingId: String(group.id),
              weightGrams: Math.round(parseFloat(firstItem?.pesoBruto || firstItem?.pesoLiquido || '0.450') * 1000),
              dimensionsCm: {
                width: parseFloat(firstItem?.largura || '28'),
                height: parseFloat(firstItem?.altura || '12'),
                depth: parseFloat(firstItem?.profundidade || '32'),
              },
            },
            canonicalUrl: 'https://www.streetstore.com.br',
            variantsList
          };

          const hasLowResOnly = images.length > 0 && images.every(u =>
            isPlaceholderImageUrl(u) || isThumbnailLikeUrl(u)
          );
          if ((blingExtractedImages.length === 0 && images.every(u => isPlaceholderImageUrl(u))) || hasLowResOnly) {
            groupsNeedingDetailFetch.push({
              id: group.id,
              sku: groupSku,
              baseName: group.baseName,
              productRef: productObj
            });
          }

          products.push(productObj);
          existingSkus.add(groupSku);
          existingNames.add(normalizedBaseName);
          addedFromBlingCount++;
        }

        // If background image sync isn't already running, fetch up to 10 missing high-res items inline & queue full background sync
        if (groupsNeedingDetailFetch.length > 0) {
          if (!isImageSyncRunning()) {
            const inlineBatch = groupsNeedingDetailFetch.slice(0, 10);
            console.log(`[Bling Sync] ${groupsNeedingDetailFetch.length} products lacked full-res images in /produtos summary. Fetching detail media for ${inlineBatch.length}...`);
            for (const target of inlineBatch) {
              try {
                const detail = await fetchFromBling(`/produtos/${target.id}`);
                const fullData = detail?.data || detail;
                const detailImgs = extractImagesFromBlingItem(fullData);
                if (detailImgs.length > 0) {
                  target.productRef.images = detailImgs;
                  if (
                    applyImageRecordToStore(
                      imageStore,
                      { sku: target.sku, id: target.id, name: target.baseName },
                      detailImgs
                    )
                  ) {
                    imageStoreDirty = true;
                  }
                }
                await new Promise(resolve => setTimeout(resolve, 350));
              } catch {
                // continue gracefully
              }
            }

            if (groupsNeedingDetailFetch.length > inlineBatch.length) {
              syncImagesFromBling({ onBatchSaved: () => invalidateCatalogCache() })
                .then(() => invalidateCatalogCache())
                .catch(() => {});
            }
          } else {
            console.log(`[Bling Sync] Background high-res image sync already active (${groupsNeedingDetailFetch.length} products awaiting detail media).`);
          }
        }

        if (imageStoreDirty) {
          saveImageStore(imageStore);
        }

        blingCount = addedFromBlingCount;
        console.log(`[Bling Sync] Successfully merged ${addedFromBlingCount} unique product models from Bling ERP into storefront catalog.`);
      }
    } catch (blingErr: any) {
      blingError = blingErr?.message || String(blingErr);
      blingConnected = Boolean(loadBlingTokens()?.access_token);
      console.warn('[Catalog] Notice during Bling merge:', blingError);
    } finally {
      setCatalogFetchInProgress(false);
    }

    // Helper to extract base product name (strips variation labels, sizes, colors)
    function extractBaseProductName(rawName: string): string {
      let name = (rawName || '').trim();
      if (name.includes(' // ')) {
        name = name.split(' // ')[0].trim();
      }
      if (name.includes(': ')) {
        name = name.split(': ')[0].trim();
      }
      if (name.includes(' - Tam')) {
        name = name.split(' - Tam')[0].trim();
      }
      return name;
    }

    // DEDUPLICATION & STOCK AGGREGATION ENGINE
    // Rule: "verifique se tem algum item repetido caso tiver um repetido torne ele uma quantia no estoque do produto real dele sem que fique duplicado"
    const consolidatedMap = new Map<string, any>();

    function ingestOrAggregate(item: any) {
      const baseName = extractBaseProductName(item.name);
      const key = baseName.toLowerCase().replace(/\s+/g, ' ');

      if (!consolidatedMap.has(key)) {
        consolidatedMap.set(key, {
          ...item,
          name: baseName,
          stockCount: typeof item.stockCount === 'number' ? item.stockCount : 10,
          sizes: Array.isArray(item.sizes) && item.sizes.length > 0 ? [...item.sizes] : ['Tamanho Único'],
          colors: Array.isArray(item.colors) && item.colors.length > 0 ? [...item.colors] : [{ name: 'Padrão', hex: '#111111' }],
          images: Array.isArray(item.images) ? [...item.images] : [],
          variantsList: Array.isArray(item.variantsList) ? [...item.variantsList] : []
        });
      } else {
        const canonical = consolidatedMap.get(key);
        // Turn repeated item into additional stock quantity!
        canonical.stockCount += (typeof item.stockCount === 'number' ? item.stockCount : 5);

        // Merge sizes
        if (Array.isArray(item.sizes)) {
          item.sizes.forEach((sz: string) => {
            if (!canonical.sizes.includes(sz)) canonical.sizes.push(sz);
          });
        }

        // Merge colors
        if (Array.isArray(item.colors)) {
          item.colors.forEach((col: any) => {
            if (!canonical.colors.some((ex: any) => ex.name === col.name)) {
              canonical.colors.push(col);
            }
          });
        }

        // Merge images (prioritize high-res original Bling photos, strip resize params/placeholders/legacy URLs)
        if (Array.isArray(item.images)) {
          const allCombined = [...canonical.images.map((u: string) => stripResizeAndCompressionParams(u))];
          item.images.forEach((rawImg: string) => {
            const img = stripResizeAndCompressionParams(rawImg);
            if (img && !allCombined.includes(img)) {
              allCombined.push(img);
            }
          });
          const realOnly = allCombined.filter((img: string) => !isPlaceholderImageUrl(img));
          const nativeBlingOnly = realOnly.filter((img: string) => !isLegacyExternalUrl(img));
          const pool = nativeBlingOnly.length > 0 ? nativeBlingOnly : (realOnly.length > 0 ? realOnly : allCombined);
          const nonThumb = pool.filter((img: string) => !isThumbnailLikeUrl(img));
          canonical.images = (nonThumb.length > 0 ? nonThumb : pool).slice(0, 8);
        }

        // Merge variantsList
        if (Array.isArray(item.variantsList)) {
          canonical.variantsList.push(...item.variantsList);
        }

        // Update tag if now in stock
        if (canonical.stockCount > 0 && canonical.tag === 'SEM ESTOQUE') {
          canonical.tag = canonical.stockCount <= 3 ? 'POUCAS UNIDADES' : null;
        }
      }
    }

    // 1. Ingest live Bling ERP products
    products.forEach((p) => ingestOrAggregate(p));

    // 2. Fall back to baseline catalog ONLY when Bling ERP is disconnected or returned zero active items
    if (!blingConnected || blingRawCount === 0) {
      BLING_STOCK_PRODUCTS.forEach((bp) => {
        if ((bp.stockCount ?? 0) <= 0) return;
        const baseNameKey = extractBaseProductName(bp.name).toLowerCase().replace(/\s+/g, ' ');
        const skuKey = String(bp.integration?.sku || '').toUpperCase().trim();
        if (zeroStockFromBlingKeys.has(baseNameKey) || (skuKey && zeroStockFromBlingKeys.has(skuKey))) {
          return;
        }
        ingestOrAggregate(bp);
      });
    }

    const allConsolidatedProducts = Array.from(consolidatedMap.values());
    const inStockProducts = allConsolidatedProducts.filter((p) => (p.stockCount ?? 0) > 0);
    const visibleProducts = filterVisibleProducts(inStockProducts);
    const finalProducts = applyBlingImageOverrides(visibleProducts);

    console.log(`[Catalog Engine] Processed inventory: ${finalProducts.length} in-stock visible models (${allConsolidatedProducts.length - inStockProducts.length} out-of-stock auto-hidden, ${inStockProducts.length - visibleProducts.length} hidden per store rules).`);

    const hiddenCount = allConsolidatedProducts.length - finalProducts.length;
    const totalRegisteredItems = BLING_CATALOG_META?.totalRegisteredRawSKUs || 1003;
    const uniqueModels = finalProducts.length;
    const totalUnitsInStock = finalProducts.reduce((sum, p) => sum + (p.stockCount || 0), 0);
    const nowTs = Date.now();

    // Save to cache atomically for instant storefront responses & automatic background sync
    catalogCache = {
      products: finalProducts,
      count: finalProducts.length,
      blingConnected,
      blingCount,
      blingRawCount,
      blingError,
      hiddenCount,
      totalRegisteredItems,
      uniqueModels,
      totalUnitsInStock,
      timestamp: nowTs
    };

    return {
      success: true,
      count: finalProducts.length,
      products: finalProducts,
      blingConnected,
      blingCount,
      blingRawCount,
      blingError,
      hiddenCount,
      totalRegisteredItems,
      blingRegisteredSKUs: totalRegisteredItems,
      uniqueModels,
      totalUnitsInStock,
      syncedAt: new Date(nowTs).toISOString()
    };
  })().finally(() => {
    activeCatalogBuildPromise = null;
  });

  return activeCatalogBuildPromise;
}

// Unified Storefront Catalog API (Bling ERP v3 up to 1350 items + Automatic Stock & High-Res Images)
app.get('/api/catalog/products', async (req: Request, res: Response) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query._t !== undefined;
    const isCacheFresh = catalogCache && (Date.now() - catalogCache.timestamp < CATALOG_CACHE_TTL_MS);

    if (!forceRefresh && catalogCache) {
      if (!isCacheFresh) {
        // Stale-while-revalidate: serve immediately and pull latest 1350 Bling items silently in background
        buildAndCacheCatalog({ forceImageSync: false }).catch(() => {});
      }
      return res.json({
        success: true,
        count: catalogCache.count,
        products: catalogCache.products,
        blingConnected: catalogCache.blingConnected,
        blingCount: catalogCache.blingCount,
        blingRawCount: catalogCache.blingRawCount,
        blingError: catalogCache.blingError,
        hiddenCount: catalogCache.hiddenCount ?? 0,
        totalRegisteredItems: catalogCache.totalRegisteredItems ?? 1003,
        blingRegisteredSKUs: catalogCache.totalRegisteredItems ?? 1003,
        uniqueModels: catalogCache.uniqueModels ?? catalogCache.count,
        totalUnitsInStock: catalogCache.totalUnitsInStock ?? 0,
        cached: true,
        syncedAt: new Date(catalogCache.timestamp).toISOString()
      });
    }

    const payload = await buildAndCacheCatalog({ forceImageSync: req.query.refresh === 'true' });
    return res.json(payload);
  } catch (error: any) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao consultar produtos'
    });
  }
});

// Real-time Webhook for Bling ERP (estoque, produtos, imagens)
app.post(['/api/webhooks/bling', '/api/bling/webhook'], async (req: Request, res: Response) => {
  console.log('[Webhook] Bling ERP event received:', JSON.stringify(req.body));
  
  try {
    const payload = req.body || {};
    const itemData = payload.data || payload.produto || payload;
    
    // Extract images if provided in payload
    const extractedImages = extractImagesFromBlingItem(itemData);
    if (extractedImages.length > 0) {
      recordProductImage({
        sku: itemData.codigo || itemData.sku,
        name: itemData.nome,
        id: itemData.id
      }, extractedImages);
      console.log(`[Webhook Bling] Successfully captured ${extractedImages.length} updated images for product:`, itemData.nome || itemData.codigo);
    } else if (itemData.id) {
      // If only ID was sent in webhook, fetch the updated product images from Bling API
      try {
        const fullProd = await fetchFromBling(`/produtos/${itemData.id}`);
        const freshImgs = extractImagesFromBlingItem(fullProd?.data || fullProd);
        if (freshImgs.length > 0) {
          recordProductImage({
            sku: fullProd?.data?.codigo,
            name: fullProd?.data?.nome,
            id: itemData.id
          }, freshImgs);
          console.log(`[Webhook Bling] Fetched ${freshImgs.length} images from Bling API for product ID ${itemData.id}`);
        }
      } catch (fetchErr: any) {
        console.warn('[Webhook Bling] Notice: detailed product fetch skipped:', fetchErr?.message);
      }
    }
  } catch (err: any) {
    console.error('[Webhook Bling] Processing error:', err);
  }

  invalidateCatalogCache();
  res.status(200).json({ received: true, message: 'Bling webhook processed. Catalog and images updated.' });
});

// Direct Catalog Revalidation / Sync Trigger
app.all('/api/catalog/refresh', (req: Request, res: Response) => {
  if (req.query.clearImages === 'true') {
    clearImageCache(true);
  }
  invalidateCatalogCache();
  res.json({ success: true, message: 'Cache do catálogo limpo e sincronizado com sucesso!' });
});

// Clear cached images & catalog cache so full high-resolution Bling images are reloaded
app.all(['/api/bling/clear-cache', '/api/bling/clear-image-cache'], (_req: Request, res: Response) => {
  clearImageCache(true);
  invalidateCatalogCache();
  res.json({ success: true, message: 'Cache de imagens e do catálogo limpos com sucesso!' });
});

// Full Bling ERP Image Synchronizer (fetches GET /produtos/{id} -> data.midia.imagens.internas[x].link / externas[x].link)
app.all(['/api/bling/sync-images', '/api/bling/sync-media'], async (req: Request, res: Response) => {
  try {
    const clearCache = req.query.clearCache === 'true' || req.body?.clearCache === true;
    const result = await syncImagesFromBling({
      clearCache,
      onBatchSaved: () => invalidateCatalogCache()
    });
    invalidateCatalogCache();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Falha ao sincronizar imagens do Bling'
    });
  }
});

// Update or set image for any product directly (by SKU, Name, or ID)
app.post('/api/products/update-image', (req: Request, res: Response) => {
  try {
    const { sku, name, id, imageUrl, images } = req.body;
    const urls: string[] = [];
    if (imageUrl && typeof imageUrl === 'string') urls.push(imageUrl.trim());
    if (Array.isArray(images)) {
      images.forEach(img => {
        if (typeof img === 'string' && (img.trim().startsWith('http') || img.trim().startsWith('/'))) urls.push(img.trim());
      });
    }

    if (urls.length === 0) {
      return res.status(400).json({ success: false, error: 'Forneça pelo menos uma URL de imagem válida (começando com http/https ou /assets)' });
    }

    recordProductImage({ sku, name, id }, urls);
    invalidateCatalogCache();

    res.json({
      success: true,
      message: 'Imagem atualizada com sucesso no catálogo!',
      identifier: { sku, name, id },
      images: urls
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload direct image file (base64) for any product
app.post('/api/products/upload-image', (req: Request, res: Response) => {
  try {
    const { sku, name, id, fileData, imageDataUrl, fileName } = req.body;
    const rawData = fileData || imageDataUrl;
    if (!rawData || typeof rawData !== 'string') {
      return res.status(400).json({ success: false, error: 'fileData ou imageDataUrl é obrigatório em formato base64' });
    }

    const matches = rawData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let buffer: Buffer;
    let ext = 'jpg';

    if (matches && matches.length === 3) {
      const mime = matches[1];
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      else if (mime.includes('gif')) ext = 'gif';
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(rawData, 'base64');
    }

    const cleanBase = (fileName || `${sku || 'prod'}_${Date.now()}`)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    const finalFilename = `${cleanBase}_${Date.now()}.${ext}`;
    const uploadsDir = process.env.VERCEL
      ? path.resolve('/tmp', 'uploads')
      : path.resolve(process.cwd(), 'public/assets/uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filePath = path.join(uploadsDir, finalFilename);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/assets/uploads/${finalFilename}`;
    recordProductImage({ sku, name, id }, [publicUrl]);
    invalidateCatalogCache();

    res.json({
      success: true,
      message: 'Foto enviada e vinculada ao produto com sucesso!',
      imageUrl: publicUrl,
      identifier: { sku, name, id }
    });
  } catch (err: any) {
    console.error('[Upload Image Error]:', err);
    res.status(500).json({ success: false, error: err.message || 'Erro ao processar upload de imagem' });
  }
});

// Bling PDF Catalog Metadata Endpoint
app.get('/api/bling/catalog-meta', (_req: Request, res: Response) => {
  res.json({
    success: true,
    meta: BLING_CATALOG_META,
    sampleProducts: BLING_STOCK_PRODUCTS.slice(0, 10).map(p => ({
      name: p.name,
      stockCount: p.stockCount,
      price: p.price,
      sizes: p.sizes,
      sku: p.integration.sku
    }))
  });
});

// Newsletter Subscription
const newsletterSubscribers = new Set<string>();

app.post('/api/newsletter', (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@') || !email.includes('.')) {
      return res.status(400).json({
        success: false,
        error: 'Por favor, informe um e-mail válido para assinar a newsletter.'
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    newsletterSubscribers.add(cleanEmail);
    console.log(`[Newsletter] Novo assinante exclusivo Street Store: ${cleanEmail} (Total: ${newsletterSubscribers.size})`);

    return res.json({
      success: true,
      message: 'Inscrição confirmada! Você receberá todos os novos drops e descontos exclusivos.',
      couponCode: 'STREETVIP',
      discount: '15% OFF'
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro ao processar inscrição na newsletter'
    });
  }
});

// Track Order with Store Database + Bling ERP & Melhor Envio
app.get('/api/orders/track', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string || '').trim();
    if (!q) {
      return res.status(400).json({ success: false, error: 'Informe o número do pedido ou seu e-mail para rastreamento.' });
    }

    const orders = await trackStoreOrders(q);
    return res.json({
      success: true,
      orders
    });
  } catch (error: any) {
    console.error('Error tracking order:', error);
    return res.status(500).json({
      success: false,
      orders: [],
      error: error.message || 'Erro ao consultar pedidos'
    });
  }
});

// Request Return / Exchange (Melhor Envio Reverse Logistics Integration)
app.post('/api/orders/:id/return', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      orderNumber,
      customerEmail,
      customerName,
      customerPhone,
      reason,
      actionRequested,
      selectedItems,
      details
    } = req.body;

    const result = requestStoreOrderReturn({
      orderId: id,
      orderNumber: orderNumber || `#${id}`,
      customerEmail: customerEmail || '',
      customerName,
      customerPhone,
      reason,
      actionRequested,
      selectedItems: Array.isArray(selectedItems) ? selectedItems : [],
      details: details || ''
    });

    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro ao registrar solicitação de devolução'
    });
  }
});

// ==========================================
// MERCADO PAGO INTEGRATION ENDPOINTS
// ==========================================

// 1. Status / Config Check
app.get('/api/mercadopago/status', async (_req: Request, res: Response) => {
  try {
    // Validate access token with Mercado Pago user endpoint
    const response = await fetch(`${MERCADO_PAGO_API_BASE}/users/me`, {
      headers: {
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        connected: false,
        publicKey: MERCADO_PAGO_PUBLIC_KEY,
        error: `Mercado Pago API validation failed: ${errorText}`
      });
    }

    const userData = await response.json();
    return res.json({
      connected: true,
      publicKey: MERCADO_PAGO_PUBLIC_KEY,
      clientId: MERCADO_PAGO_CLIENT_ID,
      siteId: userData.site_id || 'MLB',
      nickname: userData.nickname || 'Street Store',
      email: userData.email || 'streetstore364@gmail.com'
    });
  } catch (error: any) {
    return res.status(500).json({
      connected: false,
      error: error.message || 'Falha ao verificar status do Mercado Pago'
    });
  }
});

// 2. Create Checkout Pro Preference (Cards up to 6x/12x, Boleto, MP Account)
app.post('/api/mercadopago/create-preference', async (req: Request, res: Response) => {
  try {
    const { items, payer, discountAmount = 0 } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'O carrinho está vazio' });
    }

    // Format items for Mercado Pago Preference API
    const mpItems = items.map((it: any) => ({
      id: String(it.id || it.product?.id || 'item-1'),
      title: it.name || it.title || it.product?.name || 'Peça Street Store',
      description: `Tamanho: ${it.selectedSize || 'Único'} | Cor: ${it.selectedColor || 'Padrão'}`,
      picture_url: it.image || it.product?.images?.[0] || 'https://www.streetstore.com.br/logo.png',
      category_id: 'fashion',
      quantity: Number(it.quantity) || 1,
      currency_id: 'BRL',
      unit_price: Math.max(0.01, parseFloat(Number(it.price || it.product?.price || 99.90).toFixed(2)))
    }));

    // If discount was applied, add negative or discounted balance
    if (discountAmount > 0) {
      mpItems.push({
        id: 'discount-coupon',
        title: 'Desconto Cupom Street Store',
        description: 'Cupom promocional aplicado',
        picture_url: '',
        category_id: 'discounts',
        quantity: 1,
        currency_id: 'BRL',
        unit_price: -Math.abs(parseFloat(Number(discountAmount).toFixed(2)))
      });
    }

    // Determine valid public URL for redirects
    const appUrl = process.env.APP_URL || '';
    const rawOrigin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : '');
    const validBaseUrl = (rawOrigin.startsWith('https://') && !rawOrigin.includes('localhost'))
      ? rawOrigin
      : (appUrl.startsWith('https://') ? appUrl : 'https://www.streetstore.com.br');

    const preferencePayload: Record<string, any> = {
      items: mpItems,
      payer: {
        name: payer?.name || 'Cliente Street Store',
        email: (payer?.email && payer.email.includes('@')) ? payer.email : 'streetstore364@gmail.com',
        phone: {
          area_code: '31',
          number: payer?.phone ? String(payer.phone).replace(/\D/g, '') : '984806556'
        }
      },
      back_urls: {
        success: `${validBaseUrl}/?payment_status=approved`,
        failure: `${validBaseUrl}/?payment_status=failure`,
        pending: `${validBaseUrl}/?payment_status=pending`
      },
      auto_return: 'approved',
      statement_descriptor: 'STREET STORE',
      external_reference: `ST-${Date.now()}`,
      payment_methods: {
        installments: 6,
        default_installments: 1
      }
    };

    if (validBaseUrl.startsWith('https://') && !validBaseUrl.includes('localhost')) {
      preferencePayload.notification_url = `${validBaseUrl}/api/mercadopago/webhook`;
    }

    const mpRes = await fetch(`${MERCADO_PAGO_API_BASE}/checkout/preferences`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferencePayload)
    });

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error('Mercado Pago create-preference failed:', data);
      return res.status(mpRes.status).json({
        success: false,
        error: data.message || 'Erro ao criar preferência de checkout no Mercado Pago',
        details: data
      });
    }

    return res.json({
      success: true,
      preferenceId: data.id,
      initPoint: data.init_point,
      sandboxInitPoint: data.sandbox_init_point
    });
  } catch (error: any) {
    console.error('Error creating Mercado Pago preference:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao processar preferência de pagamento'
    });
  }
});

// In-memory tracker for local Pix transactions
interface LocalPayment {
  id: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  statusDetail: string;
  createdAt: number;
  dateApproved?: string;
  payer?: any;
  items?: any[];
  shippingAddress?: any;
  shippingServiceId?: number;
  shippingCarrier?: string;
  orderId?: number;
  orderNumber?: string;
}

const localPaymentsMap = new Map<string, LocalPayment>();

// EMV BR Code Helpers for BACEN Standard Pix QR Codes
function formatEMV(id: string, value: string): string {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

function calculateCRC16(payload: string): string {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function generatePixBRCode(params: {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amount: number;
  txId?: string;
}): string {
  const { pixKey, merchantName, merchantCity, amount, txId = 'STREETSTORE' } = params;
  const formattedAmount = amount.toFixed(2);
  const f00 = formatEMV('00', '01');
  const f01 = formatEMV('01', '12');
  const gui = formatEMV('00', 'br.gov.bcb.pix');
  const key = formatEMV('01', pixKey);
  const f26 = formatEMV('26', `${gui}${key}`);
  const f52 = formatEMV('52', '0000');
  const f53 = formatEMV('53', '986');
  const f54 = formatEMV('54', formattedAmount);
  const f58 = formatEMV('58', 'BR');
  const cleanName = merchantName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 25).toUpperCase();
  const f59 = formatEMV('59', cleanName);
  const cleanCity = merchantCity.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 15).toUpperCase();
  const f60 = formatEMV('60', cleanCity);
  const f05 = formatEMV('05', txId.slice(0, 25));
  const f62 = formatEMV('62', f05);
  const rawPayload = `${f00}${f01}${f26}${f52}${f53}${f54}${f58}${f59}${f60}${f62}6304`;
  const crc = calculateCRC16(rawPayload);
  return `${rawPayload}${crc}`;
}

// 3. Create Direct Pix Payment via Mercado Pago v1/payments with zero external redirects
app.post('/api/mercadopago/create-pix', async (req: Request, res: Response) => {
  try {
    const { amount, description, payer, items, shippingAddress, shippingServiceId, shippingCarrier } = req.body;

    const numericAmount = parseFloat(Number(amount).toFixed(2));
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido para pagamento Pix' });
    }

    const email = (payer?.email && payer.email.includes('@')) 
      ? payer.email 
      : 'streetstore364@gmail.com';
    const fullName = (payer?.name && payer.name.trim()) || 'Cliente Street Store';
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || 'Cliente';
    const lastName = nameParts.slice(1).join(' ') || 'Street';

    const paymentPayload = {
      transaction_amount: numericAmount,
      description: description || 'Street Store - Pedido Streetwear Oficial',
      payment_method_id: 'pix',
      payer: {
        email,
        first_name: firstName,
        last_name: lastName,
        identification: payer?.cpf ? {
          type: 'CPF',
          number: String(payer.cpf).replace(/\D/g, '')
        } : undefined
      }
    };

    const idempotencyKey = `pix-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

    let officialMpSuccess = false;
    let data: any = null;

    try {
      const mpRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(paymentPayload)
      });
      data = await mpRes.json();
      if (mpRes.ok && data?.point_of_interaction?.transaction_data?.qr_code) {
        officialMpSuccess = true;
      } else {
        console.warn('Mercado Pago direct pix response:', data?.status, data?.message || data?.cause);
      }
    } catch (apiErr) {
      console.warn('Direct Mercado Pago API fetch failed:', apiErr);
    }

    if (officialMpSuccess && data) {
      const txData = data.point_of_interaction?.transaction_data;
      return res.json({
        success: true,
        paymentId: data.id,
        status: data.status,
        statusDetail: data.status_detail,
        amount: data.transaction_amount,
        qrCode: txData?.qr_code || '',
        qrCodeBase64: txData?.qr_code_base64 || '',
        ticketUrl: txData?.ticket_url || '',
        expiresAt: data.date_of_expiration,
        isOfficialMp: true
      });
    }

    // Generate 100% native in-app BACEN EMV BR Code QR Code for Street Store:
    console.log('Generating 100% in-app transparent Pix QR Code...');
    const pixKey = process.env.PIX_KEY || 'streetstore364@gmail.com';
    const txId = `ST${Date.now().toString().slice(-8)}`;
    const emvString = generatePixBRCode({
      pixKey,
      merchantName: 'STREET STORE',
      merchantCity: 'BELO HORIZONTE',
      amount: numericAmount,
      txId
    });

    const qrDataUrl = await QRCode.toDataURL(emvString, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    const qrCodeBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    const localPaymentId = `pix_st_${Date.now()}`;

    localPaymentsMap.set(localPaymentId, {
      id: localPaymentId,
      amount: numericAmount,
      status: 'pending',
      statusDetail: 'waiting_payment',
      createdAt: Date.now(),
      payer,
      items,
      shippingAddress,
      shippingServiceId,
      shippingCarrier
    });

    return res.json({
      success: true,
      paymentId: localPaymentId,
      status: 'pending',
      statusDetail: 'waiting_payment',
      amount: numericAmount,
      qrCode: emvString,
      qrCodeBase64,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      pixKey,
      isDirectPix: true
    });
  } catch (error: any) {
    console.error('Error generating Pix via Mercado Pago:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao gerar Pix Mercado Pago'
    });
  }
});

// 4. Confirm Pix Payment (Strict Real Verification with Mercado Pago - NEVER auto-approves)
app.post('/api/mercadopago/confirm-pix/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log(`[Pix Verification] Checking status for payment ID: ${id}`);

    // If local BACEN Pix QR Code
    if (id.startsWith('pix_st_')) {
      const payment = localPaymentsMap.get(id);
      if (!payment) {
        return res.status(404).json({
          success: false,
          approved: false,
          status: 'not_found',
          message: 'Transação não encontrada'
        });
      }

      if (payment.status === 'approved') {
        return res.json({
          success: true,
          approved: true,
          status: 'approved',
          statusDetail: 'accredited',
          orderNumber: payment.orderNumber,
          orderId: payment.orderId,
          message: 'Pagamento Pix aprovado com sucesso!'
        });
      }

      // Query Mercado Pago live payment search to verify if money actually arrived
      let paymentFoundInMp = false;
      let matchedMpPayment: any = null;

      try {
        const mpSearchRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments/search?sort=date_created&criteria=desc&limit=15`, {
          headers: {
            'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
          }
        });

        if (mpSearchRes.ok) {
          const searchData = await mpSearchRes.json();
          const results = searchData.results || [];
          
          // Look for an approved payment with matching amount created within last 30 minutes
          const match = results.find((p: any) => {
            const isApproved = p.status === 'approved';
            const amountMatches = Math.abs(p.transaction_amount - payment.amount) < 0.05;
            const createdTime = new Date(p.date_created).getTime();
            const isRecent = createdTime > (payment.createdAt - 180000);
            return isApproved && amountMatches && isRecent;
          });

          if (match) {
            paymentFoundInMp = true;
            matchedMpPayment = match;
          }
        }
      } catch (searchErr) {
        console.warn('Error querying Mercado Pago payment search:', searchErr);
      }

      if (paymentFoundInMp && matchedMpPayment) {
        // Genuine payment confirmed!
        payment.status = 'approved';
        payment.statusDetail = 'accredited';
        payment.dateApproved = matchedMpPayment.date_approved || new Date().toISOString();

        // Create official store order & sync with Bling ERP if not created yet
        if (!payment.orderId) {
          const orderRes = await createStoreOrder({
            customer: payment.payer || { email: 'streetstore364@gmail.com' },
            items: payment.items || [],
            shippingAddress: payment.shippingAddress,
            shippingServiceId: payment.shippingServiceId,
            shippingCarrier: payment.shippingCarrier,
            paymentMethod: 'Pix Instantâneo Mercado Pago',
            paymentId: matchedMpPayment.id,
            total: payment.amount
          });

          if (orderRes.success) {
            payment.orderId = orderRes.id;
            payment.orderNumber = orderRes.number;
            invalidateCatalogCache();
          }
        }

        localPaymentsMap.set(id, payment);

        return res.json({
          success: true,
          approved: true,
          status: 'approved',
          statusDetail: 'accredited',
          orderNumber: payment.orderNumber,
          orderId: payment.orderId,
          message: 'Pagamento Pix identificado e aprovado pelo Mercado Pago!'
        });
      }

      // Money has NOT arrived yet - return pending!
      return res.json({
        success: false,
        approved: false,
        status: 'pending',
        statusDetail: 'waiting_payment',
        message: 'Aguardando compensação do banco: O Mercado Pago ainda não identificou o pagamento do Pix. Assim que você transferir no app do seu banco, o status mudará automaticamente.'
      });
    }

    // Official numeric Mercado Pago Payment ID
    const mpRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments/${id}`, {
      headers: {
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
      }
    });

    if (!mpRes.ok) {
      return res.json({
        success: false,
        approved: false,
        status: 'pending',
        message: 'Aguardando compensação do banco no Mercado Pago.'
      });
    }

    const data = await mpRes.json();
    if (data.status === 'approved') {
      return res.json({
        success: true,
        approved: true,
        id: data.id,
        status: 'approved',
        statusDetail: data.status_detail,
        dateApproved: data.date_approved,
        message: 'Pagamento Pix verificado e aprovado com sucesso!'
      });
    }

    return res.json({
      success: false,
      approved: false,
      id: data.id,
      status: data.status,
      statusDetail: data.status_detail,
      message: 'Pagamento ainda não confirmado pelo banco. Abra o app do seu banco, finalize a transferência Pix e aguarde alguns segundos.'
    });

  } catch (error: any) {
    console.error('Error confirming Pix payment:', error);
    return res.status(500).json({
      success: false,
      approved: false,
      error: error.message || 'Erro ao consultar Mercado Pago'
    });
  }
});

// 5. Check Payment Status (Strict verification)
app.get('/api/mercadopago/payment-status/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (id.startsWith('pix_st_')) {
      const p = localPaymentsMap.get(id);
      if (!p) {
        return res.status(404).json({ success: false, approved: false, error: 'Pagamento não encontrado' });
      }

      // If still pending, also check Mercado Pago search in background
      if (p.status !== 'approved') {
        try {
          const mpSearchRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments/search?sort=date_created&criteria=desc&limit=10`, {
            headers: { 'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}` }
          });
          if (mpSearchRes.ok) {
            const searchData = await mpSearchRes.json();
            const results = searchData.results || [];
            const match = results.find((item: any) => {
              return item.status === 'approved' &&
                Math.abs(item.transaction_amount - p.amount) < 0.05 &&
                new Date(item.date_created).getTime() > (p.createdAt - 180000);
            });
            if (match) {
              p.status = 'approved';
              p.statusDetail = 'accredited';
              p.dateApproved = match.date_approved || new Date().toISOString();
              
              if (!p.orderId) {
                const orderRes = await createStoreOrder({
                  customer: p.payer || { email: 'streetstore364@gmail.com' },
                  items: p.items || [],
                  shippingAddress: p.shippingAddress,
                  shippingServiceId: p.shippingServiceId,
                  shippingCarrier: p.shippingCarrier,
                  paymentMethod: 'Pix Instantâneo Mercado Pago',
                  paymentId: match.id,
                  total: p.amount
                });
                if (orderRes.success) {
                  p.orderId = orderRes.id;
                  p.orderNumber = orderRes.number;
                }
              }
              localPaymentsMap.set(id, p);
            }
          }
        } catch {
          // continue
        }
      }

      return res.json({
        success: true,
        approved: p.status === 'approved',
        id: p.id,
        status: p.status,
        statusDetail: p.statusDetail,
        dateApproved: p.dateApproved,
        orderNumber: p.orderNumber,
        orderId: p.orderId
      });
    }

    const mpRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments/${id}`, {
      headers: {
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      }
    });

    if (!mpRes.ok) {
      return res.status(mpRes.status).json({
        success: false,
        approved: false,
        error: 'Pagamento não encontrado no Mercado Pago'
      });
    }

    const data = await mpRes.json();
    return res.json({
      success: true,
      approved: data.status === 'approved',
      id: data.id,
      status: data.status,
      statusDetail: data.status_detail,
      dateApproved: data.date_approved
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      approved: false,
      error: error.message || 'Erro ao consultar status'
    });
  }
});

// 5. Checkout Transparente com Cartão de Crédito
app.post('/api/mercadopago/process-card', async (req: Request, res: Response) => {
  try {
    const { 
      token: clientToken, 
      cardData,
      transactionAmount, 
      description, 
      installments = 1, 
      paymentMethodId, 
      payer,
      items,
      shippingAddress,
      shippingServiceId,
      shippingCarrier
    } = req.body;

    let cardToken = clientToken;

    // Se o frontend enviou dados do cartão, tokenizar no Mercado Pago
    if (!cardToken && cardData) {
      const cleanCardNum = String(cardData.cardNumber).replace(/\D/g, '');
      const expMonth = parseInt(String(cardData.expirationMonth), 10);
      let expYear = String(cardData.expirationYear).trim();
      if (expYear.length === 2) expYear = `20${expYear}`;

      const tokenRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/card_tokens?public_key=${MERCADO_PAGO_PUBLIC_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_number: cleanCardNum,
          expiration_month: expMonth,
          expiration_year: parseInt(expYear, 10),
          security_code: String(cardData.securityCode).trim(),
          cardholder: {
            name: (cardData.cardholderName || payer?.name || 'CLIENTE STREET STORE').toUpperCase().trim(),
            identification: {
              type: 'CPF',
              number: String(cardData.cpf || payer?.cpf || '19119119100').replace(/\D/g, '')
            }
          }
        })
      });

      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenJson.id) {
        console.error('Mercado Pago token generation failed:', tokenJson);
        return res.status(400).json({
          success: false,
          error: tokenJson.message || tokenJson.cause?.[0]?.description || 'Dados do cartão inválidos. Verifique número, validade e CVV.'
        });
      }
      cardToken = tokenJson.id;
    }

    if (!cardToken) {
      return res.status(400).json({ success: false, error: 'Token do cartão não gerado' });
    }

    const email = (payer?.email && payer.email.includes('@')) 
      ? payer.email 
      : 'streetstore364@gmail.com';
    const fullName = (payer?.name && payer.name.trim()) || 'Cliente Street Store';
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || 'Cliente';
    const lastName = nameParts.slice(1).join(' ') || 'Street';
    const cleanCpf = String(payer?.cpf || cardData?.cpf || '19119119100').replace(/\D/g, '');

    // Identificar bandeira automaticamente se não enviada
    let methodId = paymentMethodId;
    if (!methodId && cardData?.cardNumber) {
      const firstDigit = String(cardData.cardNumber).replace(/\D/g, '').charAt(0);
      const firstTwo = String(cardData.cardNumber).replace(/\D/g, '').substring(0, 2);
      if (firstDigit === '4') methodId = 'visa';
      else if (firstDigit === '5') methodId = 'master';
      else if (['34', '37'].includes(firstTwo)) methodId = 'amex';
      else methodId = 'visa';
    }

    const paymentPayload = {
      token: cardToken,
      transaction_amount: parseFloat(Number(transactionAmount).toFixed(2)),
      description: description || 'Street Store - Pedido Streetwear Oficial',
      installments: Number(installments) || 1,
      payment_method_id: methodId || 'visa',
      payer: {
        email,
        first_name: firstName,
        last_name: lastName,
        identification: {
          type: 'CPF',
          number: cleanCpf
        }
      },
      statement_descriptor: 'STREET STORE'
    };

    const idempotencyKey = `card-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

    const mpRes = await fetch(`${MERCADO_PAGO_API_BASE}/v1/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(paymentPayload)
    });

    const paymentResult = await mpRes.json();

    if (!mpRes.ok) {
      console.error('Mercado Pago card payment failed:', paymentResult);
      return res.status(mpRes.status).json({
        success: false,
        status: paymentResult.status || 'rejected',
        statusDetail: paymentResult.status_detail,
        error: paymentResult.message || paymentResult.cause?.[0]?.description || 'Erro ao processar cartão no Mercado Pago',
        details: paymentResult
      });
    }

    // Sync order on card approval & register in Bling ERP if connected
    let orderNumber: string | undefined = undefined;
    let orderId: number | undefined = undefined;

    if (paymentResult.status === 'approved') {
      try {
        const orderRes = await createStoreOrder({
          customer: {
            name: fullName,
            email,
            phone: payer?.phone,
            cpf: cleanCpf
          },
          items: items || [],
          shippingAddress,
          shippingServiceId,
          shippingCarrier,
          paymentMethod: `Cartão de Crédito ${installments}x (${methodId})`,
          paymentId: paymentResult.id,
          total: parseFloat(Number(transactionAmount).toFixed(2))
        });
        if (orderRes.success) {
          orderNumber = orderRes.number;
          orderId = orderRes.id;
          invalidateCatalogCache();
        }
      } catch (err) {
        console.warn('Could not register store order after card approval:', err);
      }
    }

    return res.json({
      success: true,
      paymentId: paymentResult.id,
      status: paymentResult.status,
      statusDetail: paymentResult.status_detail,
      amount: paymentResult.transaction_amount,
      installments: paymentResult.installments,
      paymentMethodId: paymentResult.payment_method_id,
      dateApproved: paymentResult.date_approved,
      orderNumber,
      orderId
    });

  } catch (error: any) {
    console.error('Error processing transparent card payment:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Erro interno ao processar pagamento com cartão'
    });
  }
});

// 6. Webhook receiver
app.post('/api/mercadopago/webhook', async (req: Request, res: Response) => {
  // Acknowledge notification from Mercado Pago
  console.log('[Mercado Pago Webhook Received]:', req.body);
  res.status(200).send('OK');
});

// Handle checkout telemetry calls gracefully
app.all(['/checkout/api_integration', '/checkout/api_integration/*'], (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', received: true });
});

// 7. Bling ERP Integration Routes (OAuth & Data sync) + explicit /api/bling router mount
registerBlingRoutes(app, {
  onTokensUpdated: () => {
    invalidateCatalogCache();
    buildAndCacheCatalog({ forceImageSync: false })
      .catch(() => {})
      .finally(() => {
        syncImagesFromBling({ onBatchSaved: () => reapplyImagesToCachedCatalog() })
          .then(() => reapplyImagesToCachedCatalog())
          .catch(() => {});
      });
  }
});
app.use('/api/bling', blingRouter);

// 8. Melhor Envio Logistics Routes (OAuth, Shipping Quotes, Labels & Tracking)
registerMelhorEnvioRoutes(app);

// Vite & Static file handler
async function setupViteOrStatic() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
        hmr: false,
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
    console.log(`[Dev] Vite middleware attached (HMR disabled).`);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
    console.log(`[Prod] Serving static files from ${distPath}`);
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Street Store Full-Stack Server running on port ${PORT}`);

      // 1. Automatically keep Melhor Envio connected, tokens refreshed, & shipments synced on startup + periodically
      startMelhorEnvioAutoSync();

      // 2. Automatically validate/refresh Bling token & warm up to 1500 products + stock + high-res photos on startup
      ensureBlingAuthorized()
        .then((authorized) => {
          if (!authorized) {
            console.log('[Startup Bling Auth] Nenhuma sessão Bling salva ou refresh_token disponível no momento.');
            return;
          }
          return buildAndCacheCatalog({ forceImageSync: false })
            .then((catResult) => {
              console.log(`[Startup Bling Catalog] ${catResult.count} produtos em estoque pré-carregados (Bling bruto: ${catResult.blingRawCount}).`);
            })
            .catch((err) => {
              console.warn('[Startup Bling Catalog] Notice:', err?.message || err);
            })
            .finally(() => {
              syncImagesFromBling({ onBatchSaved: () => reapplyImagesToCachedCatalog() })
                .then((syncRes) => {
                  reapplyImagesToCachedCatalog();
                  console.log(`[Startup Bling Sync] ${syncRes.message}`);
                })
                .catch((err) => {
                  console.warn('[Startup Bling Sync] Notice:', err?.message || err);
                });
            });
        })
        .catch(() => {});

      // 3. Proactive Bling OAuth keepalive every 3 hours so session renews automatically without clicks
      const tokenKeepaliveTimer = setInterval(() => {
        const t = loadBlingTokens();
        if (t?.refresh_token) {
          refreshBlingToken().catch(() => {});
        }
      }, 3 * 60 * 60 * 1000);
      if (typeof tokenKeepaliveTimer.unref === 'function') tokenKeepaliveTimer.unref();

      // 4. Periodic background auto-sync: refresh up to 1500 Bling products & stock every 3 min + full-res photos every 15 min
      const catalogSyncTimer = setInterval(() => {
        const t = loadBlingTokens();
        if (t?.access_token || t?.refresh_token) {
          buildAndCacheCatalog({ forceImageSync: false }).catch(() => {});
        }
      }, 3 * 60 * 1000);
      if (typeof catalogSyncTimer.unref === 'function') catalogSyncTimer.unref();

      const imageSyncTimer = setInterval(() => {
        const t = loadBlingTokens();
        if ((t?.access_token || t?.refresh_token) && !isImageSyncRunning()) {
          syncImagesFromBling({ onBatchSaved: () => reapplyImagesToCachedCatalog() })
            .then(() => reapplyImagesToCachedCatalog())
            .catch(() => {});
        }
      }, 15 * 60 * 1000);
      if (typeof imageSyncTimer.unref === 'function') imageSyncTimer.unref();
    });
  }
}

if (!process.env.VERCEL) {
  setupViteOrStatic().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

export default app;
export { app };
