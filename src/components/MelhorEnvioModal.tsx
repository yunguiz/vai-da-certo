import { useState, useEffect } from 'react';
import {
  X,
  Truck,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Key,
  Copy,
  Check,
  Loader2,
  LogOut,
  MapPin
} from 'lucide-react';
import {
  MelhorEnvioStatus,
  ShippingOption,
  getMelhorEnvioStatus,
  getMelhorEnvioAuthUrl,
  saveMelhorEnvioToken,
  disconnectMelhorEnvio,
  calculateShippingQuotes
} from '../services/shipping';

interface MelhorEnvioModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MelhorEnvioModal({ isOpen, onClose }: MelhorEnvioModalProps) {
  const [status, setStatus] = useState<MelhorEnvioStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Live quote tester
  const [testCep, setTestCep] = useState('30140071');
  const [testingQuote, setTestingQuote] = useState(false);
  const [quoteOptions, setQuoteOptions] = useState<ShippingOption[]>([]);
  const [quoteLive, setQuoteLive] = useState(false);

  const loadStatus = async () => {
    setLoadingStatus(true);
    try {
      const data = await getMelhorEnvioStatus();
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setFeedback(null);
    loadStatus();
  }, [isOpen]);

  // Listen for OAuth popup completion via postMessage
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (!origin.endsWith('.run.app') && !origin.includes('localhost') && origin !== window.location.origin) {
        return;
      }
      if (event.data?.type === 'MELHOR_ENVIO_AUTH_SUCCESS') {
        setFeedback({ type: 'success', message: 'Melhor Envio conectado via OAuth! Cotações e etiquetas em tempo real ativadas.' });
        loadStatus();
      } else if (event.data?.type === 'MELHOR_ENVIO_AUTH_ERROR') {
        setFeedback({ type: 'error', message: event.data.error || 'Falha na autorização do Melhor Envio.' });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (!isOpen) return null;

  const handleOAuthConnect = async () => {
    setFeedback(null);
    try {
      const { url } = await getMelhorEnvioAuthUrl();
      const popup = window.open(url, 'melhor_envio_oauth', 'width=620,height=740');
      if (!popup) {
        setFeedback({
          type: 'error',
          message: 'Pop-up bloqueado pelo navegador. Permita pop-ups para este site e tente novamente.'
        });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Erro ao iniciar OAuth do Melhor Envio.' });
    }
  };

  const handleSaveManualToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setIsSavingToken(true);
    setFeedback(null);
    try {
      const res = await saveMelhorEnvioToken(tokenInput.trim());
      if (res.success) {
        setTokenInput('');
        setFeedback({ type: 'success', message: 'Token do Melhor Envio conectado com sucesso!' });
        await loadStatus();
      } else {
        setFeedback({ type: 'error', message: res.error || 'Token inválido.' });
      }
    } catch (err: any) {
      setFeedback({ type: 'error', message: err.message || 'Erro ao salvar token.' });
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectMelhorEnvio();
    setFeedback(null);
    await loadStatus();
  };

  const handleCopyRedirectUri = () => {
    if (!status?.redirectUri) return;
    navigator.clipboard.writeText(status.redirectUri);
    setCopiedUri(true);
    setTimeout(() => setCopiedUri(false), 2500);
  };

  const handleTestQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingQuote(true);
    try {
      const res = await calculateShippingQuotes({
        cep: testCep,
        cartTotal: 159.90,
        items: [{ id: 'test-item', price: 159.90, quantity: 1, weight: 0.45 }]
      });
      setQuoteOptions(res.options || []);
      setQuoteLive(Boolean(res.live));
    } finally {
      setTestingQuote(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md">
      <div className="relative w-full max-w-xl bg-[#0F0F0F] border border-zinc-800 rounded-2xl shadow-2xl p-5 sm:p-6 overflow-hidden max-h-[92vh] overflow-y-auto no-scrollbar">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-black uppercase text-white font-oswald tracking-wide flex items-center gap-2">
                Integração Melhor Envio
              </h2>
              <p className="text-xs text-zinc-400">Frete ao vivo, etiquetas Correios/Jadlog e rastreio automático</p>
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

        {/* Account Status Card */}
        <div className="mt-4 p-4 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-white font-oswald">
              Status da Conta Melhor Envio (App ID: {status?.clientId || '9001181'})
            </span>
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                status?.connected
                  ? 'bg-emerald-950 text-emerald-400 border border-emerald-700'
                  : 'bg-amber-950/60 text-amber-400 border border-amber-700/60'
              }`}
            >
              {loadingStatus ? 'VERIFICANDO...' : status?.connected ? 'CONECTADO' : 'AGUARDANDO AUTORIZAÇÃO'}
            </span>
          </div>

          {status?.connected && status.user ? (
            <div className="p-3 rounded-lg bg-zinc-950 border border-emerald-800/50 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Conta Conectada:</span>
                <span className="text-white font-bold">{status.user.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">E-mail:</span>
                <span className="text-zinc-200">{status.user.email}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Saldo na Carteira:</span>
                <span className="text-emerald-400 font-bold">
                  R$ {Number(status.balance?.balance || 0).toFixed(2).replace('.', ',')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">CEP de Origem (Itabira-MG):</span>
                <span className="text-zinc-200 font-mono">{status.fromPostalCode || '35900539'}</span>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                className="mt-1 text-[11px] text-red-400 hover:text-red-300 flex items-center gap-1 cursor-pointer"
              >
                <LogOut className="w-3 h-3" />
                <span>Desconectar conta</span>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleOAuthConnect}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs uppercase tracking-wider rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer shadow-lg shadow-emerald-950/50"
              >
                <ExternalLink className="w-4 h-4" />
                <span>Conectar Melhor Envio (OAuth 1 Clique)</span>
              </button>

              {status?.redirectUri && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] text-zinc-400 block">
                    URL de Redirecionamento (Callback) configurada no App Melhor Envio:
                  </span>
                  <div className="p-2 bg-zinc-950 rounded-lg border border-zinc-800 flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-300">
                    <span className="truncate">{status.redirectUri}</span>
                    <button
                      type="button"
                      onClick={handleCopyRedirectUri}
                      className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded text-[10px] font-bold flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      {copiedUri ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedUri ? 'Copiado!' : 'Copiar'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {feedback && (
            <div
              className={`p-2.5 rounded-lg text-xs flex items-center gap-2 border ${
                feedback.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                  : 'bg-red-950/40 border-red-800/60 text-red-300'
              }`}
            >
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              )}
              <span>{feedback.message}</span>
            </div>
          )}
        </div>

        {/* Optional Personal Token */}
        {!status?.connected && (
          <div className="mt-4 p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 space-y-2">
            <div className="flex items-center gap-2 text-zinc-300 font-bold text-xs uppercase font-oswald">
              <Key className="w-3.5 h-3.5 text-yellow-400" />
              <span>Ou cole seu Token Pessoal do Melhor Envio</span>
            </div>
            <form onSubmit={handleSaveManualToken} className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Cole o Bearer Token gerado no painel..."
                className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500 font-mono"
              />
              <button
                type="submit"
                disabled={isSavingToken || !tokenInput.trim()}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white text-xs font-bold uppercase rounded-xl cursor-pointer"
              >
                {isSavingToken ? 'Salvando...' : 'Salvar'}
              </button>
            </form>
          </div>
        )}

        {/* Live Quote Tester */}
        <div className="mt-4 p-4 rounded-xl bg-zinc-900/50 border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-white font-bold text-xs uppercase font-oswald">
              <MapPin className="w-3.5 h-3.5 text-[#E50914]" />
              <span>Testar Cotação de Frete (CEP Origem: 35900-539)</span>
            </div>
          </div>

          <form onSubmit={handleTestQuote} className="flex gap-2">
            <input
              type="text"
              maxLength={9}
              value={testCep}
              onChange={(e) => setTestCep(e.target.value.replace(/\D/g, ''))}
              placeholder="CEP destino (ex: 30140071)"
              className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-white font-mono focus:outline-none focus:border-[#E50914]"
            />
            <button
              type="submit"
              disabled={testingQuote}
              className="px-4 py-2 bg-[#E50914] hover:bg-red-700 text-white text-xs font-bold uppercase rounded-xl cursor-pointer flex items-center gap-1.5"
            >
              {testingQuote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              <span>Calcular</span>
            </button>
          </form>

          {quoteOptions.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[10px] font-bold uppercase text-zinc-400">
                {quoteLive ? '✅ Cotações reais da API Melhor Envio:' : 'ℹ️ Cotações estimadas (conecte o OAuth para tarifa exata):'}
              </div>
              {quoteOptions.map((opt) => (
                <div
                  key={opt.id}
                  className="flex items-center justify-between p-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs"
                >
                  <div>
                    <strong className="text-white">{opt.company.name} · {opt.name}</strong>
                    <span className="text-zinc-400 ml-2 text-[11px]">({opt.deliveryText})</span>
                  </div>
                  <span className="font-bold text-emerald-400">{opt.priceFormatted}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
