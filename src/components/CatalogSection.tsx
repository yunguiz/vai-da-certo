import { useState, useMemo, useEffect } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { motion } from 'motion/react';
import { collection, onSnapshot } from 'firebase/firestore';
import { Product, ProductCategory, ProductSubcategory } from '../types';
import { ProductCard } from './ProductCard';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { cleanDescription } from '../lib/cleanHtml';
import { filterVisibleProducts } from '../lib/hiddenProducts';

interface CatalogSectionProps {
  products: Product[];
  activeCategory: ProductCategory | 'all';
  activeSubcategory?: string;
  brandFilter?: string;
  onClearBrandFilter?: () => void;
  favorites: string[];
  isCatalogLive?: boolean;
  catalogCount?: number;
  onToggleFavorite: (productId: string) => void;
  onSelectCategory: (cat: ProductCategory | 'all', subcat?: string) => void;
  onOpenProduct: (product: Product) => void;
  onQuickAdd: (product: Product) => void;
}

const COLOR_HEX_MAP: Record<string, string> = {
  preto: '#111111',
  preta: '#111111',
  branco: '#FFFFFF',
  branca: '#FFFFFF',
  'off-white': '#EAE6DF',
  'off white': '#EAE6DF',
  cinza: '#6B7280',
  chumbo: '#374151',
  grafite: '#374151',
  azul: '#1E3A8A',
  marinho: '#172554',
  verde: '#14532D',
  militar: '#3F4E2E',
  vermelho: '#DC2626',
  vermelha: '#DC2626',
  rosa: '#F472B6',
  roxo: '#6B21A8',
  bege: '#D6C5A7',
  caqui: '#A89F81',
  marrom: '#78350F',
  laranja: '#EA580C',
  amarelo: '#EAB308',
};

const FALLBACK_IMAGES_BY_CATEGORY: Record<ProductCategory, string[]> = {
  calcados: ['/src/assets/images/product_sneaker_chunky_1793275501375.jpg'],
  acessorios: ['/src/assets/images/product_cap_streetwear_1793275501370.jpg'],
  roupas: ['/src/assets/images/product_hoodie_oversized_1793275501387.jpg'],
};

function inferStoreCategoryAndSubcategory(
  rawCat: unknown,
  rawSubcat: unknown,
  productName: string
): { category: ProductCategory; subcategory: ProductSubcategory } {
  const catStr = String(rawCat || '').toLowerCase();
  const subStr = String(rawSubcat || '').toLowerCase();
  const text = `${catStr} ${subStr} ${productName.toLowerCase()}`;

  if (catStr === 'calcados' || /\b(tenis|tênis|sneaker|chinelo|calçado|calcado|dunk|jordan)\b/i.test(text)) {
    return { category: 'calcados', subcategory: 'sneakers' };
  }
  if (catStr === 'acessorios' || /\b(boné|bone|bucket|touca)\b/i.test(text)) {
    return { category: 'acessorios', subcategory: 'bones' };
  }
  if (/\b(bag|shoulder|mochila|pochete|mala)\b/i.test(text)) {
    return { category: 'acessorios', subcategory: 'bags' };
  }
  if (/\b(óculos|oculos|cinto|carteira|relógio|relogio|corrente|meia|cadarço|cadarco|acessório|acessorio)\b/i.test(text)) {
    return { category: 'acessorios', subcategory: 'acessorios-metal' };
  }
  if (subStr === 'hoodies' || /\b(moletom|hoodie|jaqueta|corta vento|casaco)\b/i.test(text)) {
    return { category: 'roupas', subcategory: 'hoodies' };
  }
  if (subStr === 'calcas' || /\b(calça|calca|cargo|jogger|jeans)\b/i.test(text)) {
    return { category: 'roupas', subcategory: 'calcas' };
  }
  if (subStr === 'shorts' || /\b(bermuda|short)\b/i.test(text)) {
    return { category: 'roupas', subcategory: 'shorts' };
  }

  return { category: 'roupas', subcategory: 'camisetas' };
}

