/**
 * GET por http/https con comprobación del certificado «a lo navegador».
 *
 * Node solo usa los certificados que manda el servidor y su lista de raíces; si el
 * servidor no manda el certificado intermedio (static.bihr.pro, por ejemplo) falla con
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE aunque el navegador lo abra sin problema, porque los
 * navegadores descargan el intermedio de la dirección «CA Issuers» del propio certificado.
 *
 * Aquí se hace lo mismo con una condición: el certificado que llega por esa dirección no se
 * fía de por sí (la dirección la dice un certificado que aún no está verificado). Solo se usa
 * si cada eslabón está firmado por el siguiente y el último está firmado por una raíz de
 * confianza (las de Mozilla de Node, NODE_EXTRA_CA_CERTS o las de las pruebas). Un certificado
 * autofirmado que no sea ya una raíz de confianza nunca se añade.
 */
import http from 'http';
import https from 'https';
import dns from 'dns';
import fs from 'fs';
import net from 'net';
import tls from 'tls';
import { X509Certificate } from 'crypto';

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

export interface HttpGetOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /**
   * Se llama al llegar las cabeceras: devuelve cuántos bytes como máximo se leen del cuerpo
   * (0 = no hace falta cuerpo) o lanza un error para cortar la descarga.
   */
  onResponse: (status: number, headers: http.IncomingHttpHeaders) => number;
  /** Solo pruebas: raíces de confianza extra. */
  extraRoots?: string[];
  /** Solo pruebas: permite que la dirección «CA Issuers» sea una IP local. */
  allowPrivateAia?: boolean;
}

const CHAIN_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);
const MAX_CERT_BYTES = 64 * 1024;
const MAX_CHAIN_DEPTH = 4;
const DISCOVERY_MAX_MS = 15_000;
const DISCOVERY_RETRY_AFTER_MS = 60_000;

/** Intermedios ya comprobados por servidor, para no repetir la búsqueda. */
const intermediates = new Map<string, string[]>();
/** Servidores donde la búsqueda falló hace poco. */
const discoveryFailed = new Map<string, number>();

// ---------------------------------------------------------------- direcciones no públicas

const NON_PUBLIC = new net.BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
NON_PUBLIC.addAddress('::', 'ipv6');
NON_PUBLIC.addAddress('::1', 'ipv6');
NON_PUBLIC.addSubnet('fc00::', 7, 'ipv6');
NON_PUBLIC.addSubnet('fe80::', 10, 'ipv6');
NON_PUBLIC.addSubnet('ff00::', 8, 'ipv6');

function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_PUBLIC.check(mapped[1], 'ipv4');
  return NON_PUBLIC.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/** dns.lookup que se niega a resolver a direcciones no públicas: la comprobación es sobre la IP a la que se conecta. */
const publicOnlyLookup = ((hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, options, (err: any, address: any, family: any) => {
    if (err) return callback(err, address, family);
    const list: string[] = Array.isArray(address) ? address.map((a: any) => a.address) : [address];
    if (list.some(isNonPublicAddress)) return callback(new Error('dirección no permitida'), '', 4);
    callback(null, address, family);
  });
}) as net.LookupFunction;

// ---------------------------------------------------------------- raíces de confianza

let bundledRoots: X509Certificate[] | null = null;
let envExtraPems: string[] | null = null;

/** Certificados de NODE_EXTRA_CA_CERTS: pasar `ca` hace que Node deje de usarlos solo. */
function envExtraCa(): string[] {
  if (envExtraPems) return envExtraPems;
  try {
    const file = process.env.NODE_EXTRA_CA_CERTS;
    envExtraPems = file ? fs.readFileSync(file, 'utf-8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [] : [];
  } catch { envExtraPems = []; }
  return envExtraPems;
}

function trustedRootPems(extraRoots: string[] = []): string[] {
  return [...tls.rootCertificates, ...extraRoots, ...envExtraCa()];
}

function trustedRoots(extraRoots: string[] = []): X509Certificate[] {
  if (!bundledRoots) bundledRoots = tls.rootCertificates.map((pem) => new X509Certificate(pem));
  const extra: X509Certificate[] = [];
  for (const pem of [...extraRoots, ...envExtraCa()]) { try { extra.push(new X509Certificate(pem)); } catch { /* PEM roto: se ignora */ } }
  return [...bundledRoots, ...extra];
}

/** ¿Cada eslabón está firmado por el siguiente y el último por una raíz de confianza (o es una)? */
function chainReachesTrustedRoot(leaf: X509Certificate, found: X509Certificate[], roots: X509Certificate[]): boolean {
  const chain = [leaf, ...found];
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) return false;
  }
  const top = chain[chain.length - 1];
  return roots.some((root) => root.fingerprint256 === top.fingerprint256 || (top.checkIssued(root) && top.verify(root.publicKey)));
}

