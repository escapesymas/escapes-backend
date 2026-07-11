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

async function exploreQuickOrderFlow() {
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

  console.log('Navigating to megaquickorder...');
  await page.goto('https://andreanimhs.com/module/megaquickorder/form', { waitUntil: 'networkidle0' });
  await wait(2000);

  // Type a reference to search for it
  console.log('Typing reference...');
  await page.waitForSelector('.reference-input', { timeout: 5000 });
  await page.click('.reference-input');
  await page.type('.reference-input', 'AND1518', { delay: 100 });
  await wait(2000);

  // Check what AJAX requests were made
  const searchRequests = requests.filter(r =>
    r.url.includes('megaquickorder') || r.url.includes('search') || r.url.includes('ajax')
  );
  console.log('\nSearch AJAX requests:');
  for (const req of searchRequests.slice(-10)) {
    console.log(`  ${req.method} ${req.url}`);
    if (req.postData) console.log(`    POST: ${req.postData.substring(0, 200)}`);
  }

  // Check if any dropdown appeared with results
  const dropdownItems = await page.evaluate(() => {
    const items = document.querySelectorAll('.ajaxressult li');
    return Array.from(items).map(li => ({
      text: li.textContent.trim().substring(0, 100),
      href: li.querySelector('a')?.href || ''
    }));
  });
  console.log('\nDropdown items:', JSON.stringify(dropdownItems, null, 2));

  // Check cart state
  const cartProducts = await page.evaluate(() => {
    const rows = document.querySelectorAll('.product-line');
    return Array.from(rows).map(row => ({
      name: row.querySelector('.product-name')?.textContent?.trim() || '',
      qty: row.querySelector('.quantity-input')?.value || '',
      price: row.querySelector('.price')?.textContent?.trim() || ''
    }));
  });
  console.log('\nCart products:', JSON.stringify(cartProducts, null, 2));

  // Check "Ir al checkout" link
  const checkoutLink = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    for (const a of links) {
      if (a.textContent.includes('checkout') || a.textContent.includes('pedido')) {
        return { text: a.textContent.trim(), href: a.href };
      }
    }
    return null;
  });
  console.log('\nCheckout link:', JSON.stringify(checkoutLink, null, 2));

  // Check the "Ir al checkout" page
  if (checkoutLink) {
    console.log('\nNavigating to checkout...');
    await page.goto(checkoutLink.href, { waitUntil: 'networkidle0' });
    await wait(3000);
    console.log('Checkout URL:', page.url());

    const checkoutText = await page.evaluate(() => document.body.innerText);
    console.log('Checkout text (first 4000 chars):\n', checkoutText.substring(0, 4000));

    // Get all forms on checkout
    const checkoutForms = await page.evaluate(() =>
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
          options: Array.from(sel.options).slice(0, 10).map(o => ({ value: o.value, text: o.text.substring(0, 40) }))
        }))
      }))
    );
    console.log('\nCheckout forms:', JSON.stringify(checkoutForms, null, 2));

    // Get all addresses available
    const addressBlocks = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.address-item, .address-box, [data-address-id]');
      return Array.from(blocks).map(b => ({
        id: b.getAttribute('data-address-id') || b.id,
        text: b.textContent.trim().substring(0, 200),
        className: b.className
      })).slice(0, 10);
    });
    console.log('\nAddress blocks:', JSON.stringify(addressBlocks, null, 2));

    // Check for dropshipping address option
    const dropshipOption = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      const found = [];
      all.forEach(el => {
        if (/dropship/i.test(el.textContent || '')) {
          found.push({ tag: el.tagName, text: el.textContent.trim().substring(0, 80), className: el.className });
        }
      });
      return found;
    });
    console.log('\nDropshipping options on checkout:', JSON.stringify(dropshipOption, null, 2));
  }

  writeFileSync(`${OUTPUT_DIR}/quickorder-flow-requests.json`, JSON.stringify(requests, null, 2));
  const html = await page.content();
  writeFileSync(`${OUTPUT_DIR}/checkout-html.html`, html);

  await browser.close();
  console.log('\nDone!');
}

exploreQuickOrderFlow().catch(e => { console.error(e); process.exit(1); });
