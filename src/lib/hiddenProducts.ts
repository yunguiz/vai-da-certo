import { Product } from '../types';

/**
 * List of products hidden from the storefront per user directive:
 * 1. CAMISETA CHRONIC\TRIPSIDE ORIGINAIS
 * 2. CSM500
 * 3. CAMISETA STREET MULTIMARCAS
 * 4. hock montreal
 * 5. bone aba curva
 * 6. shoulder bag
 * 7. oculos miragem
 * 8. BERMUDA CARPINTEIRO TRIP SIDE
 * 9. BERMUDA TRIP SIDE RAIO
 * 10. Boné tripside e chronic
 * 11. Carteira
 */
export function isProductHidden(product: Partial<Product> | any): boolean {
  if (!product) return false;

  // Automatically hide any out-of-stock product from the site
  if (typeof product.stockCount === 'number' && product.stockCount <= 0) {
    return true;
  }
  if (typeof product.stock === 'number' && product.stock <= 0 && product.stockCount === undefined) {
    return true;
  }
  if (String(product.tag || '').toUpperCase().trim() === 'SEM ESTOQUE') {
    return true;
  }

  const rawName = String(product.name || '').toLowerCase();
  const rawSku = String(product.integration?.sku || product.sku || '').toLowerCase();
  const rawDesc = String(product.description || '').toLowerCase();
  const rawSubcat = String(product.subcategory || '').toLowerCase();

  const variantSkus = Array.isArray(product.variantsList)
    ? product.variantsList.map((v: any) => String(v.sku || '').toLowerCase()).join(' ')
    : '';

  const fullText = `${rawName} ${rawSku} ${rawDesc} ${variantSkus}`;

  // 1. CAMISETA CHRONIC\TRIPSIDE ORIGINAIS
  if (
    (rawName.includes('chronic') && rawName.includes('tripside') && (rawName.includes('origina') || rawName.includes('camiseta'))) ||
    fullText.includes('cco500')
  ) {
    return true;
  }

  // 2. CSM500 & 3. CAMISETA STREET MULTIMARCAS
  if (
    fullText.includes('csm500') ||
    rawName.includes('street multimarca') ||
    rawName.includes('street multimarcas')
  ) {
    return true;
  }

  // 4. hock montreal (Hocks Montreal)
  if (
    (rawName.includes('hock') || rawName.includes('hocks')) &&
    rawName.includes('montreal')
  ) {
    return true;
  }

  // 5. bone aba curva
  if (
    (rawName.includes('bone') || rawName.includes('boné')) &&
    rawName.includes('aba curva')
  ) {
    return true;
  }

  // 6. shoulder bag (all shoulder bags)
  if (
    rawName.includes('shoulder bag') ||
    rawName.includes('sholder bag') ||
    rawName.includes('shoulder') ||
    rawName.includes('sholder') ||
    rawSku.startsWith('sb') ||
    (rawSubcat === 'bags' && (rawName.includes('shoulder') || rawName.includes('sholder')))
  ) {
    return true;
  }

  // 7. oculos miragem (OCULOS DE SOL MIRAGE / OSM100)
  if (
    rawName.includes('mirage') ||
    rawName.includes('miragem') ||
    fullText.includes('osm100')
  ) {
    return true;
  }

  // 8. BERMUDA CARPINTEIRO TRIP SIDE
  if (
    rawName.includes('bermuda') &&
    rawName.includes('carpinteiro') &&
    (rawName.includes('trip side') || rawName.includes('tripside'))
  ) {
    return true;
  }

  // 9. BERMUDA TRIP SIDE RAIO
  if (
    rawName.includes('bermuda') &&
    rawName.includes('raio') &&
    (rawName.includes('trip side') || rawName.includes('tripside'))
  ) {
    return true;
  }

  // 10. Boné tripside e chronic (all caps from Trip Side and Chronic)
  if (
    (rawName.includes('bone') || rawName.includes('boné')) &&
    (rawName.includes('trip side') || rawName.includes('tripside') || rawName.includes('chronic'))
  ) {
    return true;
  }

  // 11. Carteira (all wallets)
  if (
    rawName.includes('carteira') ||
    rawSku.startsWith('ctl') ||
    rawSku.startsWith('clv') ||
    rawSku.startsWith('cg') ||
    rawSku.startsWith('cap100')
  ) {
    return true;
  }

  return false;
}

export function filterVisibleProducts<T = Product>(products: T[]): T[] {
  if (!Array.isArray(products)) return [];
  return products.filter((p) => !isProductHidden(p));
}