// ---------------------------------------------------------------- peticiones

function once(url: URL, o: HttpGetOptions, timeoutMs: number, extra: { ca?: string[]; lookup?: net.LookupFunction } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: o.headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(extra.ca ? { ca: extra.ca } : {}),
      ...(extra.lookup ? { lookup: extra.lookup } : {}),
    } as https.RequestOptions, (res) => {
      let limit: number;
      try { limit = o.onResponse(res.statusCode || 0, res.headers); } catch (err) { res.destroy(); req.destroy(); reject(err); return; }
      if (limit <= 0) { res.destroy(); resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.alloc(0) }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { res.destroy(); reject(new Error('el servidor devolvió más datos de los pedidos')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Descarga un certificado (DER o PEM) de una dirección «CA Issuers»; solo http(s) a direcciones públicas. */
async function downloadCertificate(uri: string, timeoutMs: number, allowPrivate: boolean): Promise<X509Certificate> {
  const url = new URL(uri);
  if (!allowPrivate) {
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('puerto no permitido');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isNonPublicAddress(host)) throw new Error('dirección no permitida');
  }
  const r = await once(url, {
    timeoutMs,
    onResponse: (status) => { if (status !== 200) throw new Error(`HTTP ${status}`); return MAX_CERT_BYTES; },
  }, timeoutMs, allowPrivate ? {} : { lookup: publicOnlyLookup });
  return new X509Certificate(r.body);
}

/**
 * Lee el certificado del servidor y sigue los «CA Issuers» hasta una raíz. Devuelve los
 * intermedios en PEM solo si la cadena hasta una raíz de confianza queda comprobada.
 */
async function discoverIntermediates(url: URL, o: HttpGetOptions): Promise<string[]> {
  const deadline = Date.now() + Math.min(o.timeoutMs, DISCOVERY_MAX_MS);
  const left = () => { const ms = deadline - Date.now(); if (ms < 500) throw new Error('sin respuesta a tiempo'); return ms; };
  const host = url.hostname;
  const leaf = await new Promise<X509Certificate>((resolve, reject) => {
    // Sin verificar: solo se lee el certificado y no se manda nada; la petición de verdad sí se verifica.
    const socket = tls.connect({ host, port: Number(url.port) || 443, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      try { resolve(new X509Certificate(peer.raw)); } catch (err) { reject(err); }
    });
    socket.setTimeout(left(), () => { socket.destroy(); reject(new Error('sin respuesta a tiempo')); });
    socket.on('error', reject);
  });
  const found: X509Certificate[] = [];
  const seen = new Set<string>([leaf.fingerprint256]);
  let cert = leaf;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const uri = /CA Issuers - URI:(\S+)/.exec(cert.infoAccess || '')?.[1];
    if (!uri || !/^https?:\/\//i.test(uri)) break;
    const issuer = await downloadCertificate(uri, left(), !!o.allowPrivateAia);
    if (seen.has(issuer.fingerprint256)) break;
    seen.add(issuer.fingerprint256);
    found.push(issuer);
    if (issuer.subject === issuer.issuer) break;
    cert = issuer;
  }
  if (found.length === 0 || !chainReachesTrustedRoot(leaf, found, trustedRoots(o.extraRoots))) return [];
  // Un certificado que ya es una raíz de confianza no hace falta añadirlo.
  const rootPrints = new Set(trustedRoots(o.extraRoots).map((r) => r.fingerprint256));
  return found.filter((c) => !rootPrints.has(c.fingerprint256)).map((c) => c.toString());
}

export async function httpGet(urlStr: string, o: HttpGetOptions): Promise<HttpResult> {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') return once(url, o, o.timeoutMs);
  const caWith = (extra: string[]) => (extra.length || o.extraRoots?.length || envExtraCa().length ? [...trustedRootPems(o.extraRoots), ...extra] : undefined);
  const known = intermediates.get(url.host);
  try {
    return await once(url, o, o.timeoutMs, { ca: caWith(known || []) });
  } catch (err: any) {
    if (!CHAIN_ERRORS.has(String(err?.code))) throw err;
    if (known) intermediates.delete(url.host); // el servidor ha cambiado de certificado: se vuelve a buscar
    if ((discoveryFailed.get(url.host) || 0) > Date.now()) throw err;
    let found: string[] = [];
    try { found = await discoverIntermediates(url, o); } catch { /* se devuelve el error original */ }
    if (found.length === 0) { discoveryFailed.set(url.host, Date.now() + DISCOVERY_RETRY_AFTER_MS); throw err; }
    const result = await once(url, o, o.timeoutMs, { ca: caWith(found) });
    intermediates.set(url.host, found); // solo se recuerdan si la cadena completa se verificó
    return result;
  }
}

/** Solo pruebas. */
export function resetHttpGetCaches(): void {
  intermediates.clear();
  discoveryFailed.clear();
}
