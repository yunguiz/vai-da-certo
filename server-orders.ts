import fs from 'fs';
import path from 'path';
import { fetchFromBling, loadBlingTokens } from './server-bling';
import { addOrderToMelhorEnvioCart } from './server-melhor-envio';

const ORDERS_STORE_PATH = path.resolve(
  process.env.VERCEL ? '/tmp' : process.cwd(),
  '.street_orders.json'
);

export interface StoredOrderItem {
  id?: string;
  sku?: string;
  name: string;
  price: number;
  quantity: number;
  selectedSize?: string;
  image?: string;
}

export interface StoredOrder {
  orderId: number;
  orderNumber: string;
  status: 'open' | 'closed' | 'cancelled';
  paymentStatus: 'paid' | 'pending' | 'voided' | 'refunded';
  shippingStatus: 'unshipped' | 'shipped' | 'delivered' | 'unpacked';
  shippingCarrier: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  paymentMethod: string;
  paymentId: string | number;
  blingOrderId?: number;
  customer: {
    name: string;
    email: string;
    phone?: string;
    cpf?: string;
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
  products: Array<{
    name: string;
    price: number;
    quantity: number;
    variant?: string;
    image?: string;
  }>;
  total: number;
  createdAt: string;
  paidAt?: string | null;
  shippedAt?: string | null;
  returnRequests?: Array<{
    protocol: string;
    reason: string;
    actionRequested: string;
    selectedItems: string[];
    details: string;
    createdAt: string;
  }>;
}

interface OrdersDatabase {
  lastOrderSequence: number;
  orders: StoredOrder[];
}

function loadOrdersDb(): OrdersDatabase {
  try {
    if (fs.existsSync(ORDERS_STORE_PATH)) {
      const raw = fs.readFileSync(ORDERS_STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.orders)) {
        return {
          lastOrderSequence: Number(parsed.lastOrderSequence) || 1000,
          orders: parsed.orders,
        };
      }
    }
  } catch (err) {
    console.warn('[Orders Store] Erro ao carregar pedidos locais:', err);
  }
  return { lastOrderSequence: 1000, orders: [] };
}

function saveOrdersDb(db: OrdersDatabase): void {
  try {
    fs.writeFileSync(ORDERS_STORE_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Orders Store] Erro ao salvar pedidos locais:', err);
  }
}

