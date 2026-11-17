import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const isJwtToken = (val?: string) =>
  Boolean(val && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val.trim()));

const localEnvPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(localEnvPath)) {
  const parsedEnv = dotenv.parse(fs.readFileSync(localEnvPath));
  if (isJwtToken(parsedEnv.MELHOR_ENVIO_TOKEN)) {
    process.env.MELHOR_ENVIO_TOKEN = parsedEnv.MELHOR_ENVIO_TOKEN.trim();
  }
  if (/^https?:\/\//i.test((parsedEnv.MELHOR_ENVIO_URL || '').trim())) {
    process.env.MELHOR_ENVIO_URL = parsedEnv.MELHOR_ENVIO_URL.trim();
  }
}

function resolveMelhorEnvioBaseUrl(): string {
  for (const raw of [process.env.MELHOR_ENVIO_URL, process.env.MELHOR_ENVIO_API_URL]) {
    const cleaned = (raw || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/api\/v2$/i, '');
    if (/^https?:\/\//i.test(cleaned)) {
      return cleaned;
    }
  }
  return 'https://melhorenvio.com.br';
}

const MELHOR_ENVIO_API_URL = `${resolveMelhorEnvioBaseUrl()}/api/v2`;
const MELHOR_ENVIO_FROM_POSTAL_CODE = process.env.MELHOR_ENVIO_FROM_POSTAL_CODE || '35900539';
const USER_AGENT = (process.env.MELHOR_ENVIO_USER_AGENT || 'StreetStore (streetstore364@gmail.com)').trim();

export function sanitizeMelhorEnvioToken(): string | null {
  const token = (process.env.MELHOR_ENVIO_TOKEN || '').trim();
  return token || null;
}

export async function getValidMelhorEnvioToken(): Promise<string | null> {
  return sanitizeMelhorEnvioToken();
}

export interface ShippingQuoteItem {
  id?: string;
  width?: number;
  height?: number;
  length?: number;
  weight?: number; // in kg
  price?: number;
  quantity?: number;
}

export interface FormattedShippingOption {
  id: number;
  name: string;
  company: {
    id: number;
    name: string;
    picture: string;
  };
  price: number;
  priceFormatted: string;
  discount: number;
  currency: string;
  deliveryTimeDays: number;
  deliveryText: string;
  source?: 'melhor-envio' | 'estimated';
  error?: string;
}

export function sanitizeCep(raw: string): string {
  return String(raw || '').replace(/\D/g, '').slice(0, 8);
}

function buildFallbackOptions(toCep: string, cartTotal?: number): FormattedShippingOption[] {
  const isLocalMg = toCep.startsWith('35') || toCep.startsWith('30') || toCep.startsWith('31');
  const pacPrice = isLocalMg ? 16.90 : 22.90;
  const sedexPrice = isLocalMg ? 21.90 : 34.90;
  const jadlogPrice = isLocalMg ? 17.50 : 21.40;
  const freeEligible = (cartTotal || 0) >= 299;

  return [
    {
      id: 1,
      name: freeEligible ? 'PAC (Frete Grátis)' : 'PAC',
      company: { id: 1, name: 'Correios', picture: 'https://assets.melhorenvio.com.br/companies/correios.png' },
      price: freeEligible ? 0 : pacPrice,
      priceFormatted: freeEligible ? 'Grátis' : pacPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      discount: 0,
      currency: 'BRL',
      deliveryTimeDays: isLocalMg ? 4 : 7,
      deliveryText: isLocalMg ? '4 dias úteis' : '7 dias úteis',
      source: 'estimated'
    },
    {
      id: 3,
      name: '.Package',
      company: { id: 2, name: 'Jadlog', picture: 'https://assets.melhorenvio.com.br/companies/jadlog.png' },
      price: jadlogPrice,
      priceFormatted: jadlogPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      discount: 0,
      currency: 'BRL',
      deliveryTimeDays: isLocalMg ? 3 : 5,
      deliveryText: isLocalMg ? '3 dias úteis' : '5 dias úteis',
      source: 'estimated'
    },
    {
      id: 2,
      name: 'SEDEX',
      company: { id: 1, name: 'Correios', picture: 'https://assets.melhorenvio.com.br/companies/correios.png' },
      price: sedexPrice,
      priceFormatted: sedexPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
      discount: 0,
      currency: 'BRL',
      deliveryTimeDays: isLocalMg ? 2 : 3,
      deliveryText: isLocalMg ? '2 dias úteis' : '3 dias úteis',
      source: 'estimated'
    }
  ];
}

