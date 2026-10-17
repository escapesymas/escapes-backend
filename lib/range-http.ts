/**
 * GET por http/https con comprobación del certificado «a lo navegador».
 *
 * Node solo usa los certificados que manda el servidor y su lista de raíces; si el
 * servidor no manda el certificado intermedio (static.bihr.pro, por ejemplo) falla con
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE aunque el navegador lo abra sin problema, porque los
 * navegadores descargan el intermedio de la dirección «CA Issuers» del propio certificado.
 * Aquí se hace lo mismo y la cadena se sigue verificando entera contra las raíces de Mozilla:
 * no se desactiva ninguna comprobación.
 */
import http from 'http';
import https from 'https';
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
  /** Raíces de confianza extra (solo pruebas). */
  extraRoots?: string[];
}

const CHAIN_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);
const MAX_CERT_BYTES = 64 * 1024;
const MAX_CHAIN_DEPTH = 4;

/** Intermedios encontrados por servidor, para no repetir la búsqueda. */
const intermediates = new Map<string, string[]>();

function once(url: URL, o: HttpGetOptions, ca?: string[]): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: o.headers, signal: AbortSignal.timeout(o.timeoutMs), ...(ca ? { ca } : {}) } as https.RequestOptions, (res) => {
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

/** Descarga un certificado (DER o PEM) de una dirección «CA Issuers». */
function downloadCertificate(uri: string, timeoutMs: number): Promise<X509Certificate> {
  return once(new URL(uri), {
    timeoutMs,
    onResponse: (status) => { if (status !== 200) throw new Error(`HTTP ${status}`); return MAX_CERT_BYTES; },
  }).then((r) => new X509Certificate(r.body));
}

/** Pide al servidor su certificado y sigue los «CA Issuers» hasta una raíz; devuelve los intermedios en PEM. */
async function discoverIntermediates(url: URL, timeoutMs: number): Promise<string[]> {
  const host = url.hostname;
  const leaf = await new Promise<X509Certificate>((resolve, reject) => {
    // Sin verificar: solo se lee el certificado; después la conexión de verdad sí se verifica.
    const socket = tls.connect({ host, port: Number(url.port) || 443, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate();
      socket.destroy();
      try { resolve(new X509Certificate(peer.raw)); } catch (err) { reject(err); }
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('sin respuesta a tiempo')); });
    socket.on('error', reject);
  });
  const found: string[] = [];
  let cert = leaf;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
    const uri = /CA Issuers - URI:(\S+)/.exec(cert.infoAccess || '')?.[1];
    if (!uri || !/^https?:\/\//i.test(uri)) break;
    const issuer = await downloadCertificate(uri, timeoutMs);
    found.push(issuer.toString());
    if (issuer.subject === issuer.issuer) break;
    cert = issuer;
  }
  return found;
}

export async function httpGet(urlStr: string, o: HttpGetOptions): Promise<HttpResult> {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') return once(url, o);
  const caWith = (extra: string[]) => (extra.length || o.extraRoots?.length ? [...tls.rootCertificates, ...(o.extraRoots || []), ...extra] : undefined);
  const known = intermediates.get(url.host);
  try {
    return await once(url, o, caWith(known || []));
  } catch (err: any) {
    if (!CHAIN_ERRORS.has(String(err?.code))) throw err;
    if (known) intermediates.delete(url.host); // el servidor ha cambiado de certificado: se vuelve a buscar
    let found: string[] = [];
    try { found = await discoverIntermediates(url, Math.min(o.timeoutMs, 15_000)); } catch { /* se devuelve el error original */ }
    if (found.length === 0) throw err;
    const result = await once(url, o, caWith(found));
    intermediates.set(url.host, found); // solo se recuerdan si la cadena completa se verificó
    return result;
  }
}
