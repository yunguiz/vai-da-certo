const DEFAULT_MELHOR_ENVIO_URL = 'https://melhorenvio.com.br';
const DEFAULT_FROM_CEP = '35900539';
const DEFAULT_USER_AGENT = 'StreetStore (streetstore364@gmail.com)';

function resolveMelhorEnvioBaseUrl(): string {
  const candidates = [process.env.MELHOR_ENVIO_URL, process.env.MELHOR_ENVIO_API_URL];
  for (const raw of candidates) {
    const cleaned = (raw || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/api\/v2$/i, '');
    if (/^https?:\/\//i.test(cleaned)) {
      return cleaned;
    }
  }
  return DEFAULT_MELHOR_ENVIO_URL;
}

function getMelhorEnvioConfig() {
  const token = (process.env.MELHOR_ENVIO_TOKEN || '').trim();
  if (!token) {
    throw new Error('Variável de ambiente MELHOR_ENVIO_TOKEN não configurada.');
  }

  const rawUrl = resolveMelhorEnvioBaseUrl();

  const userAgent = (process.env.MELHOR_ENVIO_USER_AGENT || DEFAULT_USER_AGENT).trim();
  const fromPostalCode = sanitizeCep(process.env.MELHOR_ENVIO_FROM_POSTAL_CODE || DEFAULT_FROM_CEP);

  return {
    token,
    apiBaseUrl: `${rawUrl}/api/v2`,
    userAgent,
    fromPostalCode,
  };
}

export function sanitizeCep(cep: string): string {
  return String(cep || '').replace(/\D/g, '').slice(0, 8);
}

export interface ProdutoFreteInput {
  id?: string | number;
  // Padrão Melhor Envio
  weight?: number;
  height?: number;
  width?: number;
  length?: number;
  insurance_value?: number;
  quantity?: number;
  // Aliases em português para flexibilidade
  peso?: number; // em kg
  altura?: number; // em cm
  largura?: number; // em cm
  comprimento?: number; // em cm
  valorSegurado?: number;
  preco?: number;
  quantidade?: number;
}

export interface TransportadoraFormatada {
  id: number;
  nome: string;
  empresa: {
    id: number;
    nome: string;
    logo: string;
  };
  preco: number;
  precoFormatado: string;
  desconto: number;
  moeda: string;
  prazoEntregaDias: number;
  prazoTexto: string;
}

export interface CalcularFreteResult {
  sucesso: boolean;
  cepOrigem: string;
  cepDestino: string;
  transportadoras: TransportadoraFormatada[];
}

/**
 * Calcula fretes disponíveis na API v2 do Melhor Envio (POST /api/v2/me/shipment/calculate).
 */
