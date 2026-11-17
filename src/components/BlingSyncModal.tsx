import { useState, useEffect, useRef } from 'react';
import { X, RefreshCw, CheckCircle2, AlertCircle, Image as ImageIcon, Sparkles, ExternalLink, Upload, Key, Copy, Check } from 'lucide-react';
import { Product } from '../types';

interface BlingSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetProduct?: Product | null;
  onCatalogRefresh: () => void;
}

const POPULAR_TARGETS = [
  { name: 'TENIS TESLA HERTZ ART PURPLE', sku: 'TTHA10139', label: '🟣 Tesla Hertz Art Purple' },
  { name: 'TENIS TESLA HERTZ BLACK', sku: 'TTHA10438', label: '⚫ Tesla Hertz Black' },
  { name: 'TENIS TESLA FLOW XL BLACK E WHITE', sku: 'TTFX10143', label: '⚪ Tesla Flow XL Black/White' },
  { name: 'CHINELO HAVAIANAS CITY BASIC ROSE GOLD', sku: 'CHCB10140', label: '🩴 Havaianas City Rose Gold' }
];

export function BlingSyncModal({
  isOpen,
  onClose,
  targetProduct,
  onCatalogRefresh
}: BlingSyncModalProps) {
  const [status, setStatus] = useState<{
    connected: boolean;
    clientId?: string;
    tokenInvalid?: boolean;
    error?: string;
    redirectUri?: string;
  } | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  // Selected product to update image
  const [selectedTarget, setSelectedTarget] = useState<{ name: string; sku: string }>(() => {
    if (targetProduct) {
      return { name: targetProduct.name, sku: targetProduct.integration?.sku || '' };
    }
    return POPULAR_TARGETS[0];
  });

  const [imageUrlInput, setImageUrlInput] = useState('');
  const [isUpdatingImage, setIsUpdatingImage] = useState(false);
  const [imageUpdateSuccess, setImageUpdateSuccess] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/webhooks/bling`
    : 'https://ais-dev-oyrco7oz4nuj4kmovythxd-110121272862.us-east1.run.app/api/webhooks/bling';

  const callbackUrl = status?.redirectUri || (typeof window !== 'undefined'
    ? `${window.location.origin}/auth/callback`
    : 'https://ais-dev-oyrco7oz4nuj4kmovythxd-110121272862.us-east1.run.app/auth/callback');

  const loadBlingStatus = () => {
    fetch('/api/bling/status?verify=true')
      .then((res) => res.json())
      .then((data) => {
        setStatus(data);
        if (data.tokenInvalid && data.error) {
          setErrorMsg(data.error);
        }
      })
      .catch(() => setStatus({ connected: false }));
  };

  useEffect(() => {
    if (!isOpen) return;
    setErrorMsg(null);
    setSyncResult(null);
    loadBlingStatus();

    if (targetProduct) {
      setSelectedTarget({
        name: targetProduct.name,
        sku: targetProduct.integration?.sku || ''
      });
    }
  }, [isOpen, targetProduct]);

  useEffect(() => {
    const handleOAuthMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (!origin.endsWith('.run.app') && !origin.includes('localhost') && origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS' && event.data?.provider === 'bling') {
        setErrorMsg(null);
        setStatus((prev) => ({ ...prev, connected: true, tokenInvalid: false }));
        setSyncResult('Bling ERP conectado via OAuth! Puxando novos produtos e fotos...');
        handleSyncImages();
      }
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, []);

  if (!isOpen) return null;

  const handleOAuthPopup = async () => {
    setErrorMsg(null);
    try {
      const res = await fetch('/api/bling/auth-url');
      const data = await res.json();
      const targetUrl = data.url || data.urlWithRedirect;
      if (!targetUrl) {
        throw new Error('URL de autorização do Bling indisponível.');
      }
      const popup = window.open(targetUrl, 'bling_oauth_popup', 'width=640,height=740');
      if (!popup) {
        setErrorMsg('Pop-up bloqueado pelo navegador. Permita pop-ups para este site e clique novamente.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao iniciar autorização OAuth do Bling.');
    }
  };

  const handleCopyRedirect = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopiedRedirect(true);
    setTimeout(() => setCopiedRedirect(false), 2500);
  };

  const handleSyncImages = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    setErrorMsg(null);

    try {
      const [imgRes, catRes] = await Promise.all([
        fetch('/api/bling/sync-images?clearCache=true', { method: 'POST' }),
        fetch(`/api/catalog/products?refresh=true&_t=${Date.now()}`)
      ]);
      const imgData = await imgRes.json();
      const catData = await catRes.json();

      if (catData.blingConnected) {
        setStatus((prev) => ({ ...prev, connected: true, tokenInvalid: false }));
      }

      if (imgData.success && imgData.connected) {
        const pulledLabel = catData.blingCount ? `${catData.blingCount} produtos do Bling no catálogo` : 'catálogo atualizado';
        setSyncResult(`${pulledLabel}. ${imgData.message || ''}`.trim());
        onCatalogRefresh();
      } else if (catData.blingError || imgData.error || !imgData.connected) {
        setStatus((prev) => ({ ...prev, connected: false, tokenInvalid: true }));
        setErrorMsg(
          catData.blingError ||
          imgData.error ||
          'Bling ERP não conectado ou token expirado. Clique em "Autorizar Conexão no Bling ERP (1 Clique)" acima para puxar seus novos produtos.'
        );
      } else {
        setSyncResult(imgData.message || 'Catálogo sincronizado.');
        onCatalogRefresh();
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Falha na requisição de sincronização.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setIsSavingToken(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/bling/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: tokenInput.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setStatus((prev) => ({ ...prev, connected: true, tokenInvalid: false }));
        setTokenInput('');
        setSyncResult('Bling ERP conectado! Puxando novos produtos e imagens...');
        handleSyncImages();
      } else {
        setStatus((prev) => ({ ...prev, connected: false, tokenInvalid: true }));
        setErrorMsg(data.error || 'Token inválido ou expirado.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao conectar ao Bling.');
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleUpdateProductImageByUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!imageUrlInput.trim()) return;
    setIsUpdatingImage(true);
    setImageUpdateSuccess(false);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/products/update-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: selectedTarget.sku,
          name: selectedTarget.name,
          imageUrl: imageUrlInput.trim()
        })
      });
      const data = await res.json();
      if (data.success) {
        setImageUpdateSuccess(true);
        setImageUrlInput('');
        onCatalogRefresh();
      } else {
        setErrorMsg(data.error || 'Falha ao atualizar imagem.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao salvar nova imagem.');
    } finally {
      setIsUpdatingImage(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUpdatingImage(true);
    setImageUpdateSuccess(false);
    setErrorMsg(null);

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const fileData = reader.result as string;
        const res = await fetch('/api/products/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: selectedTarget.sku,
            name: selectedTarget.name,
            fileData,
            fileName: file.name
          })
        });
        const data = await res.json();
        if (data.success) {
          setImageUpdateSuccess(true);
          onCatalogRefresh();
        } else {
          setErrorMsg(data.error || 'Falha ao fazer upload da imagem.');
        }
      } catch (err: any) {
        setErrorMsg(err.message || 'Erro ao processar imagem.');
      } finally {
        setIsUpdatingImage(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 2500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md animate-fadeIn">
      <div className="relative w-full max-w-xl bg-[#0F0F0F] border border-zinc-800 rounded-2xl shadow-2xl p-5 sm:p-6 overflow-hidden max-h-[92vh] overflow-y-auto no-scrollbar">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-red-600/20 border border-red-600/40 flex items-center justify-center text-[#E50914]">
              <RefreshCw className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-black uppercase text-white font-oswald tracking-wide flex items-center gap-2">
                Sincronizar Bling ERP (Até 1.350 Produtos)
              </h2>
              <p className="text-xs text-zinc-400">Puxa até 1.350 produtos com fotos reais e oculta itens sem estoque automaticamente</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Connection warning notice */}
        {!status?.connected && (
          <div className="mt-4 p-3.5 rounded-xl bg-amber-950/30 border border-amber-800/50 text-amber-200 text-xs leading-relaxed space-y-1.5">
            <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-amber-300">
              <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
              <span>Conexão Bling ERP necessária para puxar novos produtos</span>
            </div>
            <p className="text-[11px] text-zinc-300 leading-normal">
              {status?.tokenInvalid
                ? 'O token anterior do Bling expirou ou é inválido. Clique em "Autorizar Conexão no Bling ERP (1 Clique)" abaixo para gerar um novo token OAuth e puxar todos os novos produtos.'
                : 'Autorize sua conta Bling API v3 abaixo para importar automaticamente até 1.350 produtos novos, estoque real (ocultando itens sem estoque) e fotos internas armazenadas no Bling.'}
            </p>
          </div>
        )}

        {/* SECTION 1: CONNECT BLING API & PULL ALL PRODUCTS */}
        <div className="mt-5 p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-white font-bold text-xs uppercase tracking-wider font-oswald">
              <Key className="w-4 h-4 text-yellow-400" />
              <span>1. Conectar Bling ERP e Puxar Até 1.350 Produtos</span>
            </div>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${status?.connected ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-red-950/60 text-red-300 border border-red-800/60'}`}>
              {status?.connected ? 'CONECTADO' : 'RECONECTAR OAUTH'}
            </span>
          </div>

          {/* 1-Click OAuth Popup Button (opens Bling directly per OAuth rules) */}
          <div className="pt-1">
            <button
              type="button"
              onClick={handleOAuthPopup}
              className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-emerald-950/50"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Autorizar Conexão no Bling ERP (1 Clique)</span>
            </button>
          </div>

          {/* Callback URL helper */}
          <div className="p-2.5 bg-zinc-950/90 rounded-xl border border-zinc-800 space-y-1">
            <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
              URL de Callback OAuth (configurada no aplicativo Bling):
            </div>
            <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-300">
              <span className="truncate">{callbackUrl}</span>
              <button
                type="button"
                onClick={handleCopyRedirect}
                className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-[10px] font-bold flex items-center gap-1 shrink-0 cursor-pointer"
              >
                {copiedRedirect ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedRedirect ? 'Copiado!' : 'Copiar'}</span>
              </button>
            </div>
          </div>

          <div className="text-[10px] text-zinc-500 text-center uppercase tracking-wider font-bold">
            OU COLE SEU ACCESS TOKEN / LINK DE RETORNO (?CODE=):
          </div>

          <form onSubmit={handleSaveToken} className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Cole o Access Token ou a URL de callback com ?code=..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-yellow-400 font-mono"
              />
              <button
                type="submit"
                disabled={isSavingToken || !tokenInput.trim()}
                className="px-4 py-2 bg-yellow-500 hover:bg-yellow-400 disabled:opacity-50 text-black font-black uppercase text-xs rounded-xl transition-colors shrink-0 cursor-pointer"
              >
                {isSavingToken ? 'Validando...' : 'Conectar'}
              </button>
            </div>
          </form>

          {/* Sync Button */}
          <button
            type="button"
            onClick={handleSyncImages}
            disabled={isSyncing}
            className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer border border-zinc-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Puxando até 1.350 Produtos e Fotos...' : 'Puxar Até 1.350 Produtos e Fotos do Bling Agora'}</span>
          </button>

          {syncResult && (
            <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>{syncResult}</span>
            </div>
          )}

          {errorMsg && (
            <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* SECTION 2: INSTANT PRODUCT IMAGE UPDATE */}
        <div className="mt-5 p-4 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-white font-bold text-xs uppercase tracking-wider font-oswald">
              <ImageIcon className="w-4 h-4 text-[#E50914]" />
              <span>2. Atualizar Foto Manual no Catálogo</span>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">Reflete na vitrine na hora</span>
          </div>

          {/* Quick Target Chips */}
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-400 font-medium">Selecione a peça:</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {POPULAR_TARGETS.map((t) => {
                const isSelected = selectedTarget.name === t.name;
                return (
                  <button
                    key={t.sku}
                    type="button"
                    onClick={() => {
                      setSelectedTarget({ name: t.name, sku: t.sku });
                      setImageUpdateSuccess(false);
                    }}
                    className={`text-left px-3 py-2 rounded-lg text-xs font-bold transition-all border cursor-pointer ${
                      isSelected
                        ? 'bg-[#E50914] text-white border-[#E50914] shadow-md shadow-red-950/60'
                        : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:border-zinc-700'
                    }`}
                  >
                    <div>{t.label}</div>
                    <div className="text-[10px] opacity-70 font-mono font-normal">SKU: {t.sku}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Direct File Upload Button */}
          <div className="pt-2">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              type="button"
              disabled={isUpdatingImage}
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer border border-zinc-700 hover:border-zinc-500"
            >
              <Upload className="w-4 h-4 text-emerald-400" />
              <span>{isUpdatingImage ? 'Enviando Imagem...' : `Escolher Arquivo do Computador p/ ${selectedTarget.name.split(' ')[2] || 'Produto'}`}</span>
            </button>
          </div>

          {/* OR Paste URL */}
          <div className="pt-1">
            <div className="text-[11px] text-zinc-500 text-center mb-1.5 uppercase font-bold tracking-wider">OU COLE A URL DA IMAGEM:</div>
            <form onSubmit={handleUpdateProductImageByUrl} className="flex gap-2">
              <input
                type="url"
                placeholder="Cole o link da foto (https://...)"
                value={imageUrlInput}
                onChange={(e) => setImageUrlInput(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#E50914]"
              />
              <button
                type="submit"
                disabled={isUpdatingImage || !imageUrlInput.trim()}
                className="px-4 py-2 bg-[#E50914] hover:bg-red-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition-colors shrink-0 cursor-pointer"
              >
                Aplicar
              </button>
            </form>
          </div>

          {imageUpdateSuccess && (
            <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-300 text-xs flex items-center gap-2 font-semibold">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              <span>Foto atualizada com sucesso! A vitrine da loja já está exibindo a nova imagem.</span>
            </div>
          )}
        </div>

        {/* SECTION 3: AUTOMATIC WEBHOOK SETUP */}
        <div className="mt-5 p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/80 space-y-2">
          <div className="flex items-center gap-2 text-zinc-300 font-bold text-xs uppercase tracking-wider font-oswald">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            <span>3. Webhook Automático no Bling (Atualização Instantânea)</span>
          </div>
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Para que cada foto trocada no Bling seja enviada automaticamente para o site sem você precisar clicar em nada:
          </p>
          <div className="p-2.5 bg-zinc-950 rounded-xl border border-zinc-800 flex items-center justify-between gap-2 font-mono text-[11px] text-zinc-300">
            <span className="truncate">{webhookUrl}</span>
            <button
              type="button"
              onClick={handleCopyWebhook}
              className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 shrink-0 cursor-pointer"
            >
              {copiedWebhook ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedWebhook ? 'Copiado!' : 'Copiar URL'}</span>
            </button>
          </div>
          <p className="text-[10px] text-zinc-500">
            Cadastre no Bling em <em>Configurações &gt; Integrações &gt; Webhooks &gt; Adicionar Webhook</em> selecionando o evento <strong>Produtos (Alteração)</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
