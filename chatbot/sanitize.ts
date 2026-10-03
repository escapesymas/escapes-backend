const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(previous|all|above|the)\s+instructions?\b/i,
  /\bforget\s+(previous|all|your)\s+instructions?\b/i,
  /\bdisregard\s+(previous|the|all)\s+instructions?\b/i,
  /\bact\s+as\s+(?!a\s+helpful)/i,
  /\byou\s+are\s+now\s+/i,
  /\bsystem\s*:/i,
  /\bassistant\s*:/i,
  /\bjailbreak\b/i,
  /\bDAN\b/,
  /\bpretend\s+(you|to\s+be)\b/i,
  /\brole\s*play\b/i,
  /\bdeveloper\s+mode\b/i,
];

// Temas claramente ajenos a la tienda. Solo palabras sin doble sentido y con
// límites de palabra: «tiempo» (de envío), «juego» (de pastillas), «código»
// (de descuento) o «historia» (historial de pedidos) bloqueaban preguntas reales.
// Lo dudoso lo resuelve el asistente con sus instrucciones.
const OUT_OF_SCOPE_RE = new RegExp(
  '\\b(' + [
    'recetas?', 'recipes?', 'cocinar',
    'pol[ií]tica partidista', 'elecciones', 'partido pol[ií]tico',
    'religi[oó]n', 'dios',
    'ecuaci[oó]n(es)?', 'integrales? definidas?',
    'pel[ií]culas?', 'movies?', 'series? de tv',
    'canci[oó]n(es)?', 'songs?', 'letra de',
    'videojuegos?',
    'f[uú]tbol', 'baloncesto', 'football',
    'chistes?', 'jokes?',
    'poemas?', 'poems?',
    'traduce', 'traducir', 'translate',
    'programar', 'programming', 'python', 'javascript',
    'bitcoin', 'criptomonedas?', 'crypto', 'bolsa de valores',
    'hor[oó]scopo',
  ].join('|') + ')\\b',
  'i'
);

export function containsPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((rx) => rx.test(text));
}

export function isOutOfScope(text: string): boolean {
  return OUT_OF_SCOPE_RE.test(text);
}

export function sanitizeUserInput(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 1000)
    .trim();
}
