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
    if (validCookies.length > 0) {
      return { cookies: validCookies, loginUrl: 'https://andreanimhs.com' };
    }
  }
  return null;
}

async function exploreQuickOrder() {
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

  console.log('Navigating to /module/megaquickorder/form...');
  await page.goto('https://andreanimhs.com/module/megaquickorder/form', { waitUntil: 'networkidle0' });
  await wait(3000);

  console.log('URL:', page.url());

  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log('Page text (first 5000 chars):\n', bodyText.substring(0, 5000));

  const forms = await page.evaluate(() =>
    Array.from(document.querySelectorAll('form')).map((f, i) => ({
      index: i,
      action: f.action,
      method: f.method,
      id: f.id,
      className: f.className,
      inputs: Array.from(f.querySelectorAll('input')).map(inp => ({
        name: inp.name, type: inp.type, id: inp.id,
        required: inp.required, value: inp.value, placeholder: inp.placeholder,
        className: inp.className
      })),
      selects: Array.from(f.querySelectorAll('select')).map(sel => ({
        name: sel.name, id: sel.id,
        options: Array.from(sel.options).slice(0, 20).map(o => ({ value: o.value, text: o.text.substring(0, 60) }))
      })),
      textareas: Array.from(f.querySelectorAll('textarea')).map(ta => ({
        name: ta.name, id: ta.id, placeholder: ta.placeholder
      }))
    }))
  );
  console.log('\nForms:', JSON.stringify(forms, null, 2));

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim().substring(0, 80),
      className: b.className, id: b.id, type: b.type
    }))
  );
  console.log('\nButtons:', JSON.stringify(buttons, null, 2));

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent.trim().substring(0, 80),
      href: a.href
    })).filter(l => l.text.length > 0)
  );
  console.log('\nLinks:', JSON.stringify(links.slice(0, 20), null, 2));

  // Check for any AJAX endpoints
  const ajaxEndpoints = requests.filter(r =>
    r.url.includes('ajax') || r.url.includes('module/megaquickorder') ||
    r.url.includes('cart') || r.url.includes('order')
  );
  console.log('\nAJAX/Relevant requests:', JSON.stringify(ajaxEndpoints.slice(0, 30), null, 2));

  // Save HTML
  const html = await page.content();
  writeFileSync(`${OUTPUT_DIR}/quickorder-html.html`, html);
  writeFileSync(`${OUTPUT_DIR}/quickorder-requests.json`, JSON.stringify(requests, null, 2));

  await browser.close();
  console.log('\nDone!');
}

exploreQuickOrder().catch(e => { console.error(e); process.exit(1); });
