// Procesa UNA imagen y termina: server.mjs lanza un proceso nuevo por imagen,
// así un archivo malicioso que llegara a explotar un fallo de las librerías no
// ve las imágenes de otros clientes. Entrada por stdin, opciones en argv[2],
// imagen resultante por stdout y sus medidas (JSON) por el descriptor 3.
import fs from 'node:fs';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);
// Solo se pueden abrir estos formatos, aunque el archivo diga ser otra cosa.
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: [
    'VipsForeignLoadJpegBuffer',
    'VipsForeignLoadPngBuffer',
    'VipsForeignLoadSpngBuffer',
    'VipsForeignLoadWebpBuffer',
    'VipsForeignLoadNsgifBuffer',
    'VipsForeignLoadHeifBuffer',
  ],
});

const MAX_PIXELS = 50_000_000;

/** Formato real según los primeros bytes (no según lo que diga el navegador). */
function detectType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (/^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(b.toString('latin1', 8, 12))) return 'heif';
  return null;
}

function fail(message, code = 2) {
  process.stderr.write(message);
  process.exit(code);
}

const opts = JSON.parse(process.argv[2] || '{}');
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);

const type = detectType(input);
if (!type || !opts.formatos.includes(type)) fail('formato no admitido');

let out;
try {
  out = await sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS, animated: false })
    .rotate()
    .resize({
      width: opts.ancho,
      height: opts.alto || undefined,
      fit: opts.ajuste,
      position: 'centre',
      withoutEnlargement: opts.ajuste === 'inside',
    })
    .webp({ quality: opts.calidad, effort: 4 })
    .toBuffer({ resolveWithObject: true });
} catch {
  fail('imagen no válida');
}

fs.writeSync(3, JSON.stringify({ ancho: out.info.width, alto: out.info.height }));
process.stdout.write(out.data, () => process.exit(0));
