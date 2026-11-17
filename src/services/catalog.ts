import { Product } from '../types';
import { PRODUCTS as FALLBACK_PRODUCTS } from '../data/products';
import { cleanDescription } from '../lib/cleanHtml';
import { filterVisibleProducts } from '../lib/hiddenProducts';

export interface TrackedOrderProduct {
  name: string;
  price: number;
  quantity: number;
  variant?: string;
  image?: string;
}

export interface TrackedOrder {
  orderNumber: string;
  orderId: number;
  status: 'open' | 'closed' | 'cancelled';
  paymentStatus: 'paid' | 'pending' | 'voided' | 'refunded';
  shippingStatus: 'unshipped' | 'shipped' | 'delivered' | 'unpacked';
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
 * Fetch live products from Bling ERP & official store catalog via backend proxy
 */
export async function getLiveCatalog(forceRefresh: boolean = false): Promise<{
  products: Product[];
  isLive: boolean;
  statusText: string;
  blingConnected?: boolean;
  blingCount?: number;
  blingError?: string | null;
}> {
  try {
    const url = forceRefresh
      ? `/api/catalog/products?refresh=true&_t=${Date.now()}`
      : '/api/catalog/products';

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
        blingConnected: Boolean(data.blingConnected),
        blingCount: Number(data.blingCount || 0),
        blingError: data.blingError || null,
        statusText: `Catálogo Oficial Ativo (${sanitizedProducts.length} peças em estoque)`,
      };
    }

    return {
      products: filterVisibleProducts(FALLBACK_PRODUCTS),
      isLive: false,
      blingConnected: false,
      blingCount: 0,
      blingError: data.blingError || null,
      statusText: 'Catálogo de Drops Street Store Oficial',
    };
  } catch (error) {
    console.warn('Usando catálogo local de reserva:', error);
    return {
      products: filterVisibleProducts(FALLBACK_PRODUCTS),
      isLive: false,
      blingConnected: false,
      blingCount: 0,
      blingError: null,
      statusText: 'Catálogo de Drops Street Store Oficial',
    };
  }
}

/**
 * Track an order via Store Order Engine / Bling ERP & Melhor Envio
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
      error: error.message || 'Falha ao buscar pedido no sistema de rastreamento'
    };
  }
}

/**
 * Request exchange or return for an order (Melhor Envio Logística Reversa)
 */
export async function requestOrderReturn(params: {
  orderId: number;
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
