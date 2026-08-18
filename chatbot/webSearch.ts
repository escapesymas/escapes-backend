import https from 'https';

/**
 * Palabras clave que activan la búsqueda técnica en internet.
 */
const TECH_SPEC_WORDS = [
  'dientes', 'piñon', 'piñón', 'corona', 'desarrollo', 'cadena',
  'aceite', 'capacidad', 'bateria', 'batería', 'bujia', 'bujía',
  'presion', 'presión', 'neumatico', 'neumático', 'par', 'apriete',
  'medida', 'medidas', 'paso', 'serie', 'original', 'ficha', 'tecnica', 'técnica',
  'especificaciones', 'litros', 'ah', 'cca', 'filtro', 'juego', 'soporte',
];

/**
 * Comprueba si la consulta del usuario requiere buscar datos técnicos de la moto en internet.
 */
export function isTechSpecQuery(query: string): boolean {
  const lower = query.toLowerCase();
  return TECH_SPEC_WORDS.some((w) => lower.includes(w));
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