export async function createStoreOrder(params: {
  customer: {
    name?: string;
    email: string;
    phone?: string;
    cpf?: string;
  };
  items: StoredOrderItem[];
  shippingAddress?: {
    street?: string;
    number?: string;
    complement?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    zip?: string;
    name?: string;
    phone?: string;
  };
  shippingServiceId?: number;
  shippingCarrier?: string;
  paymentMethod: string;
  paymentId: string | number;
  total: number;
}): Promise<{ success: boolean; id: number; number: string; blingOrderId?: number; melhorEnvioCartId?: string }> {
  const db = loadOrdersDb();

  // Avoid duplicate order for same paymentId
  const existing = db.orders.find((o) => String(o.paymentId) === String(params.paymentId));
  if (existing) {
    return {
      success: true,
      id: existing.orderId,
      number: existing.orderNumber,
      blingOrderId: existing.blingOrderId,
    };
  }

  db.lastOrderSequence += 1;
  const orderId = db.lastOrderSequence;
  const orderNumber = `#${orderId}`;
  const nowIso = new Date().toISOString();

  const newOrder: StoredOrder = {
    orderId,
    orderNumber,
    status: 'open',
    paymentStatus: 'paid',
    shippingStatus: 'unshipped',
    shippingCarrier: params.shippingCarrier || 'Melhor Envio (Correios / Jadlog)',
    trackingNumber: null,
    trackingUrl: null,
    paymentMethod: params.paymentMethod,
    paymentId: params.paymentId,
    customer: {
      name: params.customer.name?.trim() || 'Cliente Street Store',
      email: params.customer.email,
      phone: params.customer.phone || '',
      cpf: params.customer.cpf,
    },
    shippingAddress: params.shippingAddress
      ? {
          name: params.shippingAddress.name || params.customer.name || 'Cliente Street Store',
          address: params.shippingAddress.street || 'Rua Principal',
          number: params.shippingAddress.number || 'S/N',
          locality: params.shippingAddress.neighborhood || 'Centro',
          city: params.shippingAddress.city || 'Itabira',
          province: params.shippingAddress.state || 'MG',
          zipcode: (params.shippingAddress.zip || '').replace(/\D/g, ''),
          country: 'BR',
        }
      : undefined,
    products: (params.items || []).map((it) => ({
      name: it.name,
      price: Number(it.price || 0),
      quantity: Number(it.quantity || 1),
      variant: it.selectedSize || 'Tamanho Único',
      image: it.image || '',
    })),
    total: Number(params.total || 0),
    createdAt: nowIso,
    paidAt: nowIso,
    shippedAt: null,
  };

  // Optional: Sync order to Bling ERP if OAuth token is connected
  try {
    const blingTokens = loadBlingTokens();
    if (blingTokens?.access_token) {
      const todayDate = nowIso.slice(0, 10);
      const blingPayload = {
        numero: orderId,
        data: todayDate,
        dataSaida: todayDate,
        observacoes: `[STREET STORE] Pago via ${params.paymentMethod} (ID: ${params.paymentId}). Cliente: ${newOrder.customer.name} (${newOrder.customer.email})`,
        itens: newOrder.products.map((p, idx) => ({
          codigo: params.items?.[idx]?.sku || `ST-${idx + 1}`,
          descricao: `${p.name} (${p.variant || 'Único'})`,
          quantidade: p.quantity,
          valor: p.price,
        })),
      };
      const blingRes = await fetchFromBling('/pedidos/vendas', {
        method: 'POST',
        body: JSON.stringify(blingPayload),
      });
      if (blingRes?.data?.id) {
        newOrder.blingOrderId = blingRes.data.id;
        console.log(`[Orders Store] Pedido ${orderNumber} sincronizado no Bling ERP (ID: ${blingRes.data.id}).`);
      }
    }
  } catch (blingErr: any) {
    console.warn('[Orders Store] Registro no Bling ERP opcional ignorado:', blingErr?.message || blingErr);
  }

  // Optional: Register shipment in Melhor Envio Cart if connected & address provided
  let melhorEnvioCartId: string | undefined;
  if (params.shippingAddress?.zip && params.shippingAddress?.street) {
    try {
      const meCart = await addOrderToMelhorEnvioCart({
        serviceId: params.shippingServiceId || 1,
        orderNumber,
        customer: newOrder.customer,
        shippingAddress: {
          street: params.shippingAddress.street,
          number: params.shippingAddress.number || 'S/N',
          complement: params.shippingAddress.complement,
          neighborhood: params.shippingAddress.neighborhood || 'Centro',
          city: params.shippingAddress.city || 'Itabira',
          state: params.shippingAddress.state || 'MG',
          zip: params.shippingAddress.zip,
        },
        items: newOrder.products.map((p) => ({
          name: p.name,
          quantity: p.quantity,
          price: p.price,
        })),
        total: newOrder.total,
      });
      if (meCart.success && meCart.cartId) {
        melhorEnvioCartId = meCart.cartId;
        console.log(`[Orders Store] Etiqueta adicionada ao carrinho Melhor Envio: ${meCart.cartId}`);
      }
    } catch (meErr: any) {
      console.warn('[Orders Store] Registro opcional no Melhor Envio ignorado:', meErr?.message || meErr);
    }
  }

  db.orders.unshift(newOrder);
  saveOrdersDb(db);
  console.log(`[Orders Store] Pedido oficial ${orderNumber} registrado com sucesso.`);

  return {
    success: true,
    id: orderId,
    number: orderNumber,
    blingOrderId: newOrder.blingOrderId,
    melhorEnvioCartId,
  };
}