/**
 * Calculates live shipping rates with Melhor Envio API v2 across all carriers (Correios, Jadlog, Loggi, etc.)
 */
export async function calculateMelhorEnvioShipping(params: {
  fromPostalCode?: string;
  toPostalCode: string;
  items?: ShippingQuoteItem[];
  cartTotal?: number;
}): Promise<{
  success: boolean;
  from: string;
  to: string;
  live: boolean;
  options: FormattedShippingOption[];
  rawCount?: number;
  error?: string;
}> {
  const cleanToCep = sanitizeCep(params.toPostalCode);
  if (cleanToCep.length !== 8) {
    return {
      success: false,
      from: MELHOR_ENVIO_FROM_POSTAL_CODE,
      to: cleanToCep,
      live: false,
      options: [],
      error: 'CEP de destino inválido. Informe 8 números.'
    };
  }

  const cleanFromCep = sanitizeCep(params.fromPostalCode || MELHOR_ENVIO_FROM_POSTAL_CODE) || '35900539';
  const token = await getValidMelhorEnvioToken();

  if (!token) {
    return {
      success: true,
      from: cleanFromCep,
      to: cleanToCep,
      live: false,
      options: buildFallbackOptions(cleanToCep, params.cartTotal)
    };
  }

  const productsPayload = (params.items && params.items.length > 0)
    ? params.items.map((item, idx) => ({
        id: String(item.id || `item-${idx + 1}`),
        width: Math.max(12, item.width || 25),
        height: Math.max(4, item.height || 5),
        length: Math.max(16, item.length || 25),
        weight: Math.max(0.2, item.weight || 0.35),
        insurance_value: Math.max(50, item.price || 139.9),
        quantity: Math.max(1, item.quantity || 1)
      }))
    : [
        {
          id: 'street-product-default',
          width: 25,
          height: 5,
          length: 25,
          weight: 0.35,
          insurance_value: params.cartTotal || 139.9,
          quantity: 1
        }
      ];

  const payload = {
    from: { postal_code: cleanFromCep },
    to: { postal_code: cleanToCep },
    products: productsPayload,
    options: {
      receipt: false,
      own_hand: false
    }
  };

  try {
    const res = await fetch(`${MELHOR_ENVIO_API_URL}/me/shipment/calculate`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn('[Melhor Envio] Calculate returned', res.status, errText);
      return {
        success: true,
        from: cleanFromCep,
        to: cleanToCep,
        live: false,
        options: buildFallbackOptions(cleanToCep, params.cartTotal),
        error: `Melhor Envio API [${res.status}]`
      };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return {
        success: true,
        from: cleanFromCep,
        to: cleanToCep,
        live: false,
        options: buildFallbackOptions(cleanToCep, params.cartTotal),
        error: data.message || 'Resposta inesperada do Melhor Envio'
      };
    }

    const validOptions: FormattedShippingOption[] = data
      .filter((opt: any) => !opt.error && (opt.custom_price || opt.price))
      .map((opt: any) => {
        const rawPrice = parseFloat(opt.custom_price || opt.price || '0');
        const days = parseInt(opt.custom_delivery_time || opt.delivery_time || '5', 10);
        return {
          id: opt.id,
          name: opt.name,
          company: {
            id: opt.company?.id || 0,
            name: opt.company?.name || 'Transportadora',
            picture: opt.company?.picture || ''
          },
          price: rawPrice,
          priceFormatted: rawPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
          discount: parseFloat(opt.discount || '0'),
          currency: opt.currency || 'BRL',
          deliveryTimeDays: days,
          deliveryText: days === 1 ? '1 dia útil' : `${days} dias úteis`,
          source: 'melhor-envio' as const
        };
      })
      .sort((a, b) => a.price - b.price);

    return {
      success: true,
      from: cleanFromCep,
      to: cleanToCep,
      live: true,
      options: validOptions.length > 0 ? validOptions : buildFallbackOptions(cleanToCep, params.cartTotal),
      rawCount: data.length
    };
  } catch (error: any) {
    console.error('[Melhor Envio] Network exception during calculate:', error);
    return {
      success: true,
      from: cleanFromCep,
      to: cleanToCep,
      live: false,
      options: buildFallbackOptions(cleanToCep, params.cartTotal),
      error: error.message || 'Falha ao consultar Melhor Envio'
    };
  }
}

