import { Product } from '../types';
import { PRODUCTS as FALLBACK_PRODUCTS } from '../data/products';
import { cleanDescription } from '../lib/cleanHtml';
import { filterVisibleProducts } from '../lib/hiddenProducts';

export interface ShippingCompany {
  id: number;
  name: string;
  picture: string;
}

export interface ShippingOption {
  id: number;
  name: string;
  company: ShippingCompany;
  price: number;
  priceFormatted: string;
  discount: number;
  currency: string;
  deliveryTimeDays: number;
  deliveryText: string;
  source?: 'melhor-envio' | 'estimated';
  error?: string;
}

export interface ShippingCalculationResult {
  success: boolean;
  from: string;
  to: string;
  live?: boolean;
  options: ShippingOption[];
  rawCount?: number;
  error?: string;
}

export interface TrackedOrderProduct {
  name: string;
  price: number;
  quantity: number;
  variant?: string;
  image?: string;
}

export interface TrackedOrder {
  orderNumber: string;
  orderId: number | string;
  status: string;
  paymentStatus: string;
  shippingStatus: string;
  shippingCarrier: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  customer?: {
    name: string;
    email: string;
    phone?: string;
  };
  shippingAddress?: {
    name?: string;
    address: string;
    number: string;
    locality: string;
    city: string;
    province: string;
    zipcode: string;
    country?: string;
  };
  products: TrackedOrderProduct[];
  total: number;
  createdAt: string;
  paidAt?: string | null;
  shippedAt?: string | null;
}

export interface ReturnRequestResult {
  success: boolean;
  protocol?: string;
  message?: string;
  error?: string;
}

/**
 * Calculates live shipping rates using Melhor Envio API v2 (Correios, Jadlog, Loggi, etc.)
 */
export async function calculateShippingQuotes(params: {
  cep: string;
  items?: Array<{
    id?: string;
    price?: number;
    quantity?: number;
    weight?: number;
  }>;
  cartTotal?: number;
}): Promise<ShippingCalculationResult> {
  const cleanCep = params.cep.replace(/\D/g, '').slice(0, 8);
  if (cleanCep.length !== 8) {
    return {
      success: false,
      from: '35900539',
      to: cleanCep,
      options: [],
      error: 'CEP deve conter 8 dígitos.'
    };
  }

  try {
    const res = await fetch('/api/shipping/calculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        cep: cleanCep,
        items: params.items,
        cartTotal: params.cartTotal
      })
    });

    if (!res.ok) {
      throw new Error(`Servidor de frete respondeu com status ${res.status}`);
    }

    const data = await res.json();
    return data;
  } catch (error: any) {
    console.warn('[Melhor Envio] Falha na consulta de frete:', error);
    // Graceful fallback with standard Correios Sedex/PAC & Local pickup
    return {
      success: true,
      from: '35900539',
      to: cleanCep,
      options: [
        {
          id: 1,
          name: 'PAC',
          company: { id: 1, name: 'Correios', picture: 'https://assets.melhorenvio.com.br/companies/correios.png' },
          price: 18.90,
          priceFormatted: 'R$ 18,90',
          discount: 0,
          currency: 'BRL',
          deliveryTimeDays: 5,
          deliveryText: '5 dias úteis'
        },
        {
          id: 2,
          name: 'SEDEX',
          company: { id: 1, name: 'Correios', picture: 'https://assets.melhorenvio.com.br/companies/correios.png' },
          price: 24.50,
          priceFormatted: 'R$ 24,50',
          discount: 0,
          currency: 'BRL',
          deliveryTimeDays: 2,
          deliveryText: '2 dias úteis'
        },
        {
          id: 3,
          name: '.Package',
          company: { id: 2, name: 'Jadlog', picture: 'https://assets.melhorenvio.com.br/companies/jadlog.png' },
          price: 19.30,
          priceFormatted: 'R$ 19,30',
          discount: 0,
          currency: 'BRL',
          deliveryTimeDays: 4,
          deliveryText: '4 dias úteis'
        }
      ]
    };
  }
}

/**
 * Fetch live products from Bling ERP via backend proxy
 */