function mapFirestoreDocToProduct(docId: string, data: Record<string, unknown>): Product {
  const name = String(data.nome || data.name || 'Peça Street Store').trim() || 'Peça Street Store';
  const { category, subcategory } = inferStoreCategoryAndSubcategory(
    data.categoriaStore ?? data.categoria ?? data.category,
    data.subcategoriaStore ?? data.subcategory,
    name
  );

  const rawPrice = Number(data.preco ?? data.price ?? 0);
  const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 99.9;
  const rawOriginal = Number(data.originalPrice ?? 0);
  const originalPrice = Number.isFinite(rawOriginal) && rawOriginal > price ? rawOriginal : Math.round(price * 1.25);

  const rawStock = Number(data.estoque ?? data.stockCount ?? 0);
  const stockCount = Number.isFinite(rawStock) ? Math.max(0, rawStock) : 0;

  const rawImages: string[] = [];
  if (Array.isArray(data.imagens)) {
    for (const img of data.imagens) {
      if (typeof img === 'string' && img.trim()) rawImages.push(img.trim());
    }
  }
  if (Array.isArray(data.images)) {
    for (const img of data.images) {
      if (typeof img === 'string' && img.trim() && !rawImages.includes(img.trim())) {
        rawImages.push(img.trim());
      }
    }
  }
  if (typeof data.imagemURL === 'string' && data.imagemURL.trim() && !rawImages.includes(data.imagemURL.trim())) {
    rawImages.unshift(data.imagemURL.trim());
  }

  const images =
    rawImages.length > 0
      ? rawImages
      : FALLBACK_IMAGES_BY_CATEGORY[category] || ['/src/assets/images/product_hoodie_oversized_1793275501387.jpg'];

  const rawSizes = Array.isArray(data.tamanhos)
    ? data.tamanhos
    : Array.isArray(data.sizes)
      ? data.sizes
      : [];
  const sizes = rawSizes
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const finalSizes = sizes.length > 0 ? sizes : ['Tamanho Único'];

  const rawColors = Array.isArray(data.cores)
    ? data.cores
    : Array.isArray(data.colors)
      ? data.colors
      : [];
  const colors = rawColors
    .map((c) => {
      if (c && typeof c === 'object' && 'name' in c) {
        const obj = c as { name?: string; hex?: string };
        const colorName = String(obj.name || 'Padrão').trim();
        return {
          name: colorName,
          hex: String(obj.hex || COLOR_HEX_MAP[colorName.toLowerCase()] || '#1C1C1C'),
        };
      }
      const colorName = String(c || '').trim();
      if (!colorName) return null;
      return {
        name: colorName,
        hex: COLOR_HEX_MAP[colorName.toLowerCase()] || '#1C1C1C',
      };
    })
    .filter((c): c is { name: string; hex: string } => Boolean(c));

  const finalColors = colors.length > 0 ? colors : [{ name: 'Padrão', hex: '#1C1C1C' }];

  const variacoesObj =
    data.variacoes && typeof data.variacoes === 'object' && !Array.isArray(data.variacoes)
      ? (data.variacoes as Record<string, Record<string, unknown>>)
      : null;

  const variantsList = variacoesObj
    ? Object.values(variacoesObj).map((v) => ({
        id: Number(v.blingId || 0) || 0,
        sku: String(v.codigo || ''),
        price: Number(v.preco || price) || price,
        stock: Math.max(0, Number(v.estoque ?? 0) || 0),
        size: String(v.tamanho || 'Tamanho Único'),
      }))
    : undefined;

  const cleanedDesc =
    cleanDescription(String(data.descricao || data.description || '')) ||
    `${name} — Drop oficial Street Store com acabamento reforçado e envio rápido.`;

  const numericIdSeed = parseInt(String(data.blingId || docId).replace(/\D/g, ''), 10) || 7;
  const sku = String(data.codigo || `BLING-${docId}`).trim() || `BLING-${docId}`;

  return {
    id: docId,
    name,
    category,
    subcategory,
    price,
    originalPrice,
    tag: stockCount > 0 && stockCount <= 3 ? 'POUCAS UNIDADES' : 'NOVO DROP',
    rating: Number((4.8 + (numericIdSeed % 3) / 10).toFixed(1)),
    reviewsCount: 14 + (numericIdSeed % 35),
    images,
    sizes: finalSizes,
    colors: finalColors,
    description: cleanedDesc,
    stockCount,
    details: {
      composition:
        category === 'calcados'
          ? 'Solado em borracha vulcanizada de alta durabilidade'
          : category === 'acessorios'
            ? 'Material premium de alta durabilidade'
            : '100% Algodão Premium Heavyweight',
      weight:
        category === 'calcados'
          ? '900g o par'
          : category === 'acessorios'
            ? '120g'
            : '380g/m² Heavyweight',
      modelInfo:
        category === 'acessorios'
          ? 'Tamanho e formato ergonômico'
          : 'Modelagem autêntica Street Store',
      origin: 'Itabira - MG // Street Store Oficial',
    },
    integration: {
      sku,
      barcode: sku,
      blingId: String(data.blingId || docId),
      weightGrams: 450,
      dimensionsCm: { width: 28, height: 12, depth: 32 },
    },
    variantsList,
  };
}

