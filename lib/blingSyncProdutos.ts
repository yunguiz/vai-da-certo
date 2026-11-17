import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminFirestore } from './firebaseAdmin';
import { getValidBlingToken, BLING_OFFICIAL_API_BASE, BLING_API_BASE } from './blingToken';

export { BLING_OFFICIAL_API_BASE, BLING_API_BASE };

export interface SyncProdutosPageResult {
  success: boolean;
  finalizado: boolean;
  totalImportado?: number;
  proximaPagina?: number;
  importadosNaPagina?: number;
  documentosGravados?: number;
}

export interface SyncAllResult {
  success: boolean;
  finalizado: boolean;
  paginaInicial: number;
  ultimaPagina: number;
  proximaPagina?: number;
  paginasProcessadas: number;
  totalImportado: number;
  documentosGravados: number;
  duracaoMs: number;
  paradoPorTempoLimite?: boolean;
}

interface BlingCategoriaRaw {
  id?: number | string;
  descricao?: string;
}

interface BlingMediaEntry {
  link?: string;
  url?: string;
  linkMiniatura?: string;
  ordem?: number;
}

interface BlingProdutoRaw {
  id: number | string;
  nome?: string;
  codigo?: string;
  preco?: number | string;
  tipo?: string;
  situacao?: string;
  formato?: string;
  idProdutoPai?: number | string | null;
  imagemURL?: string;
  descricaoCurta?: string;
  descricaoComplementar?: string;
  categoria?: BlingCategoriaRaw | null;
  estoque?: {
    saldoVirtualTotal?: number | string;
    saldoFisicoTotal?: number | string;
    saldoFisico?: number | string;
  } | null;
  midia?: {
    imagens?: {
      internas?: BlingMediaEntry[];
      externas?: BlingMediaEntry[];
    };
  } | null;
  variacao?: {
    nome?: string;
    ordem?: number;
    produtoPai?: { id?: number | string };
  } | null;
  variacoes?: BlingProdutoRaw[];
}

export function verifySyncSecret(providedSecret?: string | null): boolean {
  const expected = (process.env.CRON_SECRET || '').trim();
  const actual = (providedSecret || '').trim();

  if (!expected || !actual) {
    return false;
  }

  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function cleanBlingDescription(raw?: string): string {
  if (!raw) return '';
  return String(raw)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1500);
}

