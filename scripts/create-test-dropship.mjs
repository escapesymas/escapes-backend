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

async function createTestDropshipAddress() {
  const session = await getSession();
  if (!session) { console.log('No session'); return; }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie(...session.cookies.map(c => ({ ...c, domain: '.andreanimhs.com' })));

  console.log('Navigating to dropshipping address form...');
  await page.goto('https://andreanimhs.com/direccion?addr_type=dropshipping', { waitUntil: 'networkidle0' });
  await wait(2000);

  // Select Spain and get province
  await page.select('#field-id_country', '6').catch(() => {});
  await wait(2000);

  // Set form fields
  await page.evaluate(() => {
    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    setVal('[name="alias"]', 'Test Dropship Adrian');
    setVal('[name="company"]', 'Cliente Test Dropship SL');
    setVal('[name="address1"]', 'Calle Falsa 123');
    setVal('[name="city"]', 'Madrid');
    setVal('[name="postcode"]', '28001');
    const phoneField = document.querySelector('[name="phone"]');
    if (phoneField) {
      phoneField.value = '+34600123456';
      phoneField.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Set state
    const stateSelect = document.querySelector('[name="id_state"]');
    if (stateSelect) {
      const options = Array.from(stateSelect.options);
      const madrid = options.find(o => /madrid/i.test(o.text));
      if (madrid) stateSelect.value = madrid.value;
      else if (options.length > 1 && options[1].value) stateSelect.value = options[1].value;
    }
  });

  await wait(500);

  // Get the form data
  const formData = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return null;
    const data = {};
    new FormData(form).forEach((v, k) => { data[k] = v; });
    return data;
  });
  console.log('Form data:', JSON.stringify(formData, null, 2));

  // Submit using fetch to the exact form action
  const submitResult = await page.evaluate(async (formData) => {
    const form = document.querySelector('form');
    const action = form?.action || 'https://andreanimhs.com/direccion?id_address=0';

    try {
      const response = await fetch(action, {
        method: 'POST',
        body: new URLSearchParams(formData),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });

      const text = await response.text();
      const location = response.headers.get('location');

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        bodyPreview: text.substring(0, 500),
        location,
        finalUrl: response.url
      };
    } catch (e) {
      return { error: e.message };
    }
  }, formData);

  console.log('\nSubmit result:', JSON.stringify(submitResult, null, 2));

  // Check addresses page
  await page.goto('https://andreanimhs.com/direcciones', { waitUntil: 'networkidle0' });
  await wait(2000);

  const pageText = await page.evaluate(() => document.body.innerText);
  const hasTestAddress = /Test Dropship/i.test(pageText);
  console.log('\nTest Dropship found:', hasTestAddress);

  if (!hasTestAddress) {
    // Try the AJAX form endpoint directly
    console.log('\nTrying AJAX form endpoint...');
    const ajaxResult = await page.evaluate(async (data) => {
      const url = 'https://andreanimhs.com/direccion?ajax=1&action=addressForm';
      try {
        const response = await fetch(url, {
          method: 'POST',
          body: new URLSearchParams(data),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest'
          },
          credentials: 'include'
        });
        const text = await response.text();
        return { status: response.status, body: text.substring(0, 500) };
      } catch (e) {
        return { error: e.message };
      }
    }, formData);
    console.log('AJAX result:', JSON.stringify(ajaxResult, null, 2));
  }

  await browser.close();
  console.log('\nDone!');
}

createTestDropshipAddress().catch(e => { console.error(e); process.exit(1); });