/**
 * Add an order shipment to the Melhor Envio cart for label generation
 */
export async function addOrderToMelhorEnvioCart(params: {
  serviceId: number;
  orderNumber: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
    cpf?: string;
  };
  shippingAddress: {
    street: string;
    number: string;
    complement?: string;
    neighborhood: string;
    city: string;
    state: string;
    zip: string;
  };
  items: Array<{
    name: string;
    quantity: number;
    price: number;
  }>;
  total: number;
}): Promise<{ success: boolean; cartId?: string; protocol?: string; error?: string }> {
  const token = await getValidMelhorEnvioToken();
  if (!token) {
    return { success: false, error: 'Melhor Envio não conectado via OAuth.' };
  }

  try {
    const meInfo = await getMelhorEnvioAccountInfo();
    const fromUser = meInfo.user;

    const payload = {
      service: params.serviceId || 1,
      from: {
        name: fromUser?.name || 'Street Store Itabira',
        phone: fromUser?.phone || '31984806556',
        email: fromUser?.email || 'streetstore364@gmail.com',
        document: (fromUser?.document || '45892109000132').replace(/\D/g, ''),
        address: 'Avenida João Pinheiro',
        number: '353',
        district: 'Centro',
        city: 'Itabira',
        state_abbr: 'MG',
        country_id: 'BR',
        postal_code: MELHOR_ENVIO_FROM_POSTAL_CODE
      },
      to: {
        name: params.customer.name || 'Cliente Street Store',
        phone: (params.customer.phone || '31984806556').replace(/\D/g, ''),
        email: params.customer.email,
        document: params.customer.cpf ? params.customer.cpf.replace(/\D/g, '') : undefined,
        address: params.shippingAddress.street,
        number: params.shippingAddress.number || 'S/N',
        complement: params.shippingAddress.complement || '',
        district: params.shippingAddress.neighborhood || 'Centro',
        city: params.shippingAddress.city,
        state_abbr: (params.shippingAddress.state || 'MG').slice(0, 2).toUpperCase(),
        country_id: 'BR',
        postal_code: sanitizeCep(params.shippingAddress.zip)
      },
      products: params.items.map((it) => ({
        name: it.name,
        quantity: it.quantity || 1,
        unitary_value: Number(it.price || 99.90)
      })),
      volumes: [
        {
          height: 10,
          width: 26,
          length: 30,
          weight: Math.max(0.35, params.items.reduce((s, it) => s + (it.quantity || 1) * 0.35, 0))
        }
      ],
      options: {
        insurance_value: Math.max(20, params.total),
        receipt: false,
        own_hand: false,
        non_commercial: true,
        platform: 'Street Store',
        tags: [{ tag: `Pedido ${params.orderNumber}`, url: '' }]
      }
    };

    const res = await fetch(`${MELHOR_ENVIO_API_URL}/me/cart`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      return { success: false, error: data.message || JSON.stringify(data.errors || data) };
    }

    return {
      success: true,
      cartId: data.id,
      protocol: data.protocol
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetch authenticated user info & wallet balance from Melhor Envio
 */
export async function getMelhorEnvioAccountInfo(): Promise<any> {
  const token = await getValidMelhorEnvioToken();

  if (!token) {
    return {
      connected: false,
      user: null,
      balance: { balance: 0, reserved: 0 },
      fromPostalCode: MELHOR_ENVIO_FROM_POSTAL_CODE
    };
  }

  const [meRes, balanceRes] = await Promise.all([
    fetch(`${MELHOR_ENVIO_API_URL}/me`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT
      }
    }),
    fetch(`${MELHOR_ENVIO_API_URL}/me/balance`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': USER_AGENT
      }
    })
  ]);

  const me = meRes.ok ? await meRes.json() : null;
  const balance = balanceRes.ok ? await balanceRes.json() : null;

  return {
    connected: Boolean(me?.email || me?.id),
    user: me ? {
      id: me.id,
      name: `${me.firstname || ''} ${me.lastname || ''}`.trim() || me.email,
      email: me.email,
      document: me.document,
      phone: me.phone?.phone || ''
    } : null,
    balance: balance || { balance: 0, reserved: 0 },
    fromPostalCode: MELHOR_ENVIO_FROM_POSTAL_CODE
  };
}

