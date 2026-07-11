import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(process.env.HOME || '/home/adrian', '.config/escapes/external-accounts.env');
const SESSION_PATH = join(process.env.HOME || '/home/adrian', '.config/escapes/andreani-session.json');

function loadEnv() {
  return Object.fromEntries(
    readFileSync(CONFIG_PATH, 'utf8')
      .split('\n')
      .filter(l => l.includes('='))
      .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/"/g,'')]; })
  );
}

async function loginAndSaveSession() {
  const env = loadEnv();
  const BASE = env.ANDREANI_MHS_URL;
  const EMAIL = env.ANDREANI_MHS_EMAIL;
  const PASS = env.ANDREANI_MHS_PASSWORD;

  mkdirSync('/tmp', { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE}/iniciar-sesion`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await page.locator('#field-email').fill(EMAIL);
  await page.locator('#field-password').fill(PASS);
  await page.evaluate(() => {
    document.querySelectorAll('input[name="psgdpr_consent_checkbox"]').forEach(cb => cb.checked = true);
  });
  await page.evaluate(() => {
    const form = document.getElementById('login-form');
    if (form) form.submit();
  });

  await page.waitForTimeout(6000);

  const url = page.url();
  if (url.includes('iniciar-sesion') || url.includes('login')) {
    throw new Error('Login failed - still on login page');
  }

  const cookies = await context.cookies();
  const session = {
    cookies,
    loginUrl: url,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
  };

  mkdirSync(require('fs').realpathSync(join(SESSION_PATH, '..')), { recursive: true });
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));

  await browser.close();
  console.log('Session saved to', SESSION_PATH);
  return session;
}

async function getSession() {
  try {
    const session = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    if (new Date(session.expiresAt) > new Date()) {
      return session;
    }
  } catch {}
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const existing = await getSession();
  if (existing) {
    console.log('Session valid until:', existing.expiresAt);
  } else {
    await loginAndSaveSession();
  }
}

export { loginAndSaveSession, getSession };
