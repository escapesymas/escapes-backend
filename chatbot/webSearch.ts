import https from 'https';

/**
 * Preguntas de ficha técnica de la moto (desarrollo de serie, qué aceite o
 * batería lleva, presiones…), con límites de palabra: antes «par» coincidía con
 * «para» y cada mensaje lanzaba una búsqueda en internet de hasta 3,5 s.
 */
const TECH_SPEC_RE = new RegExp(
  [
    '\\b(dientes|desarrollo|de serie|ficha t[eé]cnica|especificaciones|capacidad|litros|par de apriete|presi[oó]n(es)?)\\b',
    '\\b(qu[eé]|cu[aá]l|cu[aá]nto)s? .{0,25}\\b(lleva|usa|monta|necesita|admite|cabe|tiene) de (serie|f[aá]brica)\\b',
    '\\b(qu[eé]|cu[aá]l)(es)? (aceite|bater[ií]a|buj[ií]as?|neum[aá]ticos?|medida|paso de cadena|cadena|pi[nñ][oó]n|corona) (lleva|usa|monta|necesita)\\b',
  ].join('|'),
  'i'
);

export function isTechSpecQuery(query: string): boolean {
  return TECH_SPEC_RE.test(query);
}

/**
 * Realiza una búsqueda ligera en DuckDuckGo HTML para extraer datos técnicos de motos.
 * Devuelve un resumen textual formateado o cadena vacía si falla/no hay resultados.
 */
export async function searchMotorcycleTechSpecs(query: string, brand?: string, model?: string, year?: number | null): Promise<string> {
  const motoString = [brand, model, year].filter(Boolean).join(' ');
  const searchQuery = motoString ? `${motoString} ${query} especificaciones datos técnicos` : `${query} moto datos técnicos`;

  return new Promise((resolve) => {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const snippets: string[] = [];
            const matches = data.match(/<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g) || [];

            for (const m of matches.slice(0, 4)) {
              const text = m
                .replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&#x27;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/\s+/g, ' ')
                .trim();
              if (text && text.length > 20) {
                snippets.push(`- ${text}`);
              }
            }

            if (snippets.length === 0) {
              return resolve('');
            }

            resolve(`DATOS TÉCNICOS ENCONTRADOS EN LA WEB (vía búsqueda pública):\n${snippets.join('\n')}`);
          } catch {
            resolve('');
          }
        });
      }
    );

    req.on('error', () => resolve(''));
    req.setTimeout(3500, () => {
      req.destroy();
      resolve('');
    });
  });
}