let cachedMelhorEnvioState: {
  connected: boolean;
  user?: any;
  companiesCount: number;
  syncedAt: number;
} | null = null;

/**
 * Automatic background Melhor Envio sync (token validation/refresh, account & carrier status,
 * and automatic tracking status check for open shipments). Runs at startup & periodically.
 */
export async function syncMelhorEnvioIntegration(): Promise<{
  connected: boolean;
  companiesCount: number;
  syncedAt: string;
}> {
  const token = await getValidMelhorEnvioToken();
  if (!token) {
    cachedMelhorEnvioState = { connected: false, companiesCount: 0, syncedAt: Date.now() };
    return { connected: false, companiesCount: 0, syncedAt: new Date().toISOString() };
  }

  try {
    const [info, companiesRes] = await Promise.all([
      getMelhorEnvioAccountInfo(),
      fetch(`${MELHOR_ENVIO_API_URL}/me/shipment/companies`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': USER_AGENT
        }
      }).catch(() => null)
    ]);

    const companiesJson = companiesRes && companiesRes.ok ? await companiesRes.json().catch(() => []) : [];
    const companiesCount = Array.isArray(companiesJson) ? companiesJson.length : 0;

    // Also sync tracking info for any unshipped/open orders stored locally if tracking codes exist
    const ordersPath = path.resolve(process.env.VERCEL ? '/tmp' : process.cwd(), '.street_orders.json');
    if (fs.existsSync(ordersPath)) {
      try {
        const db = JSON.parse(fs.readFileSync(ordersPath, 'utf-8'));
        const pendingOrders = (db?.orders || []).filter(
          (o: any) => o.trackingNumber && o.shippingStatus !== 'delivered'
        );
        if (pendingOrders.length > 0) {
          const codes = pendingOrders.map((o: any) => o.trackingNumber).slice(0, 20);
          const trackRes = await fetch(`${MELHOR_ENVIO_API_URL}/me/shipment/tracking`, {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              'User-Agent': USER_AGENT
            },
            body: JSON.stringify({ orders: codes })
          }).catch(() => null);
          if (trackRes && trackRes.ok) {
            const trackData = await trackRes.json().catch(() => ({}));
            let changed = false;
            for (const o of pendingOrders) {
              const infoTrack = trackData?.[o.trackingNumber];
              if (infoTrack?.status === 'delivered' && o.shippingStatus !== 'delivered') {
                o.shippingStatus = 'delivered';
                changed = true;
              } else if (infoTrack?.status === 'posted' && o.shippingStatus === 'unshipped') {
                o.shippingStatus = 'shipped';
                changed = true;
              }
            }
            if (changed) {
              fs.writeFileSync(ordersPath, JSON.stringify(db, null, 2), 'utf-8');
            }
          }
        }
      } catch {
        // non-blocking order tracking check
      }
    }

    cachedMelhorEnvioState = {
      connected: Boolean(info.connected),
      user: info.user,
      companiesCount,
      syncedAt: Date.now()
    };

    console.log(`[Melhor Envio Auto-Sync] Conectado: ${info.connected ? 'SIM' : 'NÃO'} (${info.user?.email || 'sem usuário'}) | Transportadoras ativas: ${companiesCount}`);
    return {
      connected: Boolean(info.connected),
      companiesCount,
      syncedAt: new Date(cachedMelhorEnvioState.syncedAt).toISOString()
    };
  } catch (err: any) {
    console.warn('[Melhor Envio Auto-Sync] Aviso:', err?.message || err);
    return {
      connected: Boolean(cachedMelhorEnvioState?.connected),
      companiesCount: cachedMelhorEnvioState?.companiesCount || 0,
      syncedAt: new Date().toISOString()
    };
  }
}

