import jwt from 'jsonwebtoken';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const query = process.argv.slice(2).join(' ') || 'necesito conformar un kit de transmision para mi BMW F 800 GS (2017)';
const targetHost = process.env.CHAT_HOST || 'escapesymas.com';
const isLocal = targetHost.includes('localhost') || targetHost.includes('127.0.0.1');

function getLocalJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const match = content.match(/^JWT_SECRET=(.+)$/m);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch {}
  return '123456789012345678901234567890123456';
}

function getAuthToken(): string {
  if (isLocal) {
    const localSecret = getLocalJwtSecret();
    return jwt.sign({ user_id: 1, email: 'adriansv.as@gmail.com', role: 'admin' }, localSecret);
  }
  try {
    const remoteToken = execSync(
      `ssh -o StrictHostKeyChecking=no root@212.227.134.161 "docker exec -i \\$(docker ps --format '{{.Names}}' | grep '^wg90ssxowlynpipdyxil35lw' | head -n 1) node -e \\"const jwt = require('jsonwebtoken'); console.log(jwt.sign({ user_id: 1, email: 'adriansv.as@gmail.com', role: 'admin' }, process.env.JWT_SECRET));\\""`,
      { encoding: 'utf-8', timeout: 8000 }
    ).trim();
    if (remoteToken && remoteToken.startsWith('ey')) {
      return remoteToken;
    }
  } catch {}
  return jwt.sign({ user_id: 1, email: 'adriansv.as@gmail.com', role: 'admin' }, getLocalJwtSecret());
}

const token = getAuthToken();
const postData = JSON.stringify({
  messages: [{ role: 'user', content: query }],
});

console.log(`\n🤖 ENVIANDO PREGUNTA AL CHATBOT (${targetHost}):`);
console.log(`💬 "${query}"\n`);
console.log('----------------------------------------------------');

const options = {
  hostname: targetHost,
  port: isLocal ? 3001 : 443,
  path: '/api/chat/message',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(postData),
  },
};

const client = isLocal ? http : https;

const req = client.request(options, (res) => {
  if (res.statusCode !== 200) {
    console.error(`⚠️ EL SERVIDOR RESPONDIÓ CON CÓDIGO HTTP ${res.statusCode}`);
    let errBody = '';
    res.on('data', (c) => (errBody += c.toString()));
    res.on('end', () => {
      console.error(`RESPUESTA: ${errBody}\n`);
    });
    return;
  }

  res.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.replace(/^data:\s*/, '').trim();
      if (!jsonStr) continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.delta) {
          process.stdout.write(data.delta);
        }
        if (data.products && Array.isArray(data.products)) {
          console.log('\n\n📦 TARJETAS DE PRODUCTOS DEVUELTAS POR EL ASISTENTE:');
          data.products.forEach((p: any, idx: number) => {
            console.log(`\n  ${idx + 1}. [SKU: ${p.sku}] ${p.brand} - ${p.name}`);
            console.log(`     Precio: ${(p.price / 100).toFixed(2)}€ | Stock: ${p.stock} ud | Slug: ${p.slug}`);
          });
        }
        if (data.done) {
          console.log('\n----------------------------------------------------\n');
        }
      } catch {}
    }
  });
});

req.on('error', (err: any) => {
  console.error('❌ Error de conexión:', err.message);
  if (isLocal && err.code === 'ECONNREFUSED') {
    console.error('💡 Pista: Para probar en local, debes tener arrancado el backend en otra terminal con `npm run dev`.');
  }
});

req.write(postData);
req.end();
