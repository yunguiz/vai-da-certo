import { useState, useEffect, useRef } from 'react';
import { 
  ShieldCheck, 
  ChevronLeft, 
  ChevronRight, 
  Sparkles, 
  ArrowRight, 
  Award, 
  CheckCircle2, 
  Layers, 
  ExternalLink,
  Flame
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { OFFICIAL_BRANDS, OfficialBrand } from '../data/brands';

interface OfficialPartnersSectionProps {
  onSelectBrandSearch?: (query: string) => void;
}

export function OfficialPartnersSection({ onSelectBrandSearch }: OfficialPartnersSectionProps) {
  const [activeCategory, setActiveCategory] = useState<'all' | 'tenis' | 'roupas'>('all');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<any>(null);

  const [isLogoHovered, setIsLogoHovered] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);

  const filteredBrands = activeCategory === 'all' 
    ? OFFICIAL_BRANDS 
    : OFFICIAL_BRANDS.filter((b) => b.category === activeCategory);

  // Keep index within bounds when switching category
  useEffect(() => {
    setCurrentIndex(0);
  }, [activeCategory]);

  // Autoplay slider every 4.5 seconds
  useEffect(() => {
    if (isPaused || filteredBrands.length <= 1) return;

    timerRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % filteredBrands.length);
    }, 4500);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPaused, filteredBrands.length]);

  const handleNext = () => {
    setCurrentIndex((prev) => (prev + 1) % filteredBrands.length);
  };

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev - 1 + filteredBrands.length) % filteredBrands.length);
  };

  const handleBrandClick = (query: string) => {
    if (onSelectBrandSearch) {
      onSelectBrandSearch(query);
    } else {
      const el = document.getElementById('catalogo');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Hardware-accelerated 3D tilt without triggering React re-renders on mousemove
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const rotX = -((y - centerY) / centerY) * 8.5;
    const rotY = ((x - centerX) / centerX) * 8.5;
    const glareX = (x / rect.width) * 100;
    const glareY = (y / rect.height) * 100;

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (cardRef.current) {
        cardRef.current.style.transform = `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.015, 1.015, 1)`;
      }
      if (glareRef.current) {
        glareRef.current.style.opacity = '1';
        glareRef.current.style.background = `radial-gradient(circle 380px at ${glareX.toFixed(1)}% ${glareY.toFixed(1)}%, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.02) 40%, transparent 70%)`;
      }
    });
  };

  const handleMouseEnter = () => {
    setIsPaused(true);
    if (cardRef.current) {
      cardRef.current.style.transition = 'transform 0.12s cubic-bezier(0.2, 0, 0, 1)';
    }
  };

  const handleMouseLeave = () => {
    setIsPaused(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (cardRef.current) {
      cardRef.current.style.transition = 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)';
      cardRef.current.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
    }
    if (glareRef.current) {
      glareRef.current.style.opacity = '0';
    }
  };

  const currentBrand = filteredBrands[currentIndex] || filteredBrands[0];

  return (
    <section id="parceiros" className="py-12 sm:py-20 bg-[#0B0B0B] border-b border-[#1E1E1E] relative overflow-hidden">
      
      {/* Background Ambient Glow that shifts color with active brand */}
      <div 
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full blur-[150px] pointer-events-none opacity-25 transition-all duration-700"
        style={{ backgroundColor: currentBrand?.accentColor || '#E50914' }}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto mb-8 sm:mb-10 space-y-3"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 sm:px-3.5 sm:py-1.5 rounded-full bg-red-950/50 border border-red-800/60 text-[10px] sm:text-xs font-black uppercase tracking-widest text-[#E50914] font-oswald shadow-md">
            <ShieldCheck className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            <span>REVENDEDOR AUTORIZADO // 100% PRODUTOS ORIGINAIS</span>
          </div>

          <h2 className="text-2xl sm:text-4xl md:text-5xl font-black text-white uppercase font-display tracking-tight">
            PARCEIROS OFICIAIS
          </h2>

          <p className="text-xs sm:text-sm text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            Trabalhamos exclusivamente com marcas consagradas do streetwear e skatewear brasileiro. 
            Todas as peças e tênis possuem garantia de procedência, nota fiscal e autenticidade comprovada.
          </p>

          {/* Category Tabs: Todas / Tênis / Roupas */}
          <div className="pt-3 flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeCategory === 'all'
                  ? 'bg-white text-black shadow-lg font-black'
                  : 'bg-[#161616] text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              Todas as Marcas ({OFFICIAL_BRANDS.length})
            </button>

            <button
              onClick={() => setActiveCategory('tenis')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeCategory === 'tenis'
                  ? 'bg-[#E50914] text-white shadow-lg shadow-red-950/60 font-black'
                  : 'bg-[#161616] text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              <span>👟 Tênis & Calçados</span>
              <span className="text-[10px] opacity-80">(HOCKS, Tesla, Qix, Havaianas)</span>
            </button>

            <button
              onClick={() => setActiveCategory('roupas')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer ${
                activeCategory === 'roupas'
                  ? 'bg-[#E50914] text-white shadow-lg shadow-red-950/60 font-black'
                  : 'bg-[#161616] text-zinc-400 hover:text-white border border-zinc-800'
              }`}
            >
              <span>👕 Roupas & Streetwear</span>
              <span className="text-[10px] opacity-80">(Chronic, Tripside, Fire, Anth Co...)</span>
            </button>
          </div>
        </motion.div>

        {/* FEATURED BRAND 3D INTERACTIVE CARD SLIDER */}
        <div 
          className="relative max-w-4xl mx-auto [perspective:1000px]"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {/* Main 3D Card with Tilt Physics, Specular Glare & Depth Layers */}
          <div 
            ref={cardRef}
            onMouseMove={handleMouseMove}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className="relative rounded-3xl bg-gradient-to-br from-[#181818] via-[#121212] to-[#0A0A0A] border p-6 sm:p-10 shadow-2xl min-h-[420px] flex flex-col justify-between transition-all"
            style={{
              boxShadow: `0 25px 60px -15px ${currentBrand.accentColor}30, 0 0 40px -10px ${currentBrand.accentColor}20, inset 0 1px 0 rgba(255,255,255,0.1)`,
              borderColor: `${currentBrand.accentColor}40`,
              transformStyle: 'preserve-3d'
            }}
          >
            {/* Specular Spotlight / Glare Layer that follows pointer */}
            <div 
              ref={glareRef}
              className="pointer-events-none absolute inset-0 z-10 rounded-3xl opacity-0 transition-opacity duration-300"
            />

            {/* Subtle Grid / Texture Layer in background */}
            <div className="pointer-events-none absolute inset-0 -z-10 opacity-15 rounded-3xl overflow-hidden bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:16px_16px]" />
            
            <AnimatePresence mode="wait">
              <motion.div
                key={currentBrand.id}
                initial={{ opacity: 0, x: 25 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -25 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-6 [transform-style:preserve-3d]"
              >
                {/* Top Badges (elevated in 3D space) */}
                <div 
                  className="flex items-center justify-between flex-wrap gap-3 transition-transform duration-300"
                  style={{ transform: 'translateZ(25px)' }}
                >
                  <div className="flex items-center gap-2">
                    <span 
                      className="px-3.5 py-1.5 rounded-full text-[11px] font-black uppercase tracking-wider border shadow-sm transition-all duration-300 hover:scale-105 cursor-default"
                      style={{ 
                        color: currentBrand.accentColor,
                        borderColor: `${currentBrand.accentColor}60`,
                        backgroundColor: `${currentBrand.accentColor}18`,
                        boxShadow: `0 0 12px ${currentBrand.accentColor}25`
                      }}
                    >
                      {currentBrand.categoryLabel}
                    </span>
                    <span className="text-zinc-600 font-bold">•</span>
                    <span className="text-xs text-zinc-400 font-mono font-bold tracking-wider">
                      {currentBrand.established || 'Parceria Oficial'}
                    </span>
                  </div>

                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/50 text-emerald-300 text-xs font-bold shadow-md shadow-emerald-950/50">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                    <span>Revendedor Oficial</span>
                  </div>
                </div>

                {/* Brand Showcase Area with 3D Depth */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center [transform-style:preserve-3d]">
                  
                  {/* Left: Giant Brand Typography Visual Box (High 3D Elevation) */}
                  <div 
                    className="md:col-span-5 flex flex-col items-center justify-center p-6 sm:p-8 rounded-2xl bg-black/75 border border-zinc-800 text-center relative group/box transition-all duration-300 hover:border-zinc-600 [transform-style:preserve-3d]"
                    style={{
                      transform: 'translateZ(50px)',
                      boxShadow: `0 15px 35px -10px ${currentBrand.accentColor}30`
                    }}
                    onMouseEnter={() => setIsLogoHovered(true)}
                    onMouseLeave={() => setIsLogoHovered(false)}
                  >
                    {/* Ambient Neon Breathing Aura behind the logo */}
                    <motion.div 
                      animate={{ 
                        scale: isLogoHovered ? [1.1, 1.2, 1.1] : [1, 1.1, 1],
                        opacity: isLogoHovered ? [0.55, 0.85, 0.55] : [0.3, 0.5, 0.3]
                      }}
                      transition={{ 
                        duration: isLogoHovered ? 1.8 : 3.5, 
                        repeat: Infinity, 
                        ease: "easeInOut" 
                      }}
                      className="absolute inset-0 rounded-2xl pointer-events-none -z-10 blur-2xl"
                      style={{ backgroundColor: `${currentBrand.accentColor}25` }}
                    />

                    {/* Giant Brand Typography with Kinetic Floating + Hover Glow Expansion */}
                    <motion.div
                      animate={{
                        y: [0, -3, 0]
                      }}
                      transition={{
                        duration: 3.5,
                        repeat: Infinity,
                        ease: "easeInOut"
                      }}
                      className="relative cursor-pointer select-none [transform-style:preserve-3d]"
                      style={{
                        transform: isLogoHovered ? 'translateZ(40px) scale(1.08)' : 'translateZ(25px)',
                        transition: 'transform 0.3s cubic-bezier(0.2, 0, 0, 1)'
                      }}
                    >
                      <span 
                        className="text-4xl sm:text-6xl font-black font-bebas tracking-wider uppercase text-white inline-block transition-all duration-300 hover:tracking-[0.2em]"
                        style={{ 
                          textShadow: isLogoHovered
                            ? `0 0 35px ${currentBrand.accentColor}, 0 0 70px ${currentBrand.accentColor}80, 0 4px 12px rgba(0,0,0,0.9)`
                            : `0 0 25px ${currentBrand.accentColor}55, 0 2px 8px rgba(0,0,0,0.8)`
                        }}
                      >
                        {currentBrand.logoText}
                      </span>
                    </motion.div>
                    
                    <span 
                      className="inline-block mt-3 px-3 py-1 rounded text-[10px] font-bold uppercase tracking-widest font-mono transition-all duration-300 hover:scale-105"
                      style={{ 
                        backgroundColor: `${currentBrand.accentColor}25`,
                        color: currentBrand.accentColor,
                        border: `1px solid ${currentBrand.accentColor}40`,
                        boxShadow: `0 0 10px ${currentBrand.accentColor}20`,
                        transform: 'translateZ(20px)'
                      }}
                    >
                      {currentBrand.badge}
                    </span>

                    <div 
                      className="text-[10px] text-zinc-400 uppercase tracking-widest mt-3.5 flex items-center gap-1.5 font-semibold transition-colors duration-300 group-hover/box:text-zinc-200"
                      style={{ transform: 'translateZ(15px)' }}
                    >
                      <Award className="w-3.5 h-3.5 text-yellow-400 animate-bounce [animation-duration:3s]" />
                      <span>Originalidade Certificada</span>
                    </div>
                  </div>

                  {/* Right: Brand Story & Impact (Elevated in 3D) */}
                  <div 
                    className="md:col-span-7 space-y-3.5 [transform-style:preserve-3d]"
                    style={{ transform: 'translateZ(35px)' }}
                  >
                    {/* Brand Title with Interactive Hover Shine & Expander Bar */}
                    <div className="group/brandtitle cursor-default relative inline-block">
                      <h3 className="text-2xl sm:text-3xl md:text-4xl font-black text-white uppercase font-display tracking-wide transition-all duration-300 group-hover/brandtitle:tracking-wider group-hover/brandtitle:text-transparent group-hover/brandtitle:bg-clip-text group-hover/brandtitle:bg-gradient-to-r group-hover/brandtitle:from-white group-hover/brandtitle:via-zinc-100 group-hover/brandtitle:to-zinc-300">
                        {currentBrand.name}
                      </h3>
                      <span 
                        className="block h-1 w-12 group-hover/brandtitle:w-full transition-all duration-500 rounded-full mt-1.5 shadow-md"
                        style={{ 
                          backgroundColor: currentBrand.accentColor,
                          boxShadow: `0 0 10px ${currentBrand.accentColor}`
                        }}
                      />
                    </div>

                    {/* Brand Tagline with Interactive Quotation & Hover Glow */}
                    <p 
                      className="text-sm sm:text-base font-bold text-zinc-200 transition-all duration-300 hover:text-white hover:translate-x-1 cursor-default flex items-center gap-1.5"
                      style={{ textShadow: `0 0 15px ${currentBrand.accentColor}25` }}
                    >
                      <span className="text-red-500 font-mono text-base font-black">“</span>
                      <span>{currentBrand.tagline}</span>
                      <span className="text-red-500 font-mono text-base font-black">”</span>
                    </p>

                    {/* Brand Description with Subtle Interactive Glass Effect on Hover */}
                    <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed transition-all duration-300 hover:text-zinc-200 p-2.5 rounded-xl hover:bg-zinc-900/60 border border-transparent hover:border-zinc-800/80 cursor-default">
                      {currentBrand.description}
                    </p>

                    {/* Quick CTA Button with 3D Depth & Magnetic Glow */}
                    <div className="pt-2 relative z-30">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleBrandClick(currentBrand.searchQuery);
                        }}
                        className="group/cta relative z-30 inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl bg-white hover:bg-zinc-100 active:scale-95 text-black font-black text-xs uppercase tracking-wider transition-all duration-300 shadow-xl cursor-pointer hover:shadow-2xl hover:shadow-white/20 pointer-events-auto"
                      >
                        <span className="pointer-events-none">Ver Peças da {currentBrand.name}</span>
                        <ArrowRight className="w-4 h-4 text-black transition-transform duration-300 group-hover/cta:translate-x-1.5 pointer-events-none" />
                      </button>
                    </div>
                  </div>

                </div>
              </motion.div>
            </AnimatePresence>

            {/* Slide Navigation Controls */}
            <div 
              className="pt-6 border-t border-zinc-800/80 flex items-center justify-between flex-wrap gap-4 mt-6 relative z-30 pointer-events-auto"
            >
              
              {/* Dots Pagination */}
              <div className="flex items-center gap-1.5 relative z-30">
                {filteredBrands.map((b, idx) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCurrentIndex(idx);
                    }}
                    className={`relative z-30 pointer-events-auto h-2.5 rounded-full transition-all duration-300 cursor-pointer ${
                      currentIndex === idx 
                        ? 'w-9 bg-[#E50914] shadow-md shadow-red-600/40' 
                        : 'w-2.5 bg-zinc-700 hover:bg-zinc-500'
                    }`}
                    title={b.name}
                    aria-label={`Ir para marca ${b.name}`}
                  />
                ))}
              </div>

              {/* Prev / Next Buttons */}
              <div className="flex items-center gap-2 relative z-30 pointer-events-auto">
                <span className="text-[11px] font-mono text-zinc-400 mr-2 pointer-events-none">
                  <strong className="text-white">{currentIndex + 1}</strong> / {filteredBrands.length}
                </span>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handlePrev();
                  }}
                  className="relative z-30 p-2.5 rounded-xl bg-[#1E1E1E] hover:bg-[#282828] text-white border border-zinc-700 hover:border-zinc-500 transition-all cursor-pointer active:scale-95 pointer-events-auto shadow-md"
                  aria-label="Marca anterior"
                >
                  <ChevronLeft className="w-4 h-4 pointer-events-none" />
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleNext();
                  }}
                  className="relative z-30 p-2.5 rounded-xl bg-[#1E1E1E] hover:bg-[#282828] text-white border border-zinc-700 hover:border-zinc-500 transition-all cursor-pointer active:scale-95 pointer-events-auto shadow-md"
                  aria-label="Próxima marca"
                >
                  <ChevronRight className="w-4 h-4 pointer-events-none" />
                </button>
              </div>

            </div>

          </div>
        </div>

        {/* MARQUEE BRAND BUTTONS WITH INTERACTIVE 3D HOVER TEXT EFFECTS */}
        <div className="mt-14 pt-8 border-t border-zinc-900">
          <div className="text-center mb-4">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest font-mono">
              ✦ PASSE O MOUSE OU CLIQUE EM QUALQUER MARCA PARA FILTRAR ✦
            </span>
          </div>

          <div className="flex overflow-x-auto no-scrollbar gap-3 pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:justify-center">
            {OFFICIAL_BRANDS.map((brand, idx) => (
              <button
                key={brand.id}
                onClick={() => {
                  const targetIdx = filteredBrands.findIndex(b => b.id === brand.id);
                  if (targetIdx !== -1) setCurrentIndex(targetIdx);
                  handleBrandClick(brand.searchQuery);
                }}
                className="group shrink-0 px-4 py-2.5 rounded-xl bg-[#141414] hover:bg-[#1A1A1A] border border-zinc-800 transition-all duration-300 cursor-pointer flex items-center gap-2 text-left hover:-translate-y-1 hover:scale-105 active:scale-95"
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = `${brand.accentColor}80`;
                  e.currentTarget.style.boxShadow = `0 10px 25px -5px ${brand.accentColor}30`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '';
                  e.currentTarget.style.boxShadow = '';
                }}
              >
                <span className="text-[10px] text-zinc-500 font-mono group-hover:text-zinc-300 transition-colors">
                  0{idx + 1}
                </span>
                <span className="text-xs font-black text-zinc-300 group-hover:text-white uppercase font-display tracking-wider transition-all duration-300 group-hover:tracking-widest">
                  {brand.name}
                </span>
                <span 
                  className="text-[9px] px-1.5 py-0.5 rounded uppercase font-semibold transition-colors"
                  style={{
                    backgroundColor: `${brand.accentColor}20`,
                    color: brand.accentColor
                  }}
                >
                  {brand.category === 'tenis' ? 'Tênis' : 'Street'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* AUTHENTICITY GUARANTEE BANNER */}
        <div className="mt-10 p-5 rounded-2xl bg-zinc-950 border border-zinc-800/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-center sm:text-left">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-950/60 border border-red-800/50 flex items-center justify-center text-[#E50914] shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-black text-white uppercase font-oswald">100% Originais</p>
              <p className="text-[11px] text-zinc-400">Garantia direta com as fábricas</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-yellow-950/60 border border-yellow-800/50 flex items-center justify-center text-yellow-400 shrink-0">
              <Award className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-black text-white uppercase font-oswald">Com Nota Fiscal</p>
              <p className="text-[11px] text-zinc-400">Emissão fiscal em todos os pedidos</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-950/60 border border-blue-800/50 flex items-center justify-center text-blue-400 shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-black text-white uppercase font-oswald">Caixas e Tags de Fábrica</p>
              <p className="text-[11px] text-zinc-400">Embalagem original inviolada</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-950/60 border border-emerald-800/50 flex items-center justify-center text-emerald-400 shrink-0">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-black text-white uppercase font-oswald">Drops Exclusivos</p>
              <p className="text-[11px] text-zinc-400">Lançamentos em primeira mão</p>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}
