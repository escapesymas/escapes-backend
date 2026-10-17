import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { httpGet, resetHttpGetCaches } from './range-http.js';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const okOnly = (status: number) => { if (status !== 200) throw new Error(`HTTP ${status}`); return 1024; };

// Cadena de prueba: raíz -> intermedio -> hoja. El servidor https solo manda la hoja (como static.bihr.pro)
// y la hoja dice en «CA Issuers» dónde está el intermedio.
describe.skipIf(!hasOpenssl)('httpGet con certificado intermedio que falta', () => {
  let dir: string;
  let aia: http.Server;
  let site: https.Server;
  let evilSite: https.Server;
  let evilUrl = '';
  let evilHits = 0;
  let siteUrl = '';
  let rootPem = '';
  let aiaHits = 0;

  const sh = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-chain-'));
    aia = http.createServer((req, res) => {
      if (req.url === '/inter.der') { aiaHits++; return res.end(fs.readFileSync(path.join(dir, 'inter.der'))); }
      if (req.url === '/evil.der') { evilHits++; return res.end(fs.readFileSync(path.join(dir, 'evil-root.der'))); }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((resolve) => aia.listen(0, '127.0.0.1', resolve));
    const aiaPort = (aia.address() as AddressInfo).port;

    fs.writeFileSync(path.join(dir, 'inter.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    fs.writeFileSync(path.join(dir, 'leaf.ext'),
      `basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nauthorityInfoAccess=caIssuers;URI:http://127.0.0.1:${aiaPort}/inter.der\n`);
    sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '2', '-subj', '/CN=Test Root',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'inter.key', '-out', 'inter.csr', '-subj', '/CN=Test Intermediate');
    sh('x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'inter.pem', '-days', '2', '-extfile', 'inter.ext');
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=127.0.0.1');
    sh('x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext');
    sh('x509', '-in', 'inter.pem', '-outform', 'der', '-out', 'inter.der');
    rootPem = fs.readFileSync(path.join(dir, 'root.pem'), 'utf-8');

    site = https.createServer(
      { key: fs.readFileSync(path.join(dir, 'leaf.key')), cert: fs.readFileSync(path.join(dir, 'leaf.pem')) },
      (_req, res) => res.end('foto'));
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `https://127.0.0.1:${(site.address() as AddressInfo).port}/x`;

    // Atacante: su propia raíz autofirmada, una hoja para 127.0.0.1 firmada por ella (sin mandar la raíz)
    // y una dirección «CA Issuers» que sirve esa raíz.
    fs.writeFileSync(path.join(dir, 'evil-leaf.ext'),
      `basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nauthorityInfoAccess=caIssuers;URI:http://127.0.0.1:${aiaPort}/evil.der\n`);
    sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'evil-root.key', '-out', 'evil-root.pem', '-days', '2', '-subj', '/CN=Evil Root',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'evil-leaf.key', '-out', 'evil-leaf.csr', '-subj', '/CN=127.0.0.1');
    sh('x509', '-req', '-in', 'evil-leaf.csr', '-CA', 'evil-root.pem', '-CAkey', 'evil-root.key', '-CAcreateserial', '-out', 'evil-leaf.pem', '-days', '2', '-extfile', 'evil-leaf.ext');
    sh('x509', '-in', 'evil-root.pem', '-outform', 'der', '-out', 'evil-root.der');
    evilSite = https.createServer(
      { key: fs.readFileSync(path.join(dir, 'evil-leaf.key')), cert: fs.readFileSync(path.join(dir, 'evil-leaf.pem')) },
      (_req, res) => res.end('FORGED'));
    await new Promise<void>((resolve) => evilSite.listen(0, '127.0.0.1', resolve));
    evilUrl = `https://127.0.0.1:${(evilSite.address() as AddressInfo).port}/x`;
  });

  afterAll(() => { site?.close(); evilSite?.close(); aia?.close(); });

  beforeEach(() => { resetHttpGetCaches(); aiaHits = 0; evilHits = 0; });

  const trust = (extra: Record<string, any> = {}) => ({ timeoutMs: 10_000, onResponse: okOnly, extraRoots: [rootPem], allowPrivateAia: true, ...extra });

  it('descarga el intermedio del certificado y verifica la cadena completa', async () => {
    const r = await httpGet(siteUrl, trust());
    expect(r.body.toString()).toBe('foto');
    expect(aiaHits).toBe(1);
    // La segunda vez ya se conoce el intermedio.
    await httpGet(siteUrl, trust());
    expect(aiaHits).toBe(1);
  });

  it('rechaza una cadena que no termina en una raíz de confianza', async () => {
    await expect(httpGet(siteUrl, { timeoutMs: 10_000, onResponse: okOnly, allowPrivateAia: true })).rejects.toMatchObject({ code: expect.stringMatching(/^(UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/) });
  });

  it('no se fía de una raíz autofirmada que sirve la propia dirección «CA Issuers» de un atacante', async () => {
    await expect(httpGet(evilUrl, trust())).rejects.toMatchObject({ code: expect.stringMatching(/^(UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/) });
    expect(evilHits).toBe(1); // se miró la dirección, pero la raíz del atacante no se aceptó
    // Y no queda nada recordado: otro intento (sin esperar al reintento) tampoco pasa.
    resetHttpGetCaches();
    await expect(httpGet(evilUrl, trust())).rejects.toBeDefined();
  });

  it('no descarga certificados de direcciones locales (la IP de «CA Issuers» es 127.0.0.1)', async () => {
    await expect(httpGet(siteUrl, trust({ allowPrivateAia: false }))).rejects.toMatchObject({ code: expect.stringMatching(/^UNABLE_TO_/) });
    expect(aiaHits).toBe(0);
  });
});

describe('httpGet', () => {
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/grande') return res.end(Buffer.alloc(5000));
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => { server.close(); });

  it('lee el cuerpo por http', async () => {
    expect((await httpGet(`${base}/x`, { timeoutMs: 5_000, onResponse: () => 100 })).body.toString()).toBe('ok');
  });

  it('corta la descarga si el cuerpo supera lo permitido', async () => {
    await expect(httpGet(`${base}/grande`, { timeoutMs: 5_000, onResponse: () => 1000 })).rejects.toThrow('más datos de los pedidos');
  });

  it('deja que onResponse corte antes de leer el cuerpo', async () => {
    await expect(httpGet(`${base}/x`, { timeoutMs: 5_000, onResponse: () => { throw new Error('no vale'); } })).rejects.toThrow('no vale');
  });
});
