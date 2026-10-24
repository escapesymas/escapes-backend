import OpenAI from 'openai';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.warn('[WARNING] MINIMAX_API_KEY not set — chatbot will fail at request time');
}

export const minimaxClient = new OpenAI({
  apiKey: apiKey || 'missing-set-env',
  baseURL: 'https://api.minimax.io/v1',
});

// MiniMax-M3.1-Flash (24/10/2026): mejor español y menos datos inventados que M2.7-highspeed en las pruebas,
// y más barato ($0,15 / $0,60 por millón de tokens de entrada / salida).
export const CHAT_MODEL = 'MiniMax-M3.1-Flash';

export const CHAT_LIMITS = {
  // Incluye el razonamiento del modelo: M3.1-Flash a veces razona más de 1.500 tokens y la respuesta salía
  // vacía o sin la marca de productos (sin tarjetas).
  maxTokens: 4000,
  temperature: 0.4,
  topP: 0.9,
  historyMaxMessages: 20,
};