export function CatalogSection({
  products,
  activeCategory,
  activeSubcategory,
  brandFilter,
  onClearBrandFilter,
  favorites,
  onToggleFavorite,
  onSelectCategory,
  onOpenProduct,
  onQuickAdd
}: CatalogSectionProps) {
  const [sortBy, setSortBy] = useState<'relevance' | 'price-asc' | 'price-desc' | 'rating'>('relevance');
  const [visibleCount, setVisibleCount] = useState(12);
  const [firestoreProducts, setFirestoreProducts] = useState<Product[]>([]);
  const [isLoadingFirestore, setIsLoadingFirestore] = useState(true);

  // Real-time listener on Firestore `products` collection with safe fallback
  useEffect(() => {
    const productsRef = collection(db, 'products');
    const unsubscribe = onSnapshot(
      productsRef,
      (snapshot) => {
        const mapped: Product[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          if (data?.ativo === false) return;
          mapped.push(mapFirestoreDocToProduct(docSnap.id, data));
        });
        setFirestoreProducts(filterVisibleProducts<Product>(mapped));
        setIsLoadingFirestore(false);
      },
      (error) => {
        setIsLoadingFirestore(false);
        try {
          handleFirestoreError(error, OperationType.LIST, 'products');
        } catch (structuredErr) {
          console.warn('[CatalogSection Firestore Listener]:', structuredErr);
        }
      }
    );

    return () => unsubscribe();
  }, []);

  // Prefer live Firestore products when synced; gracefully fall back to prop products
  const catalogSourceProducts = firestoreProducts.length > 0 ? firestoreProducts : products;

  // Reset pagination whenever user changes category, subcategory, brand, or sort
  useEffect(() => {
    setVisibleCount(12);
  }, [activeCategory, activeSubcategory, brandFilter, sortBy]);

  const categories = [
    { id: 'all', label: 'TODOS OS DROPS', cat: 'all' as const, subcat: undefined },
    { id: 'roupas', label: 'ROUPAS', cat: 'roupas' as const, subcat: undefined },
    { id: 'moletons', label: 'MOLETOMS', cat: 'roupas' as const, subcat: 'hoodies' },
    { id: 'calcados', label: 'CALÇADOS & SNEAKERS', cat: 'calcados' as const, subcat: undefined },
    { id: 'acessorios', label: 'ACESSÓRIOS', cat: 'acessorios' as const, subcat: undefined },
  ];

  const filteredProducts = useMemo(() => {
    let list = catalogSourceProducts.filter(p => (p.stockCount ?? 0) > 0);

    // Filter by brand name if active
    if (brandFilter) {
      const q = brandFilter.toLowerCase().trim();
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.integration?.sku || '').toLowerCase().includes(q)
      );
    }

    // Filter by main category & subcategory
    if (activeCategory !== 'all') {
      list = list.filter(p => p.category === activeCategory);
    }

    if (activeSubcategory && activeSubcategory !== 'all') {
      if (activeSubcategory === 'hoodies') {
        list = list.filter(p =>
          p.subcategory === 'hoodies' ||
          (p.name || '').toLowerCase().includes('moletom') ||
          (p.name || '').toLowerCase().includes('hoodie') ||
          (p.name || '').toLowerCase().includes('corta vento') ||
          (p.name || '').toLowerCase().includes('jaqueta')
        );
      } else {
        list = list.filter(p => p.subcategory === activeSubcategory);
      }
    }

    // Sort by selected option
    if (sortBy === 'price-asc') {
      list.sort((a, b) => a.price - b.price);
    } else if (sortBy === 'price-desc') {
      list.sort((a, b) => b.price - a.price);
    } else if (sortBy === 'rating') {
      list.sort((a, b) => b.rating - a.rating);
    }

    return list;
  }, [catalogSourceProducts, brandFilter, activeCategory, activeSubcategory, sortBy]);

  // Paginated drop display (8 to 12 items initially, expanding by 12 per click)
  const displayedProducts = useMemo(() => {
    return filteredProducts.slice(0, visibleCount);
  }, [filteredProducts, visibleCount]);

  return (
    <section id="catalogo" className="py-10 sm:py-16 bg-[#0A0A0A] border-b border-[#1A1A1A] overflow-hidden">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">

        {/* Clean Controls Bar with Scroll Reveal */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 sm:gap-4 pb-4 sm:pb-6 border-b border-[#1E1E1E]"
        >
          {/* Main Category Tabs with MOLETOMS alongside ROUPAS */}
          <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar pb-1 max-w-full">
            {categories.map((cat) => {
              const isActive = cat.id === 'all'
                ? activeCategory === 'all' && !activeSubcategory
                : cat.id === 'moletons'
                ? activeCategory === 'roupas' && activeSubcategory === 'hoodies'
                : cat.id === 'roupas'
                ? activeCategory === 'roupas' && activeSubcategory !== 'hoodies'
                : activeCategory === cat.id;

              return (
                <button
                  key={cat.id}
                  onClick={() => onSelectCategory(cat.cat, cat.subcat)}
                  className={`px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-black uppercase tracking-wider rounded-lg transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-[#E50914] text-white shadow-md shadow-red-950/60'
                      : 'bg-[#141414] hover:bg-[#1E1E1E] text-zinc-400 hover:text-white border border-zinc-800'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}

            <a
              href="#arara-virtual"
              className="px-3 sm:px-4 py-1.5 sm:py-2 text-[11px] sm:text-xs font-black uppercase tracking-wider rounded-lg transition-all duration-150 whitespace-nowrap shrink-0 cursor-pointer bg-gradient-to-r from-red-950 via-zinc-900 to-red-950 text-red-400 border border-red-700/60 hover:text-white flex items-center gap-1.5 shadow-sm"
            >
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              Novidades na Street
            </a>
          </div>

          {/* Sort Selector */}
          <div className="flex items-center gap-3 self-end sm:self-auto shrink-0 flex-wrap">
            <div className="flex items-center gap-2 bg-[#141414] border border-zinc-800 rounded-lg px-2.5 sm:px-3 py-1.5 sm:py-2 text-xs">
              <ArrowUpDown className="w-3.5 h-3.5 text-zinc-400" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'relevance' | 'price-asc' | 'price-desc' | 'rating')}
                className="bg-transparent text-zinc-200 focus:outline-none cursor-pointer font-semibold text-xs pr-1"
                aria-label="Ordenar produtos"
              >
                <option value="relevance" className="bg-zinc-900 text-white">Mais Populares</option>
                <option value="price-asc" className="bg-zinc-900 text-white">Menor Preço</option>
                <option value="price-desc" className="bg-zinc-900 text-white">Maior Preço</option>
                <option value="rating" className="bg-zinc-900 text-white">Melhor Avaliados</option>
              </select>
            </div>
          </div>
        </motion.div>

        {/* Brand Filter Banner */}
        {brandFilter && (
          <div className="flex items-center justify-between bg-red-950/40 border border-red-800/60 rounded-xl px-3 sm:px-4 py-2 mt-4 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[#E50914] font-black uppercase font-oswald tracking-wider">MARCA SELECIONADA:</span>
              <span className="text-white font-black uppercase bg-black/60 px-2.5 py-0.5 rounded border border-zinc-800">{brandFilter}</span>
              <span className="text-zinc-400 font-mono text-[11px]">({filteredProducts.length} peças disponíveis)</span>
            </div>
            {onClearBrandFilter && (
              <button
                onClick={onClearBrandFilter}
                className="text-xs text-red-400 hover:text-white underline cursor-pointer font-bold shrink-0 ml-3"
              >
                Ver Todas as Marcas
              </button>
            )}
          </div>
        )}

        {/* Product Grid: 2-column mobile and 3/4 desktop */}
        <div className="pt-6 sm:pt-8">
          {isLoadingFirestore && catalogSourceProducts.length === 0 ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
              {Array.from({ length: 8 }).map((_, idx) => (
                <div
                  key={idx}
                  className="bg-[#121212] border border-[#222222] rounded-xl h-80 animate-pulse"
                />
              ))}
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="py-16 text-center space-y-3 bg-[#111111] rounded-xl border border-dashed border-zinc-800 p-8">
              <p className="text-base font-bold text-white">Nenhum produto nesta categoria no momento.</p>
              <button
                onClick={() => onSelectCategory('all')}
                className="px-5 py-2 bg-[#E50914] text-white text-xs font-bold rounded-lg uppercase tracking-wider cursor-pointer"
              >
                Ver Todos os Drops
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6">
                {displayedProducts.map((product, idx) => (
                  <motion.div
                    key={product.id}
                    initial={{ opacity: 0, y: 25 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, margin: '-40px' }}
                    transition={{
                      duration: 0.45,
                      delay: (idx % 4) * 0.06,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  >
                    <ProductCard
                      product={product}
                      isFavorited={favorites.includes(product.id)}
                      onToggleFavorite={onToggleFavorite}
                      onOpenDetails={onOpenProduct}
                      onQuickAdd={onQuickAdd}
                    />
                  </motion.div>
                ))}
              </div>

              {/* Streetwear "CARREGAR MAIS DROPS ↓" Button */}
              {visibleCount < filteredProducts.length && (
                <div className="mt-10 sm:mt-12 flex flex-col items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + 12)}
                    className="group relative inline-flex items-center justify-center gap-2 sm:gap-3 px-6 sm:px-10 py-3.5 sm:py-4 bg-zinc-950 hover:bg-[#E50914] text-white font-black text-xs sm:text-base tracking-widest uppercase rounded-xl border-2 border-zinc-700 hover:border-[#E50914] shadow-2xl hover:shadow-[0_0_35px_rgba(229,9,20,0.5)] transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 active:scale-95 cursor-pointer max-w-full"
                  >
                    <span>CARREGAR MAIS DROPS</span>
                    <span className="inline-block transform group-hover:translate-y-1 transition-transform duration-200 text-base sm:text-lg font-black text-[#E50914] group-hover:text-white">
                      ↓
                    </span>
                  </button>

                  <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono tracking-wider">
                    <span>MOSTRANDO</span>
                    <span className="font-bold text-zinc-300 font-mono">{displayedProducts.length}</span>
                    <span>DE</span>
                    <span className="font-bold text-zinc-300 font-mono">{filteredProducts.length}</span>
                    <span>DROPS</span>
                  </div>
                </div>
              )}

              {/* All drops loaded indicator */}
              {visibleCount >= filteredProducts.length && filteredProducts.length > 12 && (
                <div className="mt-12 flex items-center justify-center">
                  <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-950/80 border border-zinc-800 text-[11px] font-mono font-bold text-zinc-400 tracking-wider">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#E50914]"></span>
                    <span>TODOS OS {filteredProducts.length} DROPS DISPONÍVEIS CARREGADOS</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </section>
  );
}