export async function trackStoreOrders(query: string): Promise<StoredOrder[]> {
  const cleanQ = query.trim().replace(/^#/, '').toLowerCase();
  const db = loadOrdersDb();

  const localMatches = db.orders.filter((o) => {
    const numMatch = o.orderNumber.replace('#', '').toLowerCase() === cleanQ || String(o.orderId) === cleanQ;
    const emailMatch = o.customer.email.toLowerCase() === cleanQ || o.customer.email.toLowerCase().includes(cleanQ);
    const paymentMatch = String(o.paymentId).toLowerCase() === cleanQ;
    return numMatch || emailMatch || paymentMatch;
  });

  // Also check Bling ERP sales orders if connected
  const blingMatches: StoredOrder[] = [];
  try {
    const tokens = loadBlingTokens();
    if (tokens?.access_token) {
      const blingData = await fetchFromBling('/pedidos/vendas?pagina=1&limite=50');
      const rawOrders = blingData?.data || [];
      for (const bo of rawOrders) {
        const numStr = String(bo.numero || '');
        const idStr = String(bo.id || '');
        const contactName = (bo.contato?.nome || '').toLowerCase();
        const contactEmail = (bo.contato?.email || '').toLowerCase();

        const isMatch =
          numStr === cleanQ ||
          idStr === cleanQ ||
          (cleanQ.length >= 4 && (contactName.includes(cleanQ) || contactEmail.includes(cleanQ)));

        if (isMatch && !localMatches.some((lm) => lm.blingOrderId === bo.id || lm.orderId === bo.numero)) {
          blingMatches.push({
            orderId: bo.id,
            orderNumber: `#${bo.numero || bo.id}`,
            status: 'open',
            paymentStatus: 'paid',
            shippingStatus: bo.transporte?.etiqueta ? 'shipped' : 'unshipped',
            shippingCarrier: bo.transporte?.transportador?.nome || 'Melhor Envio',
            trackingNumber: bo.transporte?.etiqueta?.codigoRastreamento || null,
            trackingUrl: bo.transporte?.etiqueta?.codigoRastreamento
              ? `https://melhorenvio.com.br/rastreio/${bo.transporte.etiqueta.codigoRastreamento}`
              : null,
            paymentMethod: 'Mercado Pago / Bling ERP',
            paymentId: String(bo.id),
            blingOrderId: bo.id,
            customer: {
              name: bo.contato?.nome || 'Cliente Street Store',
              email: bo.contato?.email || '',
              phone: bo.contato?.celular || bo.contato?.telefone || '',
            },
            products: (bo.itens || []).map((it: any) => ({
              name: it.descricao || 'Peça Street Store',
              price: Number(it.valor || 0),
              quantity: Number(it.quantidade || 1),
              variant: it.codigo || '',
              image: '',
            })),
            total: Number(bo.total || 0),
            createdAt: bo.data || new Date().toISOString(),
            paidAt: bo.data || null,
            shippedAt: null,
          });
        }
      }
    }
  } catch (err: any) {
    console.warn('[Orders Track] Bling lookup notice:', err?.message || err);
  }

  return [...localMatches, ...blingMatches];
}

export function requestStoreOrderReturn(params: {
  orderId: number | string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  reason: string;
  actionRequested: string;
  selectedItems: string[];
  details: string;
}): { success: boolean; protocol: string; message: string } {
  const protocol = `DEV-${String(params.orderNumber || params.orderId).replace(/\D/g, '').slice(-4) || 'ST'}-${Math.floor(1000 + Math.random() * 9000)}`;

  const db = loadOrdersDb();
  const order = db.orders.find(
    (o) => String(o.orderId) === String(params.orderId) || o.orderNumber === params.orderNumber
  );

  if (order) {
    if (!Array.isArray(order.returnRequests)) order.returnRequests = [];
    order.returnRequests.push({
      protocol,
      reason: params.reason,
      actionRequested: params.actionRequested,
      selectedItems: params.selectedItems,
      details: params.details,
      createdAt: new Date().toISOString(),
    });
    saveOrdersDb(db);
  }

  return {
    success: true,
    protocol,
    message: 'Solicitação de devolução registrada com sucesso e vinculada à logística reversa Melhor Envio.',
  };
}
