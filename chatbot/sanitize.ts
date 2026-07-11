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

const OUT_OF_SCOPE_KEYWORDS = [
  'receta', 'recipe', 'cocina', 'cook',
  'clima', 'weather', 'tiempo',
  'política', 'politics', 'elecciones',
  'religión', 'religion', 'dios',
  'matemáticas', 'math', 'ecuación',
  'historia', 'history',
  'cine', 'película', 'movie', 'film',
  'música', 'song', 'canción',
  'juego', 'game', 'videojuego',
  'deporte', 'football', 'fútbol', 'baloncesto',
  'chiste', 'joke',
  'poema', 'poem',
  'traducir', 'translate', 'translation',
  'código', 'programming', 'python', 'javascript',
  'bitcoin', 'crypto', 'stock market',
];

export function containsPromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((rx) => rx.test(text));
}

export function isOutOfScope(text: string): boolean {
  const lower = text.toLowerCase();
  return OUT_OF_SCOPE_KEYWORDS.some((kw) => lower.includes(kw));
}

export function sanitizeUserInput(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 1000)
    .trim();
}