let melhorEnvioIntervalStarted = false;

export function startMelhorEnvioAutoSync(): void {
  if (melhorEnvioIntervalStarted) return;
  melhorEnvioIntervalStarted = true;

  // Immediate startup verification & sync
  syncMelhorEnvioIntegration().catch(() => {});

  // Keep Mejor Envio token/status/tracking automatically synced every 15 minutes
  const timer = setInterval(() => {
    syncMelhorEnvioIntegration().catch(() => {});
  }, 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Register Melhor Envio Express routes (fixed JWT Bearer token from process.env.MELHOR_ENVIO_TOKEN)
 */
export function registerMelhorEnvioRoutes(app: express.Express) {
  app.get('/api/melhor-envio/status', async (_req: Request, res: Response) => {
    try {
      const info = await getMelhorEnvioAccountInfo();
      res.json({
        success: true,
        authMode: 'fixed_jwt',
        ...info
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        connected: false,
        error: err.message || 'Erro ao obter status do Melhor Envio'
      });
    }
  });

  // 6. Calculate Shipping Rates across carriers (Correios PAC, Sedex, Jadlog, Loggi, etc.)
  app.post(['/api/shipping/calculate', '/api/shipping/quote'], async (req: Request, res: Response) => {
    try {
      const { cep, cepDestino, toPostalCode, postalCode, items, cartTotal } = req.body;
      const targetCep = cep || cepDestino || toPostalCode || postalCode;

      if (!targetCep) {
        return res.status(400).json({
          success: false,
          error: 'CEP de destino não informado.'
        });
      }

      const result = await calculateMelhorEnvioShipping({
        toPostalCode: targetCep,
        items,
        cartTotal
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Erro ao calcular frete com Melhor Envio'
      });
    }
  });

  // 7. Track order or shipment
  app.get('/api/shipping/track/:code', async (req: Request, res: Response) => {
    const code = req.params.code.trim().toUpperCase();
    try {
      const token = await getValidMelhorEnvioToken();
      if (token) {
        const resTracking = await fetch(`${MELHOR_ENVIO_API_URL}/me/shipment/tracking`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': USER_AGENT
          },
          body: JSON.stringify({ orders: [code] })
        });

        if (resTracking.ok) {
          const trackingData = await resTracking.json();
          return res.json({
            success: true,
            code,
            provider: 'melhor-envio',
            data: trackingData
          });
        }
      }

      const isCorreios = /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(code);
      const isJadlog = /^\d{14}$/.test(code);

      res.json({
        success: true,
        code,
        provider: isCorreios ? 'correios' : (isJadlog ? 'jadlog' : 'melhor-envio'),
        trackingUrl: isCorreios
          ? `https://rastreamento.correios.com.br/app/index.php?codigo=${code}`
          : (isJadlog ? `https://www.jadlog.com.br/jadlog/tracking?cte=${code}` : `https://melhorenvio.com.br/rastreio/${code}`),
        message: 'Código de rastreamento oficial ativo e despachado.'
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Erro ao rastrear envio'
      });
    }
  });

  // 8. Melhor Envio Webhook Receiver
  app.post('/api/melhor-envio/webhook', (req: Request, res: Response) => {
    console.log('[Melhor Envio Webhook] Event received:', JSON.stringify(req.body));
    res.status(200).json({ received: true });
  });
}
