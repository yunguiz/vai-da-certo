import React, { useState, useMemo } from 'react';
import { ClothingRailHero, RailGarment } from '@/components/ui/product-rail-gallery';
import { Product } from '../types';
import { ShoppingBag, Sparkles, Eye, ArrowRight, RotateCw, CheckCircle2 } from 'lucide-react';

interface StreetwearRailSectionProps {
  products: Product[];
  onOpenProduct: (product: Product) => void;
  onQuickAdd: (product: Product) => void;
  onExploreCatalog: () => void;
}

export const StreetwearRailSection: React.FC<StreetwearRailSectionProps> = ({
  products,
  onOpenProduct,
  onQuickAdd,
  onExploreCatalog
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'tees' | 'hoodies' | 'sneakers'>('all');
  const [addedNotice, setAddedNotice] = useState<string | null>(null);

  // Curated Street Store garments for the interactive rail
  const railItems: (RailGarment & { catalogId?: string; originalProduct?: Product; priceFormatted?: string })[] = useMemo(() => {
    const chronicTee = products.find(p => p.name.toLowerCase().includes('chronic') || p.name.toLowerCase().includes('camiseta'));
    const tripSideTee = products.find(p => p.name.toLowerCase().includes('trip side') || p.name.toLowerCase().includes('multimarcas'));

    const items: (RailGarment & { catalogId?: string; originalProduct?: Product; priceFormatted?: string })[] = [
      {
        id: "tripside-1977-novidade",
        name: "Camiseta Trip Side 1977 Raglan · Autêntico Até o Osso",
        kind: "tee",
        color: "#0F0F11",
        trim: "#DC2626",
        tag: "NOVIDADE R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Drop Novo Exclusivo da Trip Side. Modelagem oversized com recortes raglan vermelhos, estampa silk 1977 em alta definição e selo Parental Advisory.",
        details: ["Algodão Penteado 260gsm Heavy", "Recortes Raglan Vermelhos", "Estampa Silk 1977 HD", "Autêntico Até o Osso", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/C_pia_de_NOVIDADE__3__f437c7b1.png",
        backImage: "/assets/aistudio/C_pia_de_NOVIDADE__1__b4d9c4a8.png",
        originalProduct: tripSideTee
      },
      {
        id: "tripside-duotone-77",
        name: "Camiseta Trip Side Duo Wave 77 · Off-White & Black",
        kind: "tee",
        color: "#F4F4F0",
        trim: "#18181B",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear premium bicolor off-white com recortes anatômicos em preto na lateral. Bordado frontal central e arte graffiti '77' nas costas.",
        details: ["100% Algodão Premium Heavyweight", "Recortes Curvos Laterais em Contraste", "Bordado Tipográfico Frontal", "Estampa Graffiti '77' Costas", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__4__bfe5aaed.png",
        backImage: "/assets/aistudio/Design_sem_nome__3__5e605338.png",
        originalProduct: chronicTee
      },
      {
        id: "tripside-wildstyle-black",
        name: "Camiseta Trip Side Wildstyle · Deep Black Drop",
        kind: "tee",
        color: "#121214",
        trim: "#27272A",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear heavyweight preta. Tipografia Trip Side com auréola frontal centralizada e arte graffiti wildstyle 3D vertical monocromática nas costas.",
        details: ["100% Algodão Heavyweight 260gsm", "Tipografia Trip Side Bordada/Silk Frontal", "Graffiti Wildstyle 3D Vertical Costas", "Gola Canelada Gorda 3cm", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__5__ef8bca41.png",
        backImage: "/assets/aistudio/Design_sem_nome__6__d3642ec7.png"
      },
      {
        id: "tripside-wildstyle-olive",
        name: "Camiseta Trip Side Wildstyle · Olive Green Drop",
        kind: "tee",
        color: "#3F4734",
        trim: "#2B3224",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear heavyweight verde oliva militar. Tipografia Trip Side com auréola frontal e arte graffiti wildstyle 3D vertical nas costas.",
        details: ["100% Algodão Heavyweight 260gsm", "Cor Verde Militar / Oliva Urbano", "Tipografia Trip Side Frontal Central", "Graffiti Wildstyle 3D Costas", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__8__f44ad096.png",
        backImage: "/assets/aistudio/Design_sem_nome__7__e6ab934f.png"
      },
      {
        id: "tripside-tribal-black",
        name: "Camiseta Trip Side Tribal White · Autêntico Até o Osso",
        kind: "tee",
        color: "#0F0F12",
        trim: "#E4E4E7",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta preta heavyweight streetwear com grafismo tribal flame lateral branco em alto contraste, monograma 'T' gótico central e inscrição 'Autêntico até o osso est.1977'.",
        details: ["100% Algodão Heavyweight 260gsm", "Tribais Laterais em Contraste Branco", "Monograma Gótico 'T' e Inscrição Frontal", "Gola Canelada Gorda 3cm", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__9__73306863.png",
        backImage: "/assets/aistudio/Design_sem_nome__9__73306863.png"
      },
      {
        id: "tripside-duowave-purple",
        name: "Camiseta Trip Side Duo Wave · Black & Cyber Purple",
        kind: "tee",
        color: "#111116",
        trim: "#6B21A8",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear heavyweight preta com recortes curvos laterais em roxo cyber/violeta, tag oval emborrachada no peito e caimento oversized autêntico.",
        details: ["100% Algodão Heavyweight 260gsm", "Recortes Laterais Anatômicos em Roxo Violeta", "Patch Oval Emborrachado Frontal", "Gola Canelada Gorda 3cm", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__10__4bbf1037.png",
        backImage: "/assets/aistudio/Design_sem_nome__10__4bbf1037.png"
      },
      {
        id: "tripside-duowave-purple-main",
        name: "Camiseta Trip Side Duo Wave · Cyber Purple & Black",
        kind: "tee",
        color: "#4C1D95",
        trim: "#18181B",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear heavyweight roxa cyber com recortes anatômicos em preto na lateral, gola canelada grossa e tag oval emborrachada no centro do peito.",
        details: ["100% Algodão Heavyweight 260gsm", "Cor Roxo Violeta / Cyber Purple", "Recortes Laterais Curvos Pretos", "Patch Oval Central Emborrachado", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__11__0eda0283.png",
        backImage: "/assets/aistudio/Design_sem_nome__11__0eda0283.png"
      },
      {
        id: "tripside-duowave-dark-violet",
        name: "Camiseta Trip Side Duo Wave · Dark Purple Drop",
        kind: "tee",
        color: "#14101E",
        trim: "#7C3AED",
        tag: "NOVO DROP R$ 139,90",
        priceFormatted: "R$ 139,90",
        description: "Camiseta streetwear heavyweight preta com recortes anatômicos em tom roxo violeta profundo, tag oval emborrachada central e caimento oversized street.",
        details: ["100% Algodão Heavyweight 260gsm", "Painéis Laterais Anatômicos Violeta", "Patch Oval Emborrachado no Peito", "Gola Canelada Gorda 3cm", "Modelagem Oversized Streetwear"],
        image: "/assets/aistudio/Design_sem_nome__10__4bbf1037.png",
        backImage: "/assets/aistudio/Design_sem_nome__10__4bbf1037.png"
      }
    ];

    // Guarantee that ONLY items with real product images are displayed on the rail (no SVG garment fallbacks)
    return items.filter(i => Boolean(i.image));
  }, [products]);

  // Filter items by tab
  const filteredItems = useMemo(() => {
    if (activeTab === 'tees') return railItems.filter(i => i.kind === 'tee');
    if (activeTab === 'hoodies') return railItems.filter(i => i.kind === 'hoodie' || i.kind === 'jacket');
    if (activeTab === 'sneakers') return railItems.filter(i => i.id.includes('tesla'));
    return railItems;
  }, [railItems, activeTab]);

  const handleAction = (item: typeof railItems[0]) => {
    if (item.originalProduct) {
      onOpenProduct(item.originalProduct);
    } else {
      // Find matching or closest catalog product or open catalog search
      const fallback = products.find(p => p.name.toLowerCase().includes(item.name.toLowerCase().split(' ')[1])) || products[0];
      if (fallback) {
        onOpenProduct(fallback);
      } else {
        onExploreCatalog();
      }
    }
  };

  const handleQuickBuy = (item: typeof railItems[0]) => {
    if (item.originalProduct) {
      onQuickAdd(item.originalProduct);
    } else if (products.length > 0) {
      onQuickAdd(products[0]);
    }
    setAddedNotice(`${item.name} adicionado ao carrinho!`);
    setTimeout(() => setAddedNotice(null), 3500);
  };

  return (
    <section className="relative w-full border-t border-b border-zinc-800/80 bg-zinc-950 py-16 overflow-hidden">
      {/* Background ambient glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[350px] bg-red-600/10 rounded-full blur-[140px]" />
        <div className="absolute bottom-10 right-10 w-96 h-96 bg-amber-500/5 rounded-full blur-[120px]" />
      </div>

      {/* Street Store Title Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-950/70 border border-red-600/40 text-red-400 text-[11px] font-bold tracking-widest uppercase mb-3">
          <Sparkles className="w-3.5 h-3.5 animate-pulse text-red-400" />
          <span>Experiência Interativa 3D · Street Store Itabira</span>
        </div>

        <h2 className="text-3xl sm:text-4xl md:text-5xl font-black uppercase tracking-tight text-white font-bebas">
          NOVIDADES <span className="text-red-500">NA STREET</span>
        </h2>

        <p className="max-w-2xl mx-auto mt-2 text-sm text-zinc-400 leading-relaxed">
          Passe o mouse ou deslize o dedo para afastar os cabides na arara. Clique em qualquer peça para abrir a visualização 360°, ver a modelagem e a estampa das costas.
        </p>

        {/* Interactive Tabs */}
        <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'all'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30 ring-2 ring-red-500'
                : 'bg-zinc-900/90 text-zinc-400 hover:text-white border border-zinc-800'
            }`}
          >
            🔥 Todos os Drops ({railItems.length})
          </button>
          <button
            onClick={() => setActiveTab('tees')}
            className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === 'tees'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30 ring-2 ring-red-500'
                : 'bg-zinc-900/90 text-zinc-400 hover:text-white border border-zinc-800'
            }`}
          >
            👕 Camisetas & Oversized
          </button>
          {railItems.some(i => i.kind === 'hoodie' || i.kind === 'jacket') && (
            <button
              onClick={() => setActiveTab('hoodies')}
              className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeTab === 'hoodies'
                  ? 'bg-red-600 text-white shadow-lg shadow-red-600/30 ring-2 ring-red-500'
                  : 'bg-zinc-900/90 text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              🧥 Moletons & Jaquetas
            </button>
          )}
          {railItems.some(i => i.id.includes('tesla')) && (
            <button
              onClick={() => setActiveTab('sneakers')}
              className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeTab === 'sneakers'
                  ? 'bg-red-600 text-white shadow-lg shadow-red-600/30 ring-2 ring-red-500'
                  : 'bg-zinc-900/90 text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              👟 Sneakers Tesla
            </button>
          )}
        </div>
      </div>

      {/* Added to cart toast notice */}
      {addedNotice && (
        <div className="fixed bottom-6 right-6 z-50 bg-emerald-950 border border-emerald-500/50 text-emerald-100 px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-5">
          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          <span className="text-xs font-bold">{addedNotice}</span>
        </div>
      )}

      {/* The Clothing Rail Hero Component with Street Store identity */}
      <div className="w-full relative">
        <ClothingRailHero
          items={filteredItems}
          hanger="wood"
          autoplay={false}
          labels={{
            front: "Frente",
            back: "Costas",
            close: "Fechar ✕",
            show: "Ver Peça"
          }}
          caption="Toque ou arraste qualquer cabide para escolher sua peça"
          action={
            <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
              <button
                type="button"
                onClick={onExploreCatalog}
                className="inline-flex items-center gap-2 rounded-full bg-red-600 px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-red-600/30 transition-all hover:bg-red-500 hover:scale-105 active:scale-95 cursor-pointer"
              >
                <ShoppingBag className="w-4 h-4" />
                Explorar Catálogo Completo
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          }
        />
      </div>

      {/* Bottom Hint Banner */}
      <div className="max-w-4xl mx-auto px-4 mt-8">
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-400">
          <div className="flex items-center gap-2">
            <RotateCw className="w-4 h-4 text-red-500 animate-spin [animation-duration:8s]" />
            <span>
              <strong>Dica de Interação:</strong> Arraste o mouse horizontalmente para simular o deslize físico dos cabides na loja física de Itabira.
            </span>
          </div>
          <button
            onClick={onExploreCatalog}
            className="text-red-400 hover:text-red-300 font-bold underline cursor-pointer"
          >
            Ver mais de 300 produtos no catálogo &rarr;
          </button>
        </div>
      </div>
    </section>
  );
};

export default StreetwearRailSection;
