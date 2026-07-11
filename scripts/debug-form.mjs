import puppeteer from 'puppeteer-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, existsSync } from 'fs';

puppeteer.use(stealth());

const wait = ms => new Promise(r => setTimeout(r, ms));
const SESSION_PATH = '/tmp/andreani-capture/session-cookies.json';

async function getSession() {
  if (existsSync(SESSION_PATH)) {
    const oldCookies = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    const now = Date.now() / 1000;
    const validCookies = oldCookies.filter(c => !c.expires || c.expires > now);
    if (validCookies.length > 0) return { cookies: validCookies };
  }
  return null;
}

async function debugForm() {
  const session = await getSession();
  if (!session) { console.log('No session'); return; }

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setCookie(...session.cookies.map(c => ({ ...c, domain: '.andreanimhs.com' })));

  console.log('Navigating to dropshipping address form...');
  await page.goto('https://andreanimhs.com/direccion?addr_type=dropshipping', { waitUntil: 'networkidle0' });
  await wait(2000);

  // Get ALL buttons on the page
  const allButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.textContent.trim(),
      type: b.type,
      className: b.className,
      id: b.id
    }));
  });
  console.log('All buttons:', JSON.stringify(allButtons, null, 2));

  // Get all form elements
  const formInfo = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form'));
    return forms.map(f => ({
      action: f.action,
      method: f.method,
      id: f.id,
      className: f.className,
      buttons: Array.from(f.querySelectorAll('button')).map(b => ({
        text: b.textContent.trim(),
        type: b.type,
        className: b.className
      })),
      submitBtns: Array.from(f.querySelectorAll('[type="submit"]')).map(b => ({
        text: b.textContent.trim(),
        type: b.type,
        className: b.className,
        tagName: b.tagName
      }))
    }));
  });
  console.log('\nForm info:', JSON.stringify(formInfo, null, 2));

  // Get the full HTML of the form
  const formHtml = await page.evaluate(() => {
    const form = document.querySelector('form[data-id-address="0"]') ||
                 Array.from(document.querySelectorAll('form')).find(f => f.action.includes('direccion'));
    return form ? form.outerHTML.substring(0, 3000) : 'FORM NOT FOUND';
  });
  console.log('\nForm HTML:', formHtml);

  await browser.close();
}

debugForm().catch(e => { console.error(e); process.exit(1); });
