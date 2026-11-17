import type { VercelRequest, VercelResponse } from '@vercel/node';
import { calcularFreteMelhorEnvio, ProdutoFreteInput } from '../../lib/melhorEnvio';

/**
 * Vercel Serverless Function: POST /api/frete/calcular
 * Recebe CEP de destino e produtos (peso em kg, altura, largura, comprimento em cm e valor segurado),
 * consulta POST /api/v2/me/shipment/calculate no Melhor Envio e devolve as transportadoras formatadas.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      sucesso: false,
      erro: 'Método não permitido. Utilize POST.',
    });
  }

  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const cepDestino = String(
      body.cepDestino || body.cep || body.toPostalCode || body.postalCode || ''
    ).trim();

    const cepOrigem = body.cepOrigem ? String(body.cepOrigem).trim() : undefined;

    const rawProdutos = (body.produtos || body.products || body.items) as ProdutoFreteInput[] | undefined;

    if (!cepDestino) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Informe o campo cepDestino (8 dígitos).',
      });
    }

    if (!Array.isArray(rawProdutos) || rawProdutos.length === 0) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Informe o array produtos com peso (kg), altura, largura, comprimento (cm) e valorSegurado.',
      });
    }

    const resultado = await calcularFreteMelhorEnvio({
      cepDestino,
      cepOrigem,
      produtos: rawProdutos,
    });

    return res.status(200).json(resultado);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel /api/frete/calcular Error]:', message);
    return res.status(500).json({
      sucesso: false,
      erro: message,
    });
  }
}