function isThumbnailLikeUrl(url: string): boolean {
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

function cleanBlingImageUrl(url?: string): string {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/assets/')) return raw;
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    for (const key of ['w', 'h', 'width', 'height', 'size', 'quality', 'q', 'resize', 'fit', 'thumb', 'mini']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function extractAllImageUrls(item: BlingProdutoRaw): string[] {
  const highRes: string[] = [];
  const thumbs: string[] = [];

  const pushUrl = (raw: string | undefined, target: string[]) => {
    const cleaned = cleanBlingImageUrl(raw);
    if (cleaned && !target.includes(cleaned)) {
      target.push(cleaned);
    }
  };

  const internas = Array.isArray(item.midia?.imagens?.internas)
    ? [...item.midia!.imagens!.internas!].sort((a, b) => (a?.ordem ?? 0) - (b?.ordem ?? 0))
    : [];
  const externas = Array.isArray(item.midia?.imagens?.externas)
    ? [...item.midia!.imagens!.externas!].sort((a, b) => (a?.ordem ?? 0) - (b?.ordem ?? 0))
    : [];

  for (const entry of [...internas, ...externas]) {
    const full = entry?.link || entry?.url;
    if (full) {
      if (isThumbnailLikeUrl(full)) {
        pushUrl(full, thumbs);
      } else {
        pushUrl(full, highRes);
      }
    }
    if (entry?.linkMiniatura) {
      pushUrl(entry.linkMiniatura, thumbs);
    }
  }

  if (item.imagemURL) {
    if (isThumbnailLikeUrl(item.imagemURL)) {
      pushUrl(item.imagemURL, thumbs);
    } else {
      pushUrl(item.imagemURL, highRes);
    }
  }

  return highRes.length > 0 ? highRes : thumbs;
}

let cachedImageSeed: {
  byId: Record<string, string[]>;
  bySku: Record<string, string[]>;
} | null = null;

function loadReadOnlyImageSeed() {
  if (cachedImageSeed) return cachedImageSeed;
  const empty = { byId: {}, bySku: {} };
  try {
    const tmpSeed = path.resolve('/tmp', '.bling_product_images.json');
    const rootSeed = path.resolve(process.cwd(), '.bling_product_images.json');
    const target = fs.existsSync(tmpSeed) ? tmpSeed : (fs.existsSync(rootSeed) ? rootSeed : null);
    if (target) {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      cachedImageSeed = {
        byId: parsed?.byId || {},
        bySku: parsed?.bySku || {},
      };
      return cachedImageSeed;
    }
  } catch {
    // ignore read-only cache errors
  }
  cachedImageSeed = empty;
  return cachedImageSeed;
}

function inferCategory(item: BlingProdutoRaw): {
  label: string;
  categoriaStore: 'roupas' | 'calcados' | 'acessorios';
  subcategoriaStore: 'hoodies' | 'camisetas' | 'calcas' | 'shorts' | 'sneakers' | 'bones' | 'bags' | 'acessorios-metal';
} {
  const rawDesc = String(item.categoria?.descricao || '').trim();
  const lower = `${rawDesc} ${String(item.nome || '')}`.toLowerCase();

  if (/\b(boné|bone|bucket|gorro|touca)\b/i.test(lower)) {
    return { label: rawDesc || 'Acessórios', categoriaStore: 'acessorios', subcategoriaStore: 'bones' };
  }
  if (/\b(bag|shoulder|mochila|pochete|mala)\b/i.test(lower)) {
    return { label: rawDesc || 'Acessórios', categoriaStore: 'acessorios', subcategoriaStore: 'bags' };
  }
  if (/\b(oculos|óculos|radar|juliet|penny|oakley|cartier|cinto|carteira|relogio|relógio|corrente|meia|cadarco|cadarço)\b/i.test(lower)) {
    return { label: rawDesc || 'Acessórios', categoriaStore: 'acessorios', subcategoriaStore: 'acessorios-metal' };
  }
  if (/\b(tenis|tênis|sneaker|chinelo|bota|sandalia|sapato|dunk|jordan|air max|yeezy)\b/i.test(lower)) {
    return { label: rawDesc || 'Calçados', categoriaStore: 'calcados', subcategoriaStore: 'sneakers' };
  }
  if (/\b(moletom|hoodie|jaqueta|corta vento|bobojoco|casaco)\b/i.test(lower)) {
    return { label: rawDesc || 'Moletons & Jaquetas', categoriaStore: 'roupas', subcategoriaStore: 'hoodies' };
  }
  if (/\b(calca|calça|cargo|jogger|jeans)\b/i.test(lower)) {
    return { label: rawDesc || 'Calças', categoriaStore: 'roupas', subcategoriaStore: 'calcas' };
  }
  if (/\b(bermuda|short)\b/i.test(lower)) {
    return { label: rawDesc || 'Bermudas & Shorts', categoriaStore: 'roupas', subcategoriaStore: 'shorts' };
  }

  return { label: rawDesc || 'Camisetas & Vestuário', categoriaStore: 'roupas', subcategoriaStore: 'camisetas' };
}

function parseVariantMeta(item: BlingProdutoRaw): {
  baseName: string;
  size: string;
  color: string;
} {
  const fullName = String(item.nome || '').trim();
  const varLabel = String(item.variacao?.nome || '').trim();

  let baseName = fullName;
  if (baseName.includes(' // ')) {
    baseName = baseName.split(' // ')[0].trim();
  } else if (baseName.includes(': ')) {
    baseName = baseName.split(': ')[0].trim();
  } else if (baseName.includes(' - Tam')) {
    baseName = baseName.split(' - Tam')[0].trim();
  }

  let size = '';
  if (varLabel) {
    const tamMatch = varLabel.match(/(?:tamanho|tam|size)\s*[:=]\s*([^;|,/]+)/i);
    if (tamMatch?.[1]) {
      size = tamMatch[1].trim();
    } else if (/^(PP|P|M|G|GG|XG|XGG|XXG|G[1-4]|Único|Unico|\d{2})$/i.test(varLabel)) {
      size = varLabel;
    }
  }

  if (!size && fullName.includes(':')) {
    const afterColon = fullName.split(':').slice(1).join(':').trim();
    if (afterColon && afterColon.length <= 24) {
      size = afterColon.replace(/^tam(?:anho)?\s*/i, '').trim();
    }
  }

  if (!size) {
    const endSizeMatch = fullName.match(/\b(PP|P|M|G|GG|XG|XGG|G[1-4]|3[4-9]|4[0-6])\s*$/i);
    if (endSizeMatch?.[1]) {
      size = endSizeMatch[1].toUpperCase();
    }
  }

  let color = '';
  const colorSource = `${varLabel} ${fullName}`;
  const colorMatch = colorSource.match(
    /\b(preto|preta|branco|branca|off[- ]?white|cinza|chumbo|grafite|azul|marinho|verde|militar|vermelho|vermelha|rosa|roxo|bege|caqui|marrom|laranja|amarelo)\b/i
  );
  if (colorMatch?.[1]) {
    color = colorMatch[1].charAt(0).toUpperCase() + colorMatch[1].slice(1).toLowerCase();
  }

  return {
    baseName: baseName || fullName || `Produto ${item.id}`,
    size: size || 'Único',
    color: color || 'Padrão',
  };
}

function getStockQuantity(item: BlingProdutoRaw, realStockMap?: Map<string, number>): number {
  const idKey = String(item.id);
  if (realStockMap && realStockMap.has(idKey)) {
    return realStockMap.get(idKey)!;
  }
  const raw =
    item.estoque?.saldoVirtualTotal ??
    item.estoque?.saldoFisicoTotal ??
    item.estoque?.saldoFisico ??
    0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

async function fetchBlingJson<T = unknown>(accessToken: string, pathAndQuery: string): Promise<T> {
  const endpoint = `${BLING_API_BASE}${pathAndQuery}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'StreetStore/1.0',
    },
  });

  const rawText = await response.text();
  let json: T & { error?: unknown };
  try {
    json = JSON.parse(rawText) as T & { error?: unknown };
  } catch {
    throw new Error(`Resposta inválida do Bling [${response.status}]: ${rawText.slice(0, 200)}`);
  }

  if (!response.ok || json.error) {
    throw new Error(`Erro Bling API [${response.status}]: ${rawText.slice(0, 300)}`);
  }

  return json;
}

async function fetchStockBalancesForIds(accessToken: string, ids: string[]): Promise<Map<string, number>> {
  const stockMap = new Map<string, number>();
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  for (let i = 0; i < uniqueIds.length; i += 50) {
    const chunk = uniqueIds.slice(i, i + 50);
    const qs = chunk.map((id) => `idsProdutos[]=${encodeURIComponent(id)}`).join('&');
    try {
      const res = await fetchBlingJson<{
        data?: Array<{
          produto?: { id?: number | string };
          saldoVirtualTotal?: number | string;
          saldoFisicoTotal?: number | string;
          saldoFisico?: number | string;
        }>;
      }>(accessToken, `/estoques/saldos?${qs}`);
      for (const entry of res.data || []) {
        const pId = entry?.produto?.id;
        if (pId !== undefined && pId !== null) {
          const bal = entry.saldoVirtualTotal ?? entry.saldoFisicoTotal ?? entry.saldoFisico ?? 0;
          stockMap.set(String(pId), Math.max(0, Number(bal) || 0));
        }
      }
    } catch {
      // Fallback silencioso para saldo embutido em /produtos caso /estoques/saldos sofra rate-limit
    }
  }
  return stockMap;
}

/**
 * Busca uma página (100 produtos ativos) na API v3 do Bling e grava em lote via WriteBatch
 * na coleção `products` do Firestore usando o `id` do Bling (ou `idProdutoPai` para variações)
 * como ID do documento com `{ merge: true }`.
 */
export async function syncBlingProdutosPageToFirestore(
  paginaInput: number,
  options?: { enrichHighResImages?: boolean; maxDetailMs?: number }
): Promise<SyncProdutosPageResult> {
  const pagina = Number.isFinite(paginaInput) && paginaInput >= 1 ? Math.floor(paginaInput) : 1;
  const accessToken = await getValidBlingToken();

  const json = await fetchBlingJson<{ data?: BlingProdutoRaw[] }>(
    accessToken,
    `/produtos?pagina=${pagina}&limite=100&criterio=2`
  );

  const lista = Array.isArray(json.data) ? json.data : [];

  if (lista.length === 0) {
    return {
      success: true,
      finalizado: true,
      totalImportado: 0,
    };
  }

  // Busca saldos reais de estoque em até 2 chamadas (chunks de 50 IDs)
  const itemIds = lista.map((item) => String(item.id));
  const realStockMap = await fetchStockBalancesForIds(accessToken, itemIds);
  const imageSeed = loadReadOnlyImageSeed();

  type GroupedProductWrite = {
    docId: string;
    blingId: string;
    nome?: string;
    codigo?: string;
    preco?: number;
    estoqueDireto?: number;
    imagens: string[];
    imagemURL?: string;
    categoria?: string;
    categoriaStore?: 'roupas' | 'calcados' | 'acessorios';
    subcategoriaStore?: string;
    categoriaId?: string | null;
    descricao?: string;
    sizes: Set<string>;
    colors: Set<string>;
    variacoes: Record<
      string,
      {
        blingId: string;
        codigo: string;
        nome: string;
        tamanho: string;
        cor: string;
        preco: number;
        estoque: number;
        imagemURL: string;
      }
    >;
    hasParentRecord: boolean;
  };

  const grouped = new Map<string, GroupedProductWrite>();

  const ensureGroup = (docId: string): GroupedProductWrite => {
    let entry = grouped.get(docId);
    if (!entry) {
      entry = {
        docId,
        blingId: docId,
        imagens: [],
        sizes: new Set<string>(),
        colors: new Set<string>(),
        variacoes: {},
        hasParentRecord: false,
      };
      grouped.set(docId, entry);
    }
    return entry;
  };

  const mergeImages = (target: string[], incoming: string[]) => {
    const combined = [...target];
    for (const url of incoming) {
      if (url && !combined.includes(url)) {
        combined.push(url);
      }
    }
    const fullRes = combined.filter((u) => !isThumbnailLikeUrl(u));
    return (fullRes.length > 0 ? fullRes : combined).slice(0, 10);
  };

  for (const item of lista) {
    const itemId = String(item.id);
    const parentIdRaw = item.idProdutoPai ?? item.variacao?.produtoPai?.id ?? null;
    const hasParent = parentIdRaw !== null && parentIdRaw !== undefined && Number(parentIdRaw) > 0;
    const docId = hasParent ? String(parentIdRaw) : itemId;

    const group = ensureGroup(docId);
    const meta = parseVariantMeta(item);
    const stock = getStockQuantity(item, realStockMap);
    const price = Number(item.preco || 0);
    const skuKey = String(item.codigo || '').toUpperCase().trim();
    const seedImgs = [
      ...(imageSeed.byId[itemId] || []),
      ...(hasParent ? imageSeed.byId[docId] || [] : []),
      ...(skuKey ? imageSeed.bySku[skuKey] || [] : []),
    ];
    const itemImgs = mergeImages(extractAllImageUrls(item), seedImgs);
    const primaryImg = itemImgs[0] || '';
    const catInfo = inferCategory(item);
    const desc = cleanBlingDescription(item.descricaoCurta || item.descricaoComplementar);

    if (itemImgs.length > 0) {
      group.imagens = mergeImages(group.imagens, itemImgs);
      group.imagemURL = group.imagens[0] || group.imagemURL;
    }

    if (!hasParent) {
      group.hasParentRecord = true;
      group.blingId = itemId;
      group.nome = meta.baseName;
      group.codigo = String(item.codigo || '');
      group.preco = price;
      group.estoqueDireto = stock;
      group.categoria = catInfo.label;
      group.categoriaStore = catInfo.categoriaStore;
      group.subcategoriaStore = catInfo.subcategoriaStore;
      group.categoriaId = item.categoria?.id ? String(item.categoria.id) : null;
      if (desc) group.descricao = desc;

      if (Array.isArray(item.variacoes) && item.variacoes.length > 0) {
        for (const v of item.variacoes) {
          const vMeta = parseVariantMeta(v);
          const vStock = getStockQuantity(v, realStockMap);
          const vPrice = Number(v.preco || price || 0);
          const vImgs = extractAllImageUrls(v);
          const vImg = vImgs[0] || primaryImg;
          if (vImgs.length > 0) {
            group.imagens = mergeImages(group.imagens, vImgs);
            group.imagemURL = group.imagens[0] || group.imagemURL;
          }
          group.sizes.add(vMeta.size);
          group.colors.add(vMeta.color);
          group.variacoes[String(v.id)] = {
            blingId: String(v.id),
            codigo: String(v.codigo || ''),
            nome: String(v.nome || meta.baseName),
            tamanho: vMeta.size,
            cor: vMeta.color,
            preco: vPrice,
            estoque: vStock,
            imagemURL: vImg,
          };
        }
      } else {
        if (meta.size !== 'Único') group.sizes.add(meta.size);
        if (meta.color !== 'Padrão') group.colors.add(meta.color);
      }
    } else {
      if (!group.nome) group.nome = meta.baseName;
      if (!group.categoria) {
        group.categoria = catInfo.label;
        group.categoriaStore = catInfo.categoriaStore;
        group.subcategoriaStore = catInfo.subcategoriaStore;
      }
      if (!group.preco && price > 0) group.preco = price;
      if (!group.descricao && desc) group.descricao = desc;

      group.sizes.add(meta.size);
      if (meta.color !== 'Padrão') group.colors.add(meta.color);

      group.variacoes[itemId] = {
        blingId: itemId,
        codigo: String(item.codigo || ''),
        nome: String(item.nome || meta.baseName),
        tamanho: meta.size,
        cor: meta.color,
        preco: price,
        estoque: stock,
        imagemURL: primaryImg,
      };
    }
  }

  // Enriquecimento opcional de imagens em alta resolução (.link via GET /produtos/{id}) respeitando teto de tempo
  if (options?.enrichHighResImages !== false) {
    const detailBudgetMs = options?.maxDetailMs ?? 2200;
    const detailStart = Date.now();
    const candidates = Array.from(grouped.values()).filter(
      (g) => g.imagens.length === 0 || g.imagens.every((u) => isThumbnailLikeUrl(u))
    );

    for (const group of candidates.slice(0, 8)) {
      if (Date.now() - detailStart >= detailBudgetMs) break;
      try {
        const detail = await fetchBlingJson<{ data?: BlingProdutoRaw }>(accessToken, `/produtos/${group.docId}`);
        const fullItem = detail?.data;
        if (fullItem) {
          const fullImgs = extractAllImageUrls(fullItem);
          if (fullImgs.length > 0) {
            group.imagens = mergeImages(fullImgs, group.imagens);
            group.imagemURL = group.imagens[0] || group.imagemURL;
          }
          const fullDesc = cleanBlingDescription(fullItem.descricaoCurta || fullItem.descricaoComplementar);
          if (fullDesc && !group.descricao) {
            group.descricao = fullDesc;
          }
        }
      } catch {
        // Continua graciosamente sem travar o lote
      }
    }
  }

  const db = getAdminFirestore();
  const nowIso = new Date().toISOString();
  const entries = Array.from(grouped.values());

  // Firestore WriteBatch suporta no máximo 500 operações por commit
  for (let i = 0; i < entries.length; i += 400) {
    const slice = entries.slice(i, i + 400);
    const batch = db.batch();

    for (const group of slice) {
      const docRef = db.collection('products').doc(group.docId);
      const variacoesList = Object.values(group.variacoes);
      const estoqueTotalVariacoes = variacoesList.reduce((acc, v) => acc + v.estoque, 0);

      const payload: Record<string, unknown> = {
        blingId: group.blingId,
        ativo: true,
        updatedAt: FieldValue.serverTimestamp(),
        syncedAtIso: nowIso,
      };

      if (group.hasParentRecord) {
        payload.nome = group.nome;
        payload.codigo = group.codigo;
        payload.preco = group.preco ?? 0;
        payload.estoque = variacoesList.length > 0 ? estoqueTotalVariacoes : (group.estoqueDireto ?? 0);
        if (group.imagemURL) payload.imagemURL = group.imagemURL;
        if (group.imagens.length > 0) payload.imagens = group.imagens;
        if (group.categoria) payload.categoria = group.categoria;
        if (group.categoriaStore) payload.categoriaStore = group.categoriaStore;
        if (group.subcategoriaStore) payload.subcategoriaStore = group.subcategoriaStore;
        if (group.categoriaId !== undefined) payload.categoriaId = group.categoriaId;
        if (group.descricao) payload.descricao = group.descricao;
      } else {
        if (group.nome) payload.nome = group.nome;
        if (group.categoria) payload.categoria = group.categoria;
        if (group.categoriaStore) payload.categoriaStore = group.categoriaStore;
        if (group.subcategoriaStore) payload.subcategoriaStore = group.subcategoriaStore;
        if (group.imagemURL) payload.imagemURL = group.imagemURL;
        if (group.imagens.length > 0) payload.imagens = group.imagens;
        if (group.preco !== undefined && group.preco > 0) payload.preco = group.preco;
        if (group.descricao) payload.descricao = group.descricao;
        if (variacoesList.length > 0) {
          payload.estoque = estoqueTotalVariacoes;
        }
      }

      if (group.sizes.size > 0) {
        payload.tamanhos = FieldValue.arrayUnion(...Array.from(group.sizes));
      }
      if (group.colors.size > 0) {
        payload.cores = FieldValue.arrayUnion(...Array.from(group.colors));
      }
      if (Object.keys(group.variacoes).length > 0) {
        payload.variacoes = group.variacoes;
      }

      batch.set(docRef, payload, { merge: true });
    }

    await batch.commit();
  }

  return {
    success: true,
    finalizado: false,
    proximaPagina: pagina + 1,
    importadosNaPagina: lista.length,
    documentosGravados: grouped.size,
  };
}

/**
 * Percorre automaticamente páginas do Bling (`pagina = startPage` até o fim)
 * dentro de um orçamento de tempo seguro para nunca estourar o timeout da Vercel.
 */
export async function syncAllBlingProdutosToFirestore(options?: {
  startPage?: number;
  maxExecutionMs?: number;
  maxPages?: number;
  enrichHighResImages?: boolean;
}): Promise<SyncAllResult> {
  const startedAt = Date.now();
  const startPage = Math.max(1, Math.floor(options?.startPage || 1));
  const maxExecutionMs = Math.max(2000, options?.maxExecutionMs ?? (process.env.VERCEL ? 7500 : 50000));
  const maxPages = Math.max(1, options?.maxPages ?? 30);

  let currentPage = startPage;
  let ultimaPagina = startPage;
  let paginasProcessadas = 0;
  let totalImportado = 0;
  let documentosGravados = 0;
  let finalizado = false;
  let paradoPorTempoLimite = false;

  while (paginasProcessadas < maxPages) {
    const elapsed = Date.now() - startedAt;
    if (paginasProcessadas > 0 && elapsed >= maxExecutionMs) {
      paradoPorTempoLimite = true;
      break;
    }

    const remainingBudget = Math.max(500, maxExecutionMs - elapsed);
    const pageResult = await syncBlingProdutosPageToFirestore(currentPage, {
      enrichHighResImages: options?.enrichHighResImages ?? remainingBudget > 4000,
      maxDetailMs: Math.min(1800, Math.floor(remainingBudget * 0.25)),
    });

    ultimaPagina = currentPage;
    paginasProcessadas++;

    if (pageResult.finalizado) {
      finalizado = true;
      break;
    }

    totalImportado += pageResult.importadosNaPagina || 0;
    documentosGravados += pageResult.documentosGravados || 0;
    currentPage = pageResult.proximaPagina || currentPage + 1;
  }

  return {
    success: true,
    finalizado,
    paginaInicial: startPage,
    ultimaPagina,
    ...(finalizado ? {} : { proximaPagina: currentPage }),
    paginasProcessadas,
    totalImportado,
    documentosGravados,
    duracaoMs: Date.now() - startedAt,
    ...(paradoPorTempoLimite ? { paradoPorTempoLimite: true } : {}),
  };
}
