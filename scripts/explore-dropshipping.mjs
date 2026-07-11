import puppeteer from 'puppeteer-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

puppeteer.use(stealth());

const wait = ms => new Promise(r => setTimeout(r, ms));

const CONFIG_PATH = join(process.env.HOME || '/home/adrian', '.config/escapes/external-accounts.env');
const SESSION_PATH = join(process.env.HOME || '/home/adrian', '.config/escapes/andreani-session.json');
const OUTPUT_DIR = '/tmp/andreani-capture';
mkdirSync(OUTPUT_DIR, { recursive: true });

function loadEnv() {
  return Object.fromEntries(
    readFileSync(CONFIG_PATH, 'utf8')
      .split('\n')
      .filter(l => l.includes('='))
      .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/"/g,'')]; })
  );
}

async function getSession() {
  try {
    if (existsSync(SESSION_PATH)) {
      const session = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
      if (new Date(session.expiresAt) > new Date()) {
        return session;
      }
    }
  } catch {}
  // Fallback: try the old session cookies from /tmp
  if (existsSync('/tmp/andreani-capture/session-cookies.json')) {
    const oldCookies = JSON.parse(readFileSync('/tmp/andreani-capture/session-cookies.json', 'utf8'));
    const now = Date.now() / 1000;
    const validCookies = oldCookies.filter(c => !c.expires || c.expires > now);
    if (validCookies.length > 0) {
      console.log('Using cached session cookies from /tmp/andreani-capture');
      return { cookies: validCookies, loginUrl: 'https://andreanimhs.com', expiresAt: new Date(Date.now() + 6*60*60*1000).toISOString() };
    }
  }
  return null;
}

async function loginAndSaveSession() {
  const env = loadEnv();
  const BASE = env.ANDREANI_MHS_URL;
  const EMAIL = env.ANDREANI_MHS_EMAIL;
  const PASS = env.ANDREANI_MHS_PASSWORD;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  await page.goto(`${BASE}/iniciar-sesion`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#field-email', { timeout: 10000 });

  await page.evaluate(([email, pass]) => {
    document.querySelector('#field-email').value = email;
    document.querySelector('#field-password').value = pass;
    document.querySelectorAll('input[name="psgdpr_consent_checkbox"]').forEach(cb => cb.checked = true);
  }, [EMAIL, PASS]);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.evaluate(() => {
      const form = document.getElementById('login-form');
      if (form) form.submit();
    })
  ]);

  await wait(6000);

  const url = page.url();
  if (url.includes('iniciar-sesion') || url.includes('login')) {
    throw new Error('Login failed');
  }

  const cookies = await page.cookies();
  const session = { cookies, loginUrl: url, expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() };
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));

  await browser.close();
  console.log('Session saved');
  return session;
}

async function exploreDropshipping() {
  const env = loadEnv();
  const BASE = env.ANDREANI_MHS_URL;

  const session = await getSession();
  if (!session) {
    console.log('No session, logging in...');
    await loginAndSaveSession();
  }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie(...session.cookies.map(c => ({ ...c, domain: '.andreanimhs.com' })));

  const requests = [];
  page.on('request', r => {
    if (r.url().includes('andreanimhs') || r.url().includes('presta')) {
      requests.push({ url: r.url(), method: r.method(), postData: r.postData() });
    }
  });

  console.log('Navigating to /direcciones...');
  await page.goto(`${BASE}/direcciones`, { waitUntil: 'networkidle0' });
  await wait(3000);

  console.log('Current URL:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Page text (first 4000 chars):\n', bodyText.substring(0, 4000));

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim(),
      className: b.className,
      id: b.id
    }))
  );
  console.log('\nButtons:', JSON.stringify(buttons, null, 2));

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent.trim().substring(0, 80),
      href: a.href
    })).filter(l => l.text.length > 0)
  );
  console.log('\nLinks:', JSON.stringify(links.slice(0, 30), null, 2));

  const forms = await page.evaluate(() =>
    Array.from(document.querySelectorAll('form')).map((f, i) => ({
      index: i,
      action: f.action,
      method: f.method,
      id: f.id,
      inputs: Array.from(f.querySelectorAll('input')).map(inp => ({
        name: inp.name, type: inp.type, id: inp.id,
        required: inp.required, value: inp.value, placeholder: inp.placeholder
      })),
      selects: Array.from(f.querySelectorAll('select')).map(sel => ({
        name: sel.name, id: sel.id,
        options: Array.from(sel.options).slice(0, 15).map(o => ({ value: o.value, text: o.text.substring(0, 50) }))
      }))
    }))
  );
  console.log('\nForms:', JSON.stringify(forms, null, 2));

  const html = await page.content();
  writeFileSync(`${OUTPUT_DIR}/direcciones-html.html`, html);

  // Try clicking "Crear nueva dirección de dropshipping"
  const btnResult = await page.evaluateHandle(() => {
    const all = document.querySelectorAll('button, a, [role="button"]');
    for (const el of all) {
      if (/nueva.*dropshipping|crear.*dropshipping|dropshipping.*nueva/i.test(el.textContent || '')) {
        return el;
      }
    }
    return null;
  });

  if (btnResult) {
    console.log('\nClicking dropshipping button...');
    await btnResult.click();
    await wait(3000);
    console.log('After click URL:', page.url());

    const formsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('form')).map((f, i) => ({
        index: i,
        action: f.action,
        method: f.method,
        id: f.id,
        inputs: Array.from(f.querySelectorAll('input')).map(inp => ({
          name: inp.name, type: inp.type, id: inp.id,
          required: inp.required, value: inp.value, placeholder: inp.placeholder
        })),
        selects: Array.from(f.querySelectorAll('select')).map(sel => ({
          name: sel.name, id: sel.id,
          options: Array.from(sel.options).slice(0, 20).map(o => ({ value: o.value, text: o.text.substring(0, 60) }))
        }))
      }))
    );
    console.log('\nForms after click:', JSON.stringify(formsAfter, null, 2));

    const htmlAfter = await page.content();
    writeFileSync(`${OUTPUT_DIR}/dropshipping-form-html.html`, htmlAfter);
  } else {
    console.log('\nDropshipping button not found');
    // List all elements containing dropshipping
    const dropNodes = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('*').forEach(el => {
        if (/dropshipping/i.test(el.textContent || '') && el.children.length === 0) {
          result.push({ tag: el.tagName, text: el.textContent.trim().substring(0, 100), className: el.className });
        }
      });
      return result;
    });
    console.log('Dropshipping text nodes:', JSON.stringify(dropNodes, null, 2));
  }

  writeFileSync(`${OUTPUT_DIR}/direcciones-requests.json`, JSON.stringify(requests, null, 2));

  await browser.close();
  console.log('\nDone!');
}

exploreDropshipping().catch(e => { console.error(e); process.exit(1); });
