import puppeteer from 'puppeteer-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, existsSync } from 'fs';

puppeteer.use(stealth());

const wait = ms => new Promise(r => setTimeout(r, ms));
const SESSION_PATH = '/tmp/andreani-capture/session-cookies.json';
const OUTPUT_DIR = '/tmp/andreani-capture';

async function getSession() {
  if (existsSync(SESSION_PATH)) {
    const oldCookies = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    const now = Date.now() / 1000;
    const validCookies = oldCookies.filter(c => !c.expires || c.expires > now);
    if (validCookies.length > 0) return { cookies: validCookies };
  }
  return null;
}

async function exploreCheckout() {
  const session = await getSession();
  if (!session) { console.log('No session'); return; }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie(...session.cookies.map(c => ({ ...c, domain: '.andreanimhs.com' })));

  const requests = [];
  page.on('request', r => {
    if (r.url().includes('andreanimhs') || r.url().includes('presta')) {
      requests.push({ url: r.url(), method: r.method(), postData: r.postData() });
    }
  });

  // Navigate directly to /pedido
  console.log('Navigating to /pedido...');
  await page.goto('https://andreanimhs.com/pedido', { waitUntil: 'networkidle0' });
  await wait(3000);
  console.log('URL:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Page text (first 6000 chars):\n', bodyText.substring(0, 6000));

  // Get all forms
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
        options: Array.from(sel.options).slice(0, 15).map(o => ({ value: o.value, text: o.text.substring(0, 60) }))
      }))
    }))
  );
  console.log('\nForms:', JSON.stringify(forms, null, 2));

  // Check for addresses/delivery options
  const deliveryOptions = await page.evaluate(() => {
    const blocks = document.querySelectorAll('[class*="address"], [class*="delivery"], [class*="carrier"], .Addresses--item');
    return Array.from(blocks).map(b => ({
      text: b.textContent.trim().substring(0, 200),
      className: b.className,
      id: b.id
    })).slice(0, 10);
  });
  console.log('\nDelivery/address blocks:', JSON.stringify(deliveryOptions, null, 2));

  // Check for dropshipping
  const dropshipElements = await page.evaluate(() => {
    const all = document.querySelectorAll('*');
    const found = [];
    all.forEach(el => {
      const text = el.textContent || '';
      if (/dropship|dropshipping/i.test(text)) {
        found.push({ tag: el.tagName, text: text.trim().substring(0, 100), className: el.className });
      }
    });
    return found;
  });
  console.log('\nDropshipping elements:', JSON.stringify(dropshipElements, null, 2));

  // Get all links that might be relevant
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent.trim().substring(0, 80),
      href: a.href
    })).filter(l => l.text.length > 0 && (l.href.includes('pedido') || l.href.includes('address') || l.href.includes('carrier') || l.href.includes('cart')))
  );
  console.log('\nRelevant links:', JSON.stringify(links.slice(0, 20), null, 2));

  writeFileSync(`${OUTPUT_DIR}/pedido-requests.json`, JSON.stringify(requests, null, 2));
  const html = await page.content();
  writeFileSync(`${OUTPUT_DIR}/pedido-html.html`, html);

  await browser.close();
  console.log('\nDone!');
}

exploreCheckout().catch(e => { console.error(e); process.exit(1); });
