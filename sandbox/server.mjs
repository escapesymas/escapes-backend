// Procesador de imágenes aislado (ver docker-compose.yml): el contenedor no
// tiene red, ni secretos, ni acceso a la base de datos, y su disco es de solo
// lectura. El backend le habla por un socket Unix en una carpeta compartida.
//
//   POST /procesar?ancho=512&alto=512&ajuste=cover&calidad=85&formatos=jpeg,png,webp
//     cuerpo: la imagen original → 200 con la imagen en WebP (cabeceras X-Ancho/X-Alto)
//     422 si no es una imagen admitida · 503 si está saturado
//   GET /salud → 200
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SOCKET = process.env.SOCKET_PATH || '/run/imgsock/imagenes.sock';
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const MAX_INPUT = 25 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_ACTIVE = 2;
const MAX_QUEUE = 100;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif']);

let active = 0;
const queue = [];

function runSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      active++;
      fn().then(resolve, reject).finally(() => {
        active--;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (active < MAX_ACTIVE) start();
    else if (queue.length < MAX_QUEUE) queue.push(start);
    else reject(Object.assign(new Error('ocupado'), { status: 503 }));
  });
}

/** Lee y valida las opciones: el backend es de confianza, pero no cuesta nada. */
function parseOptions(url) {
  const q = new URL(url, 'http://local').searchParams;
  const int = (k, min, max) => {
    const n = Number(q.get(k));
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const ancho = int('ancho', 16, 2400);
  const alto = q.has('alto') ? int('alto', 16, 2400) : 0;
  const calidad = int('calidad', 30, 95);
  const ajuste = q.get('ajuste');
  const formatos = String(q.get('formatos') || '').split(',').filter((f) => FORMATS.has(f));
  if (!ancho || alto === null || !calidad || !['cover', 'inside'].includes(ajuste) || !formatos.length) return null;
  return { ancho, alto, calidad, ajuste, formatos };
}

/** Un proceso nuevo por imagen, sin variables de entorno y con tiempo máximo. */
function processInWorker(input, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(opts)], {
      env: { UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '512m' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    const out = [];
    let outBytes = 0;
    let info = '';
    let err = '';
    let killed = false;
    const kill = () => { killed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, TIMEOUT_MS);

    child.stdout.on('data', (c) => {
      outBytes += c.length;
      if (outBytes > MAX_OUTPUT) kill();
      else out.push(c);
    });
    child.stdio[3].on('data', (c) => { if (info.length < 200) info += c; });
    child.stderr.on('data', (c) => { if (err.length < 200) err += c; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(Object.assign(new Error('tiempo o tamaño excedido'), { status: 422 }));
      if (code !== 0) return reject(Object.assign(new Error(err || `código ${code}`), { status: code === 2 ? 422 : 500 }));
      try {
        resolve({ data: Buffer.concat(out), info: JSON.parse(info) });
      } catch {
        reject(new Error('respuesta del trabajador no válida'));
      }
    });
    child.stdin.end(input);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_INPUT) {
        reject(Object.assign(new Error('imagen demasiado grande'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET' && req.url === '/salud') return json(200, { ok: true, activos: active, cola: queue.length });
    if (req.method !== 'POST' || !req.url?.startsWith('/procesar')) return json(404, { error: 'no encontrado' });
    const opts = parseOptions(req.url);
    if (!opts) return json(400, { error: 'opciones no válidas' });
    const input = await readBody(req);
    const { data, info } = await runSlot(() => processInWorker(input, opts));
    res.writeHead(200, { 'Content-Type': 'image/webp', 'X-Ancho': String(info.ancho), 'X-Alto': String(info.alto) });
    res.end(data);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[IMAGENES]', e.message);
    if (!res.headersSent) json(status, { error: status === 422 ? 'imagen no válida' : e.message });
  }
});
server.requestTimeout = 60_000;

// Un socket que quedó de un arranque anterior impide escuchar: se borra.
fs.rmSync(SOCKET, { force: true });
server.listen(SOCKET, () => {
  // El backend corre con otro usuario: tiene que poder conectarse.
  fs.chmodSync(SOCKET, 0o666);
  console.log(`[IMAGENES] escuchando en ${SOCKET}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