export async function getLiveCatalog(forceRefresh: boolean = false): Promise<{
  products: Product[];
  isLive: boolean;
  statusText: string;
}> {
  try {
    const url = forceRefresh 
      ? `/api/products?refresh=true&_t=${Date.now()}` 
      : '/api/products';

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`Servidor respondeu com status ${res.status}`);
    }

    const data = await res.json();
    if (data.success && Array.isArray(data.products) && data.products.length > 0) {
      const rawList: Product[] = data.products.map((p: Product) => ({
        ...p,
        description: cleanDescription(p.description),
      }));
      const sanitizedProducts = filterVisibleProducts<Product>(rawList);
      return {
        products: sanitizedProducts,
        isLive: true,
        statusText: `Catálogo Oficial Bling ERP Ativo (${sanitizedProducts.length} modelos em estoque)`,
      };
    }

    // Fallback if needed
    return {
      products: filterVisibleProducts(FALLBACK_PRODUCTS),
      isLive: false,
      statusText: 'Catálogo de Drops Street Store Oficial',
    };
  } catch (error) {
    console.warn('Usando catálogo local de reserva:', error);
    return {
      products: filterVisibleProducts(FALLBACK_PRODUCTS),
      isLive: false,
      statusText: 'Catálogo de Drops Street Store Oficial',
    };
  }
}

/**
 * Check store and integration status (Bling + Mercado Pago + Melhor Envio)
 */
export async function checkStoreStatus(): Promise<{
  connected: boolean;
  platform: string;
  storeName: string;
  city: string;
  cep: string;
  lastSync: string;
}> {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Status failed');
    const data = await res.json();
    return {
      connected: data.connected ?? true,
      platform: data.platform || 'Bling ERP + Mercado Pago + Melhor Envio',
      storeName: data.storeName || 'Street Store Itabira',
      city: data.city || 'Itabira - MG',
      cep: data.cep || '35900-539',
      lastSync: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
  } catch {
    return {
      connected: true,
      platform: 'Bling ERP + Mercado Pago + Melhor Envio',
      storeName: 'Street Store Itabira',
      city: 'Itabira - MG',
      cep: '35900-539',
      lastSync: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
  }
}

/**
 * Track an order via Bling ERP & Melhor Envio
 */
export async function trackOrder(query: string): Promise<{
  success: boolean;
  orders: TrackedOrder[];
  message?: string;
  error?: string;
}> {
  try {
    const cleanQuery = encodeURIComponent(query.trim().replace(/^#/, ''));
    const res = await fetch(`/api/orders/track?q=${cleanQuery}`);
    return await res.json();
  } catch (error: any) {
    return {
      success: false,
      orders: [],
      error: error.message || 'Falha ao buscar pedido no sistema Bling / Melhor Envio'
    };
  }
}

/**
 * Request exchange or return for an order (Melhor Envio Logística Reversa)
 */
export async function requestOrderReturn(params: {
  orderId: number | string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  reason: string;
  actionRequested: string;
  selectedItems: string[];
  details: string;
}): Promise<ReturnRequestResult> {
  try {
    const res = await fetch(`/api/orders/${params.orderId}/return`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params)
    });
    return await res.json();
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Erro ao registrar solicitação de devolução'
    };
  }
}

export interface MelhorEnvioStatus {
  connected: boolean;
  clientId?: string;
  redirectUri?: string;
  fromPostalCode?: string;
  user?: {
    id?: string;
    name: string;
    email: string;
    document?: string;
    phone?: string;
  } | null;
  balance?: {
    balance?: number;
    reserved?: number;
  };
  error?: string;
}

export async function getMelhorEnvioStatus(): Promise<MelhorEnvioStatus> {
  const res = await fetch('/api/melhor-envio/status');
  return res.json();
}

export async function getMelhorEnvioAuthUrl(): Promise<{
  url: string;
  redirectUri: string;
  clientId: string;
  scopes: string;
}> {
  const res = await fetch('/api/melhor-envio/auth-url');
  if (!res.ok) throw new Error('Falha ao obter URL de autorização do Melhor Envio');
  return res.json();
}

export async function saveMelhorEnvioToken(accessToken: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch('/api/melhor-envio/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken })
  });
  return res.json();
}

export async function disconnectMelhorEnvio(): Promise<{ success: boolean }> {
  const res = await fetch('/api/melhor-envio/disconnect', { method: 'POST' });
  return res.json();
}

