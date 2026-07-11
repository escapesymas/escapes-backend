import OpenAI from 'openai';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  console.warn('[WARNING] MINIMAX_API_KEY not set — chatbot will fail at request time');
}

export const minimaxClient = new OpenAI({
  apiKey: apiKey || 'missing-set-env',
  baseURL: 'https://api.minimax.io/v1',
});

export const CHAT_MODEL = 'MiniMax-M2.7-highspeed';

export const CHAT_LIMITS = {
  maxTokens: 400,
  temperature: 0.4,
  topP: 0.9,
  historyMaxMessages: 20,
};
