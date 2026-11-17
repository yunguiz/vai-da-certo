import React, { useState, useRef, useEffect } from 'react';
import {
  Lock,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  PackageCheck,
  ShieldCheck,
  StopCircle,
  Loader2,
} from 'lucide-react';

interface SyncPageResponse {
  finalizado: boolean;
  totalImportado?: number;
  proximaPagina?: number;
  ultimaPagina?: number;
  paginasProcessadas?: number;
  importadosNaPagina?: number;
  documentosGravados?: number;
  authorized?: boolean;
  error?: string;
}

const SESSION_KEY = 'bling_admin_sync_secret';
const ESTIMATED_TOTAL_PAGES = 15;

export function AdminBlingSyncPage() {
  const [secretInput, setSecretInput] = useState('');
  const [verifiedSecret, setVerifiedSecret] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState('');

  const [isSyncing, setIsSyncing] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [currentPage, setCurrentPage] = useState(0);
  const [estimatedPages, setEstimatedPages] = useState(ESTIMATED_TOTAL_PAGES);
  const [totalImported, setTotalImported] = useState(0);
  const [totalDocsWritten, setTotalDocsWritten] = useState(0);
  const [lastBatchInfo, setLastBatchInfo] = useState<string>('');

  const abortControllerRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);

  // Restaura senha da sessão apenas se validada anteriormente nesta aba
  useEffect(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      setVerifiedSecret(saved);
    }
  }, []);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const candidate = secretInput.trim();
    if (!candidate) {
      setAuthError('Digite o CRON_SECRET para liberar o painel.');
      return;
    }

    setIsVerifying(true);
    setAuthError('');

    try {
      const response = await fetch('/api/bling/sync?verify=true', {
        method: 'GET',
        headers: {
          'x-cron-secret': candidate,
        },
      });
      const data = (await response.json().catch(() => ({}))) as SyncPageResponse;

      if (!response.ok || !data.authorized) {
        setAuthError(data.error || 'Senha inválida. Acesso negado.');
        return;
      }

      sessionStorage.setItem(SESSION_KEY, candidate);
      setVerifiedSecret(candidate);
      setSecretInput('');
    } catch {
      setAuthError('Erro de conexão ao validar a senha no servidor.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleLock = () => {
    if (isSyncing) return;
    sessionStorage.removeItem(SESSION_KEY);
    setVerifiedSecret('');
    setIsFinished(false);
    setSyncError('');
  };

  const handleStopSync = () => {
    cancelledRef.current = true;
    abortControllerRef.current?.abort();
  };

  const handleStartSync = async () => {
    if (!verifiedSecret || isSyncing) return;

    cancelledRef.current = false;
    setIsSyncing(true);
    setIsFinished(false);
    setSyncError('');
    setCurrentPage(1);
    setEstimatedPages(ESTIMATED_TOTAL_PAGES);
    setTotalImported(0);
    setTotalDocsWritten(0);
    setLastBatchInfo('Iniciando conexão segura com a API v3 do Bling...');

    let pagina = 1;
    let finalizado = false;
    let acumuladoProdutos = 0;
    let acumuladoDocs = 0;

    try {
      while (!finalizado && !cancelledRef.current) {
        setCurrentPage(pagina);
        if (pagina > estimatedPages) {
          setEstimatedPages(pagina + 2);
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        const response = await fetch(
          `/api/bling/sync?all=true&pagina=${encodeURIComponent(String(pagina))}`,
          {
            method: 'GET',
            headers: {
              'x-cron-secret': verifiedSecret,
            },
            signal: controller.signal,
          }
        );

        const data = (await response.json().catch(() => ({}))) as SyncPageResponse;

        if (response.status === 401) {
          sessionStorage.removeItem(SESSION_KEY);
          setVerifiedSecret('');
          throw new Error('Sessão expirada ou CRON_SECRET inválido. Faça login novamente.');
        }

        if (!response.ok) {
          throw new Error(data.error || `Falha na página ${pagina} (HTTP ${response.status}).`);
        }

        const naPagina = Number(data.totalImportado ?? data.importadosNaPagina ?? 0);
        const docsNaPagina = Number(data.documentosGravados ?? naPagina);
        acumuladoProdutos += naPagina;
        acumuladoDocs += docsNaPagina;

        setTotalImported(acumuladoProdutos);
        setTotalDocsWritten(acumuladoDocs);

        if (data.finalizado) {
          finalizado = true;
          setIsFinished(true);
          setLastBatchInfo(
            acumuladoProdutos > 0
              ? `Sincronização concluída! ${acumuladoProdutos} itens processados em ${acumuladoDocs} produtos no Firestore.`
              : 'Nenhum produto ativo encontrado no Bling para sincronizar.'
          );
          break;
        }

        const ultima = Number(data.ultimaPagina || pagina);
        setLastBatchInfo(
          `Lote até página ${ultima} gravado via WriteBatch (${acumuladoProdutos} itens / ${acumuladoDocs} docs na coleção products).`
        );

        pagina = Number(data.proximaPagina || ultima + 1);
      }

      if (cancelledRef.current) {
        setLastBatchInfo(
          `Sincronização interrompida manualmente na página ${pagina}. ${acumuladoProdutos} produtos já foram gravados.`
        );
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setLastBatchInfo(
          `Sincronização interrompida na página ${pagina}. ${acumuladoProdutos} produtos gravados até o momento.`
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setSyncError(message);
      }
    } finally {
      abortControllerRef.current = null;
      setIsSyncing(false);
    }
  };

  const progressPercent = isFinished
    ? 100
    : currentPage === 0
      ? 0
      : Math.min(95, Math.round((currentPage / Math.max(estimatedPages, currentPage)) * 100));

  return (
    <div className="min-h-screen bg-[#0E0E0E] text-[#F5F5F5] flex flex-col justify-between px-4 py-8 selection:bg-[#E50914] selection:text-white">
      {/* Top Bar */}
      <header className="max-w-2xl w-full mx-auto flex items-center justify-between border-b border-white/10 pb-5">
        <a
          href="/"
          className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-neutral-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Voltar à Loja
        </a>
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-neutral-500">
          <ShieldCheck className="w-4 h-4 text-[#E50914]" />
          Admin · Bling ERP v3
        </div>
      </header>

      {/* Main Card */}
      <main className="max-w-2xl w-full mx-auto my-auto py-10">
        <div className="bg-[#141414] border border-white/10 rounded-lg p-6 sm:p-8 shadow-2xl">
          <div className="mb-6">
            <p className="text-[11px] uppercase tracking-[0.25em] text-[#E50914] font-semibold mb-2">
              Sincronização em Lote · Firestore
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Catálogo Bling ERP
            </h1>
            <p className="text-sm text-neutral-400 mt-2 leading-relaxed">
              Importa todos os produtos ativos do Bling v3 em lotes seguros via{' '}
              <code className="text-neutral-300">/api/bling/sync</code>, salvando estoque, preço,
              grades e imagens <code className="text-neutral-300">.link</code> em alta resolução com{' '}
              <code className="text-neutral-300">WriteBatch</code>.
            </p>
          </div>

          {!verifiedSecret ? (
            <form onSubmit={handleUnlock} className="space-y-4">
              <div>
                <label
                  htmlFor="cron-secret-input"
                  className="block text-xs uppercase tracking-[0.18em] text-neutral-400 mb-2"
                >
                  Senha de Acesso (CRON_SECRET)
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-neutral-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="cron-secret-input"
                    type="password"
                    autoComplete="current-password"
                    value={secretInput}
                    onChange={(e) => setSecretInput(e.target.value)}
                    placeholder="Digite o CRON_SECRET configurado no servidor"
                    className="w-full bg-[#0E0E0E] border border-white/15 rounded-md pl-10 pr-4 py-3 text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-[#E50914] transition-colors"
                  />
                </div>
              </div>

              {authError && (
                <div className="flex items-start gap-2.5 bg-red-950/40 border border-red-500/30 rounded-md p-3 text-xs text-red-300">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isVerifying}
                className="w-full bg-white text-black hover:bg-neutral-200 disabled:opacity-60 font-semibold text-xs uppercase tracking-[0.2em] py-3.5 rounded-md transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                {isVerifying ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Validando credencial...
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    Desbloquear Painel
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-6">
              {/* Progress Display */}
              {(isSyncing || isFinished || totalImported > 0) && (
                <div className="bg-[#0E0E0E] border border-white/10 rounded-md p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <span className="font-medium text-white">
                      {isSyncing
                        ? `Importando página ${currentPage} de ~${estimatedPages}... ${totalImported} produtos sincronizados`
                        : isFinished
                          ? `Concluído — ${totalImported} produtos sincronizados`
                          : `Pausado na página ${currentPage} — ${totalImported} produtos sincronizados`}
                    </span>
                    <span className="font-mono text-neutral-400 shrink-0">{progressPercent}%</span>
                  </div>

                  <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isFinished ? 'bg-emerald-500' : 'bg-[#E50914]'
                      }`}
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400 pt-1">
                    <span className="inline-flex items-center gap-1.5">
                      {isFinished ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <PackageCheck className="w-3.5 h-3.5 text-neutral-400" />
                      )}
                      {lastBatchInfo}
                    </span>
                    {totalDocsWritten > 0 && (
                      <span className="font-mono text-[11px] text-neutral-500">
                        Docs Firestore: {totalDocsWritten}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {syncError && (
                <div className="flex items-start gap-2.5 bg-red-950/40 border border-red-500/30 rounded-md p-3.5 text-xs text-red-300">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-semibold text-red-200">Erro durante a sincronização</p>
                    <p>{syncError}</p>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={handleStartSync}
                  disabled={isSyncing}
                  className="flex-1 bg-[#E50914] hover:bg-[#c80812] disabled:opacity-60 text-white font-semibold text-xs uppercase tracking-[0.2em] py-3.5 px-5 rounded-md transition-colors flex items-center justify-center gap-2.5 cursor-pointer"
                >
                  {isSyncing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Sincronizando Página {currentPage}...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      Sincronizar Catálogo do Bling
                    </>
                  )}
                </button>

                {isSyncing ? (
                  <button
                    type="button"
                    onClick={handleStopSync}
                    className="sm:w-auto bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold text-xs uppercase tracking-[0.18em] py-3.5 px-5 rounded-md transition-colors flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <StopCircle className="w-4 h-4" />
                    Parar
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleLock}
                    className="sm:w-auto bg-transparent border border-white/15 hover:border-white/30 text-neutral-400 hover:text-white font-semibold text-xs uppercase tracking-[0.18em] py-3.5 px-5 rounded-md transition-colors cursor-pointer"
                  >
                    Bloquear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-2xl w-full mx-auto text-center text-[11px] text-neutral-600 border-t border-white/5 pt-4">
        Rota administrativa protegida por CRON_SECRET · Tokens OAuth 2.0 gerenciados automaticamente via Firestore
      </footer>
    </div>
  );
}