export async function calcularFreteMelhorEnvio(params: {
  cepDestino: string;
  cepOrigem?: string;
  produtos: ProdutoFreteInput[];
}): Promise<CalcularFreteResult> {
  const { token, apiBaseUrl, userAgent, fromPostalCode } = getMelhorEnvioConfig();
  const cepDestino = sanitizeCep(params.cepDestino);
  const cepOrigem = sanitizeCep(params.cepOrigem || fromPostalCode);

  if (cepDestino.length !== 8) {
    throw new Error('CEP de destino inválido. Informe 8 dígitos numéricos.');
  }

  if (!Array.isArray(params.produtos) || params.produtos.length === 0) {
    throw new Error('Informe ao menos um produto com dimensões e peso para cálculo do frete.');
  }

  const productsPayload = params.produtos.map((item, index) => {
    const peso = Number(item.weight ?? item.peso ?? 0.35);
    const altura = Number(item.height ?? item.altura ?? 5);
    const largura = Number(item.width ?? item.largura ?? 24);
    const comprimento = Number(item.length ?? item.comprimento ?? 30);
    const valorSegurado = Number(item.insurance_value ?? item.valorSegurado ?? item.preco ?? 50);
    const quantidade = Math.max(1, Math.round(Number(item.quantity ?? item.quantidade ?? 1)));

    return {
      id: String(item.id ?? `item-${index + 1}`),
      width: Math.max(11, largura),
      height: Math.max(2, altura),
      length: Math.max(16, comprimento),
      weight: Math.max(0.1, Number(peso.toFixed(3))),
      insurance_value: Math.max(1, Number(valorSegurado.toFixed(2))),
      quantity: quantidade,
    };
  });

  const response = await fetch(`${apiBaseUrl}/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
    },
    body: JSON.stringify({
      from: { postal_code: cepOrigem },
      to: { postal_code: cepDestino },
      products: productsPayload,
    }),
  });

  const rawText = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new Error(`Resposta inválida do Melhor Envio [${response.status}]: ${rawText}`);
  }

  if (!response.ok || !Array.isArray(json)) {
    const errObj = json as { message?: string; error?: string; errors?: unknown };
    const detail = errObj?.message || errObj?.error || rawText;
    throw new Error(`Erro Melhor Envio [${response.status}]: ${detail}`);
  }

  const transportadoras: TransportadoraFormatada[] = json
    .filter((opt: any) => !opt?.error && (opt?.custom_price || opt?.price))
    .map((opt: any) => {
      const preco = Number(parseFloat(String(opt.custom_price || opt.price || '0')).toFixed(2));
      const prazo = parseInt(String(opt.custom_delivery_time || opt.delivery_time || '5'), 10);

      return {
        id: Number(opt.id),
        nome: String(opt.name || 'Frete'),
        empresa: {
          id: Number(opt.company?.id || 0),
          nome: String(opt.company?.name || 'Transportadora'),
          logo: String(opt.company?.picture || ''),
        },
        preco,
        precoFormatado: preco.toLocaleString('pt-BR', {
          style: 'currency',
          currency: 'BRL',
        }),
        desconto: Number(parseFloat(String(opt.discount || '0')).toFixed(2)),
        moeda: String(opt.currency || 'BRL'),
        prazoEntregaDias: prazo,
        prazoTexto: prazo === 1 ? '1 dia útil' : `${prazo} dias úteis`,
      };
    })
    .sort((a, b) => a.preco - b.preco);

  return {
    sucesso: true,
    cepOrigem,
    cepDestino,
    transportadoras,
  };
}

export interface PedidoEtiquetaMelhorEnvio {
  pedidoId: string | number;
  servicoId: number; // ID do serviço selecionado no cálculo (ex: 1=PAC, 2=SEDEX, 3=Jadlog Package)
  valorTotal: number;
  remetente?: {
    nome: string;
    telefone: string;
    email: string;
    documento: string; // CPF ou CNPJ
    endereco: string;
    numero: string;
    complemento?: string;
    bairro: string;
    cidade: string;
    estado: string;
    cep: string;
  };
  destinatario: {
    nome: string;
    telefone: string;
    email: string;
    documento?: string; // CPF/CNPJ do cliente
    endereco: string;
    numero: string;
    complemento?: string;
    bairro: string;
    cidade: string;
    estado: string;
    cep: string;
  };
  itens: Array<{
    nome: string;
    quantidade: number;
    valorUnitario: number;
    pesoKg?: number;
    alturaCm?: number;
    larguraCm?: number;
    comprimentoCm?: number;
  }>;
  notaFiscal?: {
    chave?: string;
  };
}

export interface CriarEtiquetaResult {
  sucesso: boolean;
  cartId: string;
  protocolo?: string;
  status?: string;
  preco?: number;
}

/**
 * Função auxiliar: insere o frete do pedido pago no carrinho do Melhor Envio (POST /api/v2/me/cart)
 * para posterior compra/emissão da etiqueta assim que o pagamento for confirmado.
 */
export async function criarEtiquetaMelhorEnvio(
  pedido: PedidoEtiquetaMelhorEnvio
): Promise<CriarEtiquetaResult> {
  const { token, apiBaseUrl, userAgent, fromPostalCode } = getMelhorEnvioConfig();

  const from = pedido.remetente || {
    nome: process.env.MELHOR_ENVIO_FROM_NAME || 'Street Store Itabira',
    telefone: process.env.MELHOR_ENVIO_FROM_PHONE || '31984806556',
    email: process.env.MELHOR_ENVIO_FROM_EMAIL || 'streetstore364@gmail.com',
    documento: (process.env.MELHOR_ENVIO_FROM_DOCUMENT || '45892109000132').replace(/\D/g, ''),
    endereco: process.env.MELHOR_ENVIO_FROM_STREET || 'Avenida João Pinheiro',
    numero: process.env.MELHOR_ENVIO_FROM_NUMBER || '353',
    complemento: process.env.MELHOR_ENVIO_FROM_COMPLEMENT || '',
    bairro: process.env.MELHOR_ENVIO_FROM_DISTRICT || 'Centro',
    cidade: process.env.MELHOR_ENVIO_FROM_CITY || 'Itabira',
    estado: process.env.MELHOR_ENVIO_FROM_STATE || 'MG',
    cep: fromPostalCode,
  };

  const totalPeso = Math.max(
    0.35,
    pedido.itens.reduce((acc, item) => acc + (item.pesoKg ?? 0.35) * Math.max(1, item.quantidade), 0)
  );
  const maxAltura = Math.max(
    10,
    pedido.itens.reduce((acc, item) => acc + (item.alturaCm ?? 5) * Math.max(1, item.quantidade), 0)
  );
  const maxLargura = Math.max(24, ...pedido.itens.map((i) => i.larguraCm ?? 26));
  const maxComprimento = Math.max(30, ...pedido.itens.map((i) => i.comprimentoCm ?? 30));

  const cartPayload = {
    service: pedido.servicoId,
    from: {
      name: from.nome,
      phone: from.telefone.replace(/\D/g, ''),
      email: from.email,
      document: from.documento.replace(/\D/g, ''),
      address: from.endereco,
      number: from.numero,
      complement: from.complemento || '',
      district: from.bairro,
      city: from.cidade,
      state_abbr: from.estado.slice(0, 2).toUpperCase(),
      country_id: 'BR',
      postal_code: sanitizeCep(from.cep),
    },
    to: {
      name: pedido.destinatario.nome,
      phone: pedido.destinatario.telefone.replace(/\D/g, ''),
      email: pedido.destinatario.email,
      document: pedido.destinatario.documento ? pedido.destinatario.documento.replace(/\D/g, '') : undefined,
      address: pedido.destinatario.endereco,
      number: pedido.destinatario.numero || 'S/N',
      complement: pedido.destinatario.complemento || '',
      district: pedido.destinatario.bairro,
      city: pedido.destinatario.cidade,
      state_abbr: pedido.destinatario.estado.slice(0, 2).toUpperCase(),
      country_id: 'BR',
      postal_code: sanitizeCep(pedido.destinatario.cep),
    },
    products: pedido.itens.map((item) => ({
      name: item.nome,
      quantity: Math.max(1, item.quantidade),
      unitary_value: Number(item.valorUnitario),
    })),
    volumes: [
      {
        height: Math.min(100, Math.round(maxAltura)),
        width: Math.min(100, Math.round(maxLargura)),
        length: Math.min(100, Math.round(maxComprimento)),
        weight: Number(totalPeso.toFixed(3)),
      },
    ],
    options: {
      insurance_value: Math.max(20, Number(pedido.valorTotal)),
      receipt: false,
      own_hand: false,
      reverse: false,
      non_commercial: !pedido.notaFiscal?.chave,
      invoice: pedido.notaFiscal?.chave ? { key: pedido.notaFiscal.chave } : undefined,
      platform: 'Street Store',
      tags: [{ tag: `Pedido #${pedido.pedidoId}`, url: '' }],
    },
  };

  const response = await fetch(`${apiBaseUrl}/me/cart`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
    },
    body: JSON.stringify(cartPayload),
  });

  const rawText = await response.text();
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Resposta inválida ao inserir etiqueta no Melhor Envio [${response.status}]: ${rawText}`);
  }

  if (!response.ok || !data?.id) {
    const errMsg = data?.message || JSON.stringify(data?.errors || data || rawText);
    throw new Error(`Falha ao criar etiqueta no carrinho Melhor Envio [${response.status}]: ${errMsg}`);
  }

  return {
    sucesso: true,
    cartId: String(data.id),
    protocolo: data.protocol ? String(data.protocol) : undefined,
    status: data.status ? String(data.status) : undefined,
    preco: data.price !== undefined ? Number(data.price) : undefined,
  };
}
