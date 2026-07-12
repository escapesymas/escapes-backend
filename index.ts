import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import fs from 'fs';
import os from 'os';
import { execSync, exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import path from 'path';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg;
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, eq, desc, and, type SQL } from 'drizzle-orm';
import {
  pgTable, serial, text, varchar, timestamp, integer
} from 'drizzle-orm/pg-core';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import {
  getLiveStockLevel, getLiveStockValue, checkProductsInfo, createBihrOrder, syncBihrCatalog
} from './bihrService.js';
import { checkRateLimit } from './redis.js';
import Stripe from 'stripe';
import rateLimit from 'express-rate-limit';

const stripeLiveKey = process.env.STRIPE_SECRET_KEY;
if (!stripeLiveKey) {
  console.warn('[WARNING] STRIPE_SECRET_KEY not set — Stripe payments will fail. Set it in .env');
}

const stripeLive = new Stripe(stripeLiveKey || 'sk_missing_set_env', {
  apiVersion: '2024-11-20.acacia' as any,
});

const stripeTestKey = process.env.STRIPE_TEST_SECRET_KEY;
const stripeTest = stripeTestKey
  ? new Stripe(stripeTestKey, { apiVersion: '2024-11-20.acacia' as any })
  : stripeLive;

const adminKey = process.env.ADMIN_KEY;
if (!adminKey) {
  console.warn('[WARNING] ADMIN_KEY not set — Bihr sync endpoints are unprotected!');
}

function requireAdminKey(req: any, res: any): boolean {
  const key = req.headers['x-admin-key'];
  if (!key || key !== adminKey) {
    res.status(401).json({ error: 'No autorizado' });
    return false;
  }
  return true;
}

function getStripeClient(req: any): any {
  // Always use live mode in production.
  return stripeLive;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function sendMail(to: string, subject: string, text: string, html?: string) {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.buzondecorreo.com",
      port: parseInt(process.env.SMTP_PORT || "465"),
      secure: true,
      auth: {
        user: process.env.SMTP_USER || "web@escapesymas.com",
        pass: process.env.SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true'
      }
    });
    
    await transporter.sendMail({
      from: '"Escapes y Más" <web@escapesymas.com>',
      to,
      subject,
      text,
      html
    });
    console.log(`[EMAIL] Sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`[EMAIL ERROR] Failed to send email to ${to}`, err);
  }
}

// ================================================================
// CONFIGURACIÓN
// ================================================================
const PORT = process.env.PORT || 3001;
const WP_URL = process.env.WP_URL || 'https://backendescapes.com';
const WOO_KEY = process.env.WOO_KEY;
const WOO_SECRET = process.env.WOO_SECRET;

// Startup validation: fail fast in production if critical vars are missing
const isProduction = process.env.NODE_ENV === 'production';
const requiredVars = [
  'DATABASE_URL',
  'JWT_SECRET',
  'REDIS_URL',
];
const missingRequired = requiredVars.filter(v => !process.env[v]);
if (missingRequired.length > 0) {
  const msg = `[FATAL] Missing required env vars: ${missingRequired.join(', ')}`;
  if (isProduction) {
    console.error(msg);
    process.exit(1);
  } else {
    console.warn(msg);
  }
}

// Warn on placeholder values in production
const placeholders = ['placeholder', 'change-me', '__', 'sk_test_placeholder', 'whsec_placeholder'];
const allVars = Object.entries(process.env);
for (const [key, value] of allVars) {
  if (!value) continue;
  if (isProduction && placeholders.some(p => value.includes(p))) {
    console.warn(`[WARNING] ${key} looks like a placeholder: ${value.slice(0, 20)}...`);
  }
}

// ================================================================
// BASE DE DATOS (PostgreSQL localhost en VPS)
// ================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

const db = drizzle(pool);

// Startup Database Alignment for Accounting Columns
(async () => {
  try {
    console.log('🔌 Aligning database schema for accounting and moderation...');
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cost INTEGER DEFAULT 0;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50);

      ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS is_pinned INTEGER DEFAULT 0;
      ALTER TABLE forum_posts ADD COLUMN IF NOT EXISTS is_closed INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS coupons (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        type VARCHAR(20) NOT NULL,
        value INTEGER NOT NULL,
        active INTEGER DEFAULT 1,
        expires_at TIMESTAMP,
        max_uses INTEGER DEFAULT 999999,
        times_used INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS seo_autolinks (
        id SERIAL PRIMARY KEY,
        keyword VARCHAR(255) NOT NULL UNIQUE,
        url VARCHAR(500) NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS carts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        session_token VARCHAR(255) UNIQUE NOT NULL,
        items TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL UNIQUE,
        invoice_number VARCHAR(50) NOT NULL UNIQUE,
        subtotal INTEGER DEFAULT 0,
        tax_amount INTEGER DEFAULT 0,
        shipping_cost INTEGER DEFAULT 0,
        discount_amount INTEGER DEFAULT 0,
        total INTEGER NOT NULL,
        pdf_path TEXT,
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS image_regen_state (
        id SERIAL PRIMARY KEY,
        status VARCHAR(50) DEFAULT 'idle',
        processed INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        current_sku VARCHAR(255) DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS product_attributes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS product_attribute_terms (
        id SERIAL PRIMARY KEY,
        attribute_id INTEGER REFERENCES product_attributes(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        UNIQUE(attribute_id, name)
      );

      CREATE TABLE IF NOT EXISTS product_variations (
        id SERIAL PRIMARY KEY,
        parent_product_id INTEGER NOT NULL,
        sku VARCHAR(255) UNIQUE,
        price INTEGER NOT NULL,
        stock_status VARCHAR(50) DEFAULT 'instock',
        stock_quantity INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS product_variation_attributes (
        id SERIAL PRIMARY KEY,
        variation_id INTEGER REFERENCES product_variations(id) ON DELETE CASCADE,
        attribute_id INTEGER REFERENCES product_attributes(id) ON DELETE CASCADE,
        term_id INTEGER REFERENCES product_attribute_terms(id) ON DELETE CASCADE,
        UNIQUE(variation_id, attribute_id)
      );
      
      INSERT INTO image_regen_state (id, status) VALUES (1, 'idle') ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS stock_notifications (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        email VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        notified BOOLEAN DEFAULT FALSE,
        UNIQUE(product_id, email)
      );
    `);
    console.log('✅ Database schema aligned successfully!');
    // Cargar mapa de categorías e índice de compatibilidades en segundo plano
    initCategoryMap().catch(e => console.error('[CATEGORY MAP INITIAL LOAD ERROR]:', e));
    initCompatIndex().catch(e => console.error('[COMPAT INDEX INITIAL LOAD ERROR]:', e));
  } catch (err) {
    console.error('❌ Failed to align database schema:', err);
  }
})();

// Esquema inline (replica de lib/schema.ts)
const users = pgTable('users', {
  id: serial('id').primaryKey(),
  wpId: integer('wp_id').unique(),
  username: varchar('username', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  avatarUrl: text('avatar_url'),
  rankLevel: integer('rank_level').default(1),
  rankXp: integer('rank_xp').default(0),
  role: varchar('role', { length: 20 }).default('customer'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

const forumPosts = pgTable('forum_posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  category: varchar('category', { length: 50 }).default('general'),
  likes: integer('likes').default(0),
  viewCount: integer('view_count').default(0),
  isPinned: integer('is_pinned').default(0),
  isClosed: integer('is_closed').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

const forumReplies = pgTable('forum_replies', {
  id: serial('id').primaryKey(),
  postId: integer('post_id').notNull(),
  userId: integer('user_id').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

const forumLikes = pgTable('forum_likes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  contentType: varchar('content_type', { length: 20 }).notNull(),
  contentId: integer('content_id').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

const garage = pgTable('garage', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  brand: varchar('brand', { length: 100 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  year: varchar('year', { length: 20 }).notNull(),
  isPrimary: integer('is_primary').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),
  total: integer('total').notNull(),
  status: varchar('status', { length: 50 }).default('pending'),
  paymentId: varchar('payment_id', { length: 255 }),
  shippingData: text('shipping_data'),
  subtotal: integer('subtotal').default(0),
  discountAmount: integer('discount_amount').default(0),
  shippingCost: integer('shipping_cost').default(0),
  promoCode: varchar('promo_code', { length: 50 }),
  createdAt: timestamp('created_at').defaultNow(),
  bihrTicketId: varchar('bihr_ticket_id', { length: 255 }),
  dropshippingStatus: varchar('dropshipping_status', { length: 50 }).default('not_sent'),
  trackingNumber: varchar('tracking_number', { length: 255 }),
  trackingUrl: varchar('tracking_url', { length: 500 }),
  costTotal: integer('cost_total').default(0),
});

const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id'),
  productId: integer('product_id'),
  quantity: integer('quantity').notNull(),
  price: integer('price').notNull(),
});

const coupons = pgTable('coupons', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  type: varchar('type', { length: 20 }).notNull(),
  value: integer('value').notNull(),
  active: integer('active').default(1),
  expiresAt: timestamp('expires_at'),
  maxUses: integer('max_uses').default(999999),
  timesUsed: integer('times_used').default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

const seoAutolinks = pgTable('seo_autolinks', {
  id: serial('id').primaryKey(),
  keyword: varchar('keyword', { length: 255 }).notNull().unique(),
  url: varchar('url', { length: 500 }).notNull(),
  active: integer('active').default(1),
  createdAt: timestamp('created_at').defaultNow(),
});

const pricingRules = pgTable('pricing_rules', {
  id: serial('id').primaryKey(),
  ruleType: varchar('rule_type', { length: 50 }).notNull(), // 'global', 'category', 'brand'
  targetId: varchar('target_id', { length: 100 }), // brand name or category ID
  marginPercent: integer('margin_percent').notNull(),
  active: integer('active').default(1),
  createdAt: timestamp('created_at').defaultNow(),
});


// ================================================================
// EXPRESS APP
// ================================================================
const app: any = express();
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = isProduction
  ? ['https://escapesymas.com', 'https://www.escapesymas.com']
  : [
      'https://escapesymas.com',
      'https://www.escapesymas.com',
      'https://test.escapesymas.com',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:5175',
      'http://localhost:3000',
      'http://localhost:3002',
    ];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  exposedHeaders: ['X-WP-Total', 'X-WP-TotalPages']
}));

// Attach authenticated user to req.user when a valid JWT is present
app.use((req: any, _res, next) => {
  const user = authenticateRequest(req);
  if (user) {
    req.user = user;
    req.userId = user.user_id;
  }
  next();
});

// Configuración de directorio de uploads
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Subdir para imágenes optimizadas (Bihr/Andreani)
const OPTIMIZED_DIR = path.join(uploadDir, 'optimized');
if (!fs.existsSync(OPTIMIZED_DIR)) {
  fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });
}

// Sanitiza un SKU para usarlo como nombre de archivo (reemplaza caracteres no seguros por _)
function sanitizeSkuForFilename(sku: string | null | undefined): string {
  if (!sku) return '';
  return String(sku).replace(/[^A-Za-z0-9._-]/g, '_');
}

// ¿Es una URL de imagen remota que deberíamos intentar reescribir a local?
function isRemoteImageUrl(s: string | null | undefined): boolean {
  if (!s) return false;
  if (typeof s !== 'string') return false;
  if (!/^https?:\/\//.test(s)) return false;
  if (s.includes('/uploads/optimized/')) return false;
  if (s.includes('placehold.co')) return false;
  return true;
}

// Helper: devuelve la URL local "/uploads/optimized/{sku}_{idx}_{size}.webp" si el archivo existe.
// Patrón nuevo (download_images_local.ts): {SKU}_{idx}_{size}.{format}
// idx=0 es imagen principal, idx>0 son galerías adicionales.
// Usa caché en memoria con TTL para evitar miles de stat por petición de catálogo.
const VARIANT_TO_SIZE: Record<ImageVariant, number> = {
  'desktop': 800,
  'mobile': 600,
  'card-desktop': 400,
  'card-mobile': 200,
};
type ImageVariant = 'desktop' | 'mobile' | 'card-desktop' | 'card-mobile';
const localImageCache = new Map<string, { result: string | null; expiresAt: number }>();
const LOCAL_IMAGE_CACHE_TTL_MS = 60_000;
const LOCAL_IMAGE_CACHE_MAX = 50_000;

function localImageForSku(sku: string | null | undefined, variant: ImageVariant = 'desktop', idx: number = 0): string | null {
  if (!sku) return null;
  const safeSku = sanitizeSkuForFilename(sku);
  if (!safeSku) return null;
  const size = VARIANT_TO_SIZE[variant];
  const key = `${safeSku}:${idx}:${size}`;
  const cached = localImageCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (localImageCache.size > LOCAL_IMAGE_CACHE_MAX) localImageCache.clear();

  const filename = `${safeSku}_${idx}_${size}.webp`;
  let exists = false;
  try {
    exists = fs.existsSync(path.join(OPTIMIZED_DIR, filename));
  } catch {}
  const result = exists ? `/uploads/optimized/${filename}` : null;
  localImageCache.set(key, { result, expiresAt: Date.now() + LOCAL_IMAGE_CACHE_TTL_MS });
  return result;
}

// Archivos estáticos ANTES del rate limiting
app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
}));

// ================================================================
// RATE LIMITING BÁSICO (100 req/min por IP) - Excluye uploads y health
// Usa Redis para funcionar correctamente en cluster PM2
// ================================================================
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60000;

const rateLimitSkipPaths = ['/uploads', '/api/health', '/api/catalog', '/api/image-proxy'];

app.use((req: any, res: any, next: any) => {
  const path = req.path || req.url || '';

  if (rateLimitSkipPaths.some(p => path.startsWith(p))) {
    return next();
  }

  const ip = req.ip || req.connection.remoteAddress || 'unknown';

  checkRateLimit(`global:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)
    .then(({ allowed, remaining, resetTime }) => {
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(resetTime));

      if (!allowed) {
        return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta más tarde.' });
      }
      next();
    })
    .catch(() => {
      next();
    });
});

app.use(express.json({ limit: '10mb' }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `avatar-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

app.post('/api/upload/avatar', upload.single('avatar'), async (req: any, res: any) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No se ha subido ningún archivo' });

    const { userId } = req.body;
    const url = `/uploads/${file.filename}`;

    if (userId) {
      await db.execute(sql`
        UPDATE users
        SET avatar_url = ${url}
        WHERE id = ${parseInt(userId)}
      `);
    }

    return res.json({ success: true, url });
  } catch (err: any) {
    console.error('[UPLOAD ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// SISTEMA DE CACHÉ EN MEMORIA (SWR - Stale While Revalidate)
// ================================================================
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  staleAt: number;
}

class SWRMemoryCache {
  private cache = new Map<string, CacheEntry<any>>();
  private maxEntries = 1000;

  public get<T>(key: string): { data: T; isStale: boolean } | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now > entry.staleAt) {
      this.cache.delete(key);
      return null;
    }
    return {
      data: entry.data,
      isStale: now > entry.expiresAt
    };
  }

  public set(key: string, data: any, ttlSeconds: number, staleGraceSeconds: number): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    const now = Date.now();
    this.cache.set(key, {
      data,
      expiresAt: now + (ttlSeconds * 1000),
      staleAt: now + ((ttlSeconds + staleGraceSeconds) * 1000)
    });
  }

  public invalidatePattern(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }
}

const swrCache = new SWRMemoryCache();

async function executeSWR<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number,
  staleGraceSeconds: number
): Promise<T> {
  const cached = swrCache.get<T>(key);

  if (cached) {
    if (cached.isStale) {
      fetchFn()
        .then(freshData => {
          swrCache.set(key, freshData, ttlSeconds, staleGraceSeconds);
        })
        .catch(err => {
          console.error(`[SWR] Background fetch failed for key ${key}:`, err);
        });
    }
    return cached.data;
  }

  const freshData = await fetchFn();
  swrCache.set(key, freshData, ttlSeconds, staleGraceSeconds);
  return freshData;
}


// ================================================================
// HELPERS DE SEGURIDAD
// ================================================================
function sanitizeString(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function buildInClause<T extends string | number>(values: T[]): SQL {
  if (values.length === 0) return sql`1=0`;
  if (values.length === 1) return sql`${values[0]}`;
  return sql.join(values.map(v => sql`${v}`), sql`, `);
}

function sanitizeLike(str: string): string {
  return sanitizeString(str).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function parseIntSafe(value: any): number | null {
  const parsed = parseInt(value);
  return isNaN(parsed) ? null : parsed;
}

function isLegacyPasswordHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (isLegacyPasswordHash(hash)) {
    const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
    return legacyHash === hash;
  }
  return bcrypt.compare(password, hash);
}

function generateJWT(user: any): string {
  const secret = process.env.JWT_SECRET || 'insecure-default-secret-change-me';
  return jwt.sign(
    {
      user_id: user.id,
      email: user.email,
      role: user.role || 'customer',
      username: user.username
    },
    secret,
    { expiresIn: '7d' }
  );
}

function setAuthCookie(res: any, token: string) {
  res.cookie('eym_jwt', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res: any) {
  res.cookie('eym_jwt', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
}

function verifyJWT(token: string): any | null {
  try {
    const secret = process.env.JWT_SECRET || 'insecure-default-secret-change-me';
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

function authenticateRequest(req: any): any | null {
  const authHeader = req.headers?.authorization;
  if (authHeader?.startsWith?.('Bearer ')) {
    const user = verifyJWT(authHeader.substring(7));
    if (user) return user;
  }

  const cookieHeader = req.headers?.cookie || '';
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((part: string) => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k] = decodeURIComponent(v.join('='));
  });
  if (cookies.eym_jwt) {
    const user = verifyJWT(cookies.eym_jwt);
    if (user) return user;
  }
  return null;
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/api/health', async (_req, res) => {
  let dbStatus = 'disconnected';
  let dbLatency = 0;

  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    dbLatency = Date.now() - start;
    dbStatus = 'connected';
  } catch (e) {
    dbStatus = 'error';
  }

  res.json({
    status: 'ok',
    version: '1.0.0',
    db: dbStatus,
    dbLatency: `${dbLatency}ms`,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health/stripe', async (_req: any, res: any) => {
  try {
    if (!stripeLiveKey) {
      return res.status(503).json({
        stripe: 'not_configured',
        message: 'STRIPE_SECRET_KEY no está configurada en .env del servidor',
        action: 'Configurar STRIPE_SECRET_KEY y reiniciar el proceso',
      });
    }
    const balance = await stripeLive.balance.retrieve();
    res.json({
      stripe: 'ok',
      keyPrefix: stripeLiveKey.substring(0, 12) + '...',
      keyLastChars: stripeLiveKey.slice(-6),
      mode: stripeLiveKey.startsWith('sk_live_') ? 'live' : stripeLiveKey.startsWith('sk_test_') ? 'test' : 'unknown',
      livemode: balance.livemode,
      currency: balance.available?.[0]?.currency || 'unknown',
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    const msg = e?.message || 'Unknown error';
    const isExpired = msg.includes('Expired API Key');
    const isInvalid = msg.includes('Invalid API Key');
    res.status(isExpired || isInvalid ? 503 : 500).json({
      stripe: isExpired ? 'expired' : isInvalid ? 'invalid' : 'error',
      keyPrefix: stripeLiveKey ? stripeLiveKey.substring(0, 12) + '...' : null,
      mode: stripeLiveKey?.startsWith('sk_live_') ? 'live' : stripeLiveKey?.startsWith('sk_test_') ? 'test' : 'unknown',
      message: msg,
      action: isExpired
        ? 'Renovar la clave en https://dashboard.stripe.com/apikeys y actualizar STRIPE_SECRET_KEY en ecosystem.config.cjs'
        : isInvalid
        ? 'Verificar que STRIPE_SECRET_KEY es correcta en ecosystem.config.cjs'
        : 'Revisar logs del backend para más detalles',
      requires_admin_action: true,
      timestamp: new Date().toISOString(),
    });
  }
});

// ================================================================
// IMAGE PROXY (Cloudflare-bypass for catalog images)
// El CDN Bihr bloquea con 403 a navegadores de usuarios finales.
// El VPS sí tiene acceso. Cacheamos en disco + optimizamos con sharp.
// ================================================================
const IMAGE_PROXY_CACHE_DIR = path.join(os.tmpdir(), 'image-proxy-cache');
if (!fs.existsSync(IMAGE_PROXY_CACHE_DIR)) {
  fs.mkdirSync(IMAGE_PROXY_CACHE_DIR, { recursive: true });
}

const imageProxyCache = new Map<string, { buffer: Buffer; contentType: string; expiresAt: number }>();
const IMAGE_PROXY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const IMAGE_PROXY_MAX_ENTRIES = 5000;
const ALLOWED_IMAGE_HOSTS = ['api.mybihr.com', 'bihr.net', 'cdn.mybihr.com'];
const ALLOWED_SIZES = new Set([200, 400, 600, 800]);

function diskPathFor(rawUrl: string, width: number): string {
  const hash = crypto.createHash('sha1').update(rawUrl).digest('hex');
  const subdir = hash.slice(0, 2);
  const dir = path.join(IMAGE_PROXY_CACHE_DIR, subdir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}-${width}.webp`);
}

app.get('/api/image-proxy', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '');
    if (!rawUrl) return res.status(400).json({ error: 'Missing url param' });

    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: 'Invalid url' }); }
    if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
      return res.status(400).json({ error: 'Host not allowed' });
    }

    const width = Math.max(100, Math.min(1600, parseInt(String(req.query.w || '400'), 10) || 400));
    const cacheKey = `${width}|${rawUrl}`;
    const diskFile = diskPathFor(rawUrl, width);

    // 1) Disco: archivo ya optimizado
    try {
      if (fs.existsSync(diskFile)) {
        const buf = fs.readFileSync(diskFile);
        res.set('Content-Type', 'image/webp');
        res.set('Cache-Control', 'public, max-age=2592000, immutable');
        res.set('X-Image-Proxy', 'DISK-HIT');
        return res.end(buf);
      }
    } catch {}

    // 2) Memoria: archivo recién optimizado
    const cached = imageProxyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.set('X-Image-Proxy', 'MEM-HIT');
      return res.end(cached.buffer);
    }

    // 3) Upstream
    const upstream = await fetch(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EscapesYMas/1.0; +https://escapesymas.com)',
        'Accept': 'image/jpeg,image/png,image/webp,image/*',
      },
    });

    if (!upstream.ok) {
      console.warn(`[image-proxy] upstream ${upstream.status} for ${rawUrl.substring(0, 80)}`);
      // Generar placeholder SVG para que la UI muestre algo en vez de imagen rota
      const placeholder = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}">` +
        `<rect width="100%" height="100%" fill="#1a1a1a"/>` +
        `<text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="#666" font-family="monospace" font-size="14">Imagen no disponible</text>` +
        `</svg>`
      );
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=3600');
      res.set('X-Image-Proxy', 'PLACEHOLDER');
      return res.end(placeholder);
    }

    const ab = await upstream.arrayBuffer();
    const originalBuffer = Buffer.from(ab);

    let optimized: Buffer;
    try {
      optimized = await sharp(originalBuffer)
        .resize({ width, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch (sharpErr: any) {
      console.error('[image-proxy] sharp error, fallback to original:', sharpErr.message);
      optimized = originalBuffer;
    }

    // Persistir en disco (fire & forget)
    fs.promises.writeFile(diskFile, optimized).catch(() => {});

    // Cache memoria
    if (imageProxyCache.size > IMAGE_PROXY_MAX_ENTRIES) imageProxyCache.clear();
    imageProxyCache.set(cacheKey, {
      buffer: optimized,
      contentType: 'image/webp',
      expiresAt: Date.now() + IMAGE_PROXY_TTL_MS,
    });

    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=2592000, immutable');
    res.set('X-Image-Proxy', 'MISS');
    res.end(optimized);
  } catch (err: any) {
    console.error('[image-proxy] error:', err.message);
    res.status(502).json({ error: 'Proxy error' });
  }
});

// ================================================================
// BIHR API INTEGRATION ROUTES
// ================================================================
app.get('/api/bihr/stock', async (req: any, res: any) => {
  const { productCode } = req.query;
  if (!productCode) {
    return res.status(400).json({ error: 'Falta el parámetro productCode (referencia de Bihr)' });
  }
  try {
    const status = await getLiveStockLevel(productCode as string);
    const quantity = await getLiveStockValue(productCode as string);
    res.json({ productCode, status, quantity });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al consultar stock en Bihr', details: error.message });
  }
});

app.post('/api/bihr/check-stock', async (req: any, res: any) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Falta la lista de items o no es un array válido' });
  }
  try {
    const results = await checkProductsInfo(items);
    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al consultar disponibilidad en lote', details: error.message });
  }
});

app.post('/api/bihr/order', async (req: any, res: any) => {
  const { deliveryAddress, items, customerOrderReference, isDropshipping } = req.body;
  if (!deliveryAddress || !items || !customerOrderReference) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para emitir el pedido' });
  }
  try {
    const orderResult = await createBihrOrder({
      deliveryAddress,
      items,
      customerOrderReference,
      isDropshipping: !!isDropshipping
    });
    res.json({ success: true, orderResult });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al emitir pedido en Bihr', details: error.message });
  }
});

app.post('/api/bihr/sync-catalog', async (req: any, res: any) => {
  if (!requireAdminKey(req, res)) return;
  const { catalogType } = req.body;
  try {
    syncBihrCatalog(catalogType || 'HardPart')
      .then(success => {
        console.log(`[BIHR SYNC BACKGROUND]: Sincronización finalizada con éxito: ${success}`);
      })
      .catch(err => {
        console.error('[BIHR SYNC BACKGROUND ERROR]:', err);
      });

    res.json({
      success: true,
      message: 'Sincronización iniciada en segundo plano. Puedes monitorear el progreso en el panel.'
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al iniciar la sincronización', details: error.message });
  }
});

app.get('/api/bihr/sync-status', async (req: any, res: any) => {
  if (!requireAdminKey(req, res)) return;
  try {
    // 1. Leer estado de imágenes desde PostgreSQL (migrado de /tmp/image_regen_state.json)
    let imageStats: any = null;
    try {
      const stateResult = await pool.query('SELECT * FROM image_regen_state WHERE id = 1');
      if (stateResult.rows.length > 0) {
        imageStats = stateResult.rows[0];
      }
    } catch (e) {
      // Fallback a fichero legacy si existe
      const imageStateFile = '/tmp/image_regen_state.json';
      if (fs.existsSync(imageStateFile)) {
        try {
          imageStats = JSON.parse(fs.readFileSync(imageStateFile, 'utf-8'));
        } catch {} 
      }
    }

    // 2. Leer estado de catálogo
    let catalogStats: any = null;
    const catalogStateFile = '/tmp/catalog_sync_state.json';
    if (fs.existsSync(catalogStateFile)) {
      try {
        catalogStats = JSON.parse(fs.readFileSync(catalogStateFile, 'utf-8'));
      } catch (e) {}
    }

    // 3. Comprobar si PM2 tiene el proceso image_downloader activo
    let imageDownloaderRunning = false;
    let pm2Status = 'stopped';
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const pm2List = JSON.parse(stdout);
      const proc = pm2List.find((p: any) => p.name === 'image_downloader');
      if (proc) {
        pm2Status = proc.pm2_env?.status || 'stopped';
        imageDownloaderRunning = pm2Status === 'online';
      }
    } catch (e) {
      console.error('[BIHR SYNC STATUS ERROR]: Error checking PM2 status:', e);
    }

    res.json({
      success: true,
      images: {
        ...(imageStats || { status: 'idle' }),
        pm2Status,
        running: imageDownloaderRunning
      },
      catalog: catalogStats || { status: 'idle' }
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener estado de sincronización', details: error.message });
  }
});

app.post('/api/bihr/sync-images/control', async (req: any, res: any) => {
  if (!requireAdminKey(req, res)) return;
  const { action } = req.body;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Acción no válida. Use: start, stop o restart' });
  }

  try {
    // Comprobar si el proceso está registrado en PM2
    let exists = false;
    try {
      const { stdout } = await execPromise('pm2 jlist');
      const pm2List = JSON.parse(stdout);
      exists = pm2List.some((p: any) => p.name === 'image_downloader');
    } catch (e) {}

    let command = '';
    if (action === 'start') {
      if (exists) {
        command = 'pm2 start image_downloader';
      } else {
        // Registrar e iniciar si no existe
        const scriptPath = path.join(process.cwd(), 'scripts', 'download_images_from_zip.py');
        command = `pm2 start "${scriptPath}" --name image_downloader --interpreter python3 -- --zip /tmp/bihr_catalog.zip --delay 0.3`;
      }
    } else if (action === 'stop') {
      command = 'pm2 stop image_downloader';
    } else if (action === 'restart') {
      command = 'pm2 restart image_downloader';
    }

    console.log(`[BIHR CONTROL]: Ejecutando comando: ${command}`);
    const { stdout } = await execPromise(command);
    res.json({ success: true, message: `Acción ${action} ejecutada correctamente`, output: stdout });
  } catch (error: any) {
    res.status(500).json({ error: `Fallo al ejecutar acción ${action} de imágenes`, details: error.message });
  }
});

// Estado del downloader de imágenes Andreani (lee BD + PM2)
app.get('/api/andreani/sync-images/status', async (req: any, res: any) => {
  try {
    let imageDownloaderRunning = false;
    let pm2Status = 'stopped';
    try {
      // Timeout 3s para evitar cuelgues si PM2 daemon no responde
      const proc = await Promise.race([
        execPromise('pm2 jlist'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pm2 timeout')), 3000)),
      ]).then(r => r.stdout).catch(() => '[]');
      const pm2List = JSON.parse(proc);
      const p = pm2List.find((x: any) => x.name === 'image_downloader_andreani');
      if (p) {
        pm2Status = p.pm2_env?.status || 'stopped';
        imageDownloaderRunning = pm2Status === 'online';
      }
    } catch (e) {
      // PM2 no disponible en local dev — no es error
    }
    res.json({ success: true, running: imageDownloaderRunning, pm2Status });
  } catch (error: any) {
    res.status(500).json({ error: 'Error al obtener estado Andreani', details: error.message });
  }
});

app.post('/api/andreani/sync-images/control', async (req: any, res: any) => {
  if (!requireAdminKey(req, res)) return;
  const { action } = req.body;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Acción no válida. Use: start, stop o restart' });
  }

  try {
    let exists = false;
    try {
      const out = await Promise.race([
        execPromise('pm2 jlist'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pm2 timeout')), 3000)),
      ]).then(r => r.stdout).catch(() => '[]');
      const pm2List = JSON.parse(out);
      exists = pm2List.some((p: any) => p.name === 'image_downloader_andreani');
    } catch (e) {}

    let command = '';
    if (action === 'start') {
      if (exists) {
        command = 'pm2 start image_downloader_andreani';
      } else {
        const scriptPath = path.join(process.cwd(), 'scripts', 'download_images_andreani.ts');
        command = `pm2 start "${scriptPath}" --name image_downloader_andreani --interpreter "npx" --interpreter-args "tsx"`;
      }
    } else if (action === 'stop') {
      command = 'pm2 stop image_downloader_andreani';
    } else if (action === 'restart') {
      command = 'pm2 restart image_downloader_andreani';
    }

    console.log(`[ANDREANI CONTROL]: Ejecutando comando: ${command}`);
    const { stdout } = await execPromise(command);
    res.json({ success: true, message: `Acción ${action} ejecutada correctamente`, output: stdout });
  } catch (error: any) {
    res.status(500).json({ error: `Fallo al ejecutar acción ${action} de imágenes Andreani`, details: error.message });
  }
});

let categoryMap: Record<number, { name: string; slug: string }> = {};
let categoryMapLoading = false;

async function initCategoryMap() {
  if (categoryMapLoading) return;
  categoryMapLoading = true;
  try {
    const res = await pool.query(
      `SELECT id, name, slug FROM categories WHERE status = 'active'`
    );
    const map: Record<number, { name: string; slug: string }> = {};
    for (const row of res.rows) {
      map[row.id] = { name: row.name, slug: row.slug };
    }
    categoryMap = map;
  } catch (err) {
    console.error('❌ Failed to load category map:', err);
  } finally {
    categoryMapLoading = false;
  }
}

let compatIndex: Map<string, Map<number, Array<{ sku: string, model: string }>>> | null = null;
let isIndexLoading = false;

async function initCompatIndex() {
  if (isIndexLoading) return;
  isIndexLoading = true;
  console.log('⚡ Loading compatibility index into memory...');
  const start = Date.now();
  try {
    const res = await pool.query(
      `SELECT sku, compatibility FROM products WHERE status = 'published' AND compatibility IS NOT NULL AND compatibility != '[]'`
    );
    const newIndex = new Map<string, Map<number, Array<{ sku: string, model: string }>>>();
    for (const row of res.rows) {
      if (!row.compatibility) continue;
      for (const item of row.compatibility) {
        if (!item.brand) continue;
        const bKey = item.brand.toLowerCase();
        const yKey = Number(item.year);
        if (isNaN(yKey)) continue;
        
        let yearMap = newIndex.get(bKey);
        if (!yearMap) {
          yearMap = new Map();
          newIndex.set(bKey, yearMap);
        }
        
        let list = yearMap.get(yKey);
        if (!list) {
          list = [];
          yearMap.set(yKey, list);
        }
        
        list.push({ sku: row.sku, model: item.model });
      }
    }
    compatIndex = newIndex;
    console.log(`✅ Compatibility index ready! Loaded ${newIndex.size} brands in ${Date.now() - start}ms`);
  } catch (err) {
    console.error('❌ Failed to build compatibility index:', err);
  } finally {
    isIndexLoading = false;
  }
}

// Recargar el índice cada 15 minutos para capturar importaciones externas
setInterval(() => {
  initCompatIndex().catch(e => console.error('[COMPAT INDEX AUTO REFRESH ERROR]:', e));
}, 15 * 60 * 1000);

// ================================================================
// VEHICLE DISCOVERY & COMPATIBILITY
// ================================================================
let catalog: any = null;
function getCatalog() {
  if (!catalog) {
    const filePath = path.join(__dirname, 'moto_catalog.json');
    if (!fs.existsSync(filePath)) {
      const altPath = path.join(process.cwd(), 'moto_catalog.json');
      if (fs.existsSync(altPath)) {
        catalog = JSON.parse(fs.readFileSync(altPath, 'utf-8'));
      } else {
        // Intenta cargarlo del directorio server/
        const serverPath = path.join(process.cwd(), 'server', 'moto_catalog.json');
        if (fs.existsSync(serverPath)) {
          catalog = JSON.parse(fs.readFileSync(serverPath, 'utf-8'));
        } else {
          throw new Error(`Catalog missing. Searched in: ${filePath}, ${altPath} and ${serverPath}`);
        }
      }
    } else {
      catalog = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  }
  return catalog;
}

app.get('/api/vehicles', async (req, res) => {
  const { action, brand, model, year } = req.query as any;

  try {
    const cacheKey = `/api/vehicles?action=${action || ''}&brand=${brand || ''}&model=${model || ''}&year=${year || ''}`;

    // Cachar jerarquía de vehículos por 5 min fresca, 30 min grace (SWR)
    const result = await executeSWR(cacheKey, async () => {
      try {
        const { hierarchy, compatibility } = getCatalog();

        if (action === 'brands') {
          return Object.keys(hierarchy).sort();
        }

        if (action === 'models') {
          return Object.keys(hierarchy[brand] || {}).sort();
        }

        if (action === 'years') {
          return Object.keys(hierarchy[brand]?.[model] || {}).sort((a: any, b: any) => b - a);
        }

        if (action === 'compatible-skus') {
          const skusSet = new Set<string>();

          // 1. Obtener SKUs compatibles desde la base de datos (compatibilidades sincronizadas) usando el índice en memoria
          if (brand) {
            const bKey = brand.toLowerCase();
            const mKey = model ? model.toLowerCase() : '';
            const yNum = year && year !== 'General' && year !== '' ? parseInt(year) : null;

            if (compatIndex) {
              const yearMap = compatIndex.get(bKey);
              if (yearMap) {
                if (yNum) {
                  const list = yearMap.get(yNum);
                  if (list) {
                    for (const item of list) {
                      if (mKey) {
                        const cModel = item.model?.toLowerCase() || '';
                        if (!cModel.includes(mKey) && !mKey.includes(cModel)) continue;
                      }
                      skusSet.add(item.sku);
                    }
                  }
                } else {
                  // Si no hay año, recorremos todos los años para esta marca
                  for (const list of yearMap.values()) {
                    for (const item of list) {
                      if (mKey) {
                        const cModel = item.model?.toLowerCase() || '';
                        if (!cModel.includes(mKey) && !mKey.includes(cModel)) continue;
                      }
                      skusSet.add(item.sku);
                    }
                  }
                }
              }
            } else {
              // Fallback directo a la base de datos si el índice no está listo aún
              console.warn('[VEHICLES COMPATIBILITY]: Index not ready, falling back to slow DB query');
              const params: any[] = [brand];
              let queryStr = `
                SELECT DISTINCT sku 
                FROM products 
                WHERE status = 'published' 
                  AND compatibility IS NOT NULL 
                  AND compatibility != '[]'
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(compatibility) elem
                    WHERE LOWER(elem->>'brand') = LOWER($1)
              `;
              
              let paramIdx = 2;
              if (yNum) {
                queryStr += ` AND (elem->>'year')::int = $${paramIdx++}`;
                params.push(yNum);
              }
              if (mKey) {
                queryStr += ` AND (
                  LOWER(elem->>'model') LIKE $${paramIdx}
                  OR $${paramIdx + 1} LIKE CONCAT('%', LOWER(elem->>'model'), '%')
                )`;
                params.push(`%${mKey}%`);
                params.push(mKey);
              }
              queryStr += `)`; // cierra EXISTS
              
              try {
                const dbRes = await pool.query(queryStr, params);
                dbRes.rows.forEach((r: any) => {
                  if (r.sku) skusSet.add(r.sku);
                });
              } catch (dbErr) {
                console.error('[VEHICLES DB COMPATIBILITY ERROR]:', dbErr);
              }
            }
          }

          // 2. Obtener SKUs compatibles desde moto_catalog.json (compatibilidades estáticas)
          if (brand && hierarchy[brand]) {
            let codes: string[] = [];
            if (model) {
              if (year && year !== 'General' && year !== '') {
                codes = hierarchy[brand][model]?.[year] || [];
              } else if (hierarchy[brand][model]) {
                Object.values(hierarchy[brand][model]).forEach((cList: any) => {
                  codes.push(...cList);
                });
              }
            } else {
              Object.values(hierarchy[brand]).forEach((modelsObj: any) => {
                if (modelsObj) {
                  Object.values(modelsObj).forEach((cList: any) => {
                    codes.push(...cList);
                  });
                }
              });
            }

            codes.forEach(code => {
              const vehicleSkus = compatibility[code] || [];
              vehicleSkus.forEach((sku: string) => skusSet.add(sku));
            });
          }

          return Array.from(skusSet);
        }

        throw new Error('Acción no válida');
      } catch (swrErr: any) {
        console.error('[VEHICLES SWR ERROR]:', swrErr);
        // Fallback: if moto_catalog.json is missing, query DB directly
        if (action === 'brands') {
          const result = await db.execute(sql`SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != '' ORDER BY brand`);
          return result.rows.map((r: any) => r.brand);
        }
        if (action === 'models' || action === 'years' || action === 'compatible-skus') {
          return [];
        }
        throw new Error('Acción no válida');
      }
    }, 300, 1800);

    return res.json(result);
  } catch (err: any) {
    console.error('[VEHICLES ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// CATÁLOGO PÚBLICO (sin autenticación)
// ================================================================

// ═══════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════════
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas acciones administrativas. Inténtalo más tarde.' }
});

const adminDestructiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas acciones destructivas. Espera una hora.' }
});

async function logAdminAction(req: any, action: string, details: Record<string, any> = {}) {
  try {
    const admin = authenticateRequest(req);
    const adminEmail = admin?.email || 'unknown';
    const adminId = admin?.user_id || null;
    const ip = req.ip || req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress || '';
    console.log(`[ADMIN AUDIT] ${new Date().toISOString()} action=${action} admin_email=${adminEmail} admin_id=${adminId} ip=${ip}`, JSON.stringify(details));
  } catch {
    // no-op
  }
}

const catalogLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones al catálogo. Inténtalo de nuevo.' }
});

import { chatHandler, chatHealthHandler } from './chatbot/index.js';

const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Has alcanzado el límite de mensajes del asistente. Espera 10 minutos.' }
});

const formsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados envíos. Por favor, espera 15 minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Por favor, espera 15 minutos.' }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SITEMAP ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/catalog/sitemap-skus', async (req, res) => {
  try {
    const page = parseInt((req.query.page as string) || '1', 10);
    const limit = parseInt((req.query.limit as string) || '10000', 10);
    const offset = (page - 1) * limit;

    const result = await db.execute(sql`
      SELECT id, slug, updated_at 
      FROM products 
      WHERE status = 'published'
      ORDER BY id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('[SITEMAP SKUS ERROR]:', error);
    res.status(500).json({ error: 'Failed to fetch sitemap SKUs' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH SUGGESTIONS ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/search/suggestions', async (req, res) => {
  try {
    const { q, limit = '5' } = req.query;

    if (!q || typeof q !== 'string' || q.length < 2) {
      res.json({ results: [] });
      return;
    }

    const searchTerm = sanitizeLike(q);
    const limitNum = Math.min(parseInt(limit as string) || 5, 10);

    const exactResult = await db.execute(sql`
      SELECT name, sku, brand
      FROM products
      WHERE status = 'published'
        AND name NOT LIKE 'Aplicaciones:%'
        AND name NOT LIKE 'Applications:%'
        AND (
          LOWER(name) LIKE LOWER('%' || ${searchTerm} || '%') ESCAPE '\'
          OR LOWER(sku) LIKE LOWER('%' || ${searchTerm} || '%') ESCAPE '\'
        )
      ORDER BY
        CASE WHEN LOWER(name) LIKE LOWER(${searchTerm} || '%') THEN 0 ELSE 1 END,
        name ASC
      LIMIT ${limitNum}
    `);

    if (exactResult.rows.length > 0) {
      const results = exactResult.rows.map(row => ({
        name: row.name,
        slug: row.sku,
        category: row.brand || '',
      }));
      return res.json({ results });
    }

    const fuzzyResult = await db.execute(sql`
      SELECT name, sku, brand,
             GREATEST(similarity(LOWER(name), LOWER(${searchTerm})),
                      similarity(LOWER(COALESCE(sku, '')), LOWER(${searchTerm}))) AS sim
      FROM products
      WHERE status = 'published'
        AND name NOT LIKE 'Aplicaciones:%'
        AND name NOT LIKE 'Applications:%'
        AND similarity(LOWER(name), LOWER(${searchTerm})) > 0.2
      ORDER BY sim DESC
      LIMIT ${limitNum}
    `);

    const fuzzyResults = fuzzyResult.rows.map(row => ({
      name: row.name,
      slug: row.sku,
      category: row.brand || '',
    }));
    return res.json({ results: fuzzyResults });
  } catch (err: any) {
    console.error('[SEARCH SUGGESTIONS ERROR]:', err);
    res.status(500).json({ error: 'Failed to fetch search suggestions', results: [] });
  }
});

app.get('/api/catalog/products', catalogLimiter, async (req, res) => {
  try {
    const { search, category_id, category_slug, page = '1', per_page = '20', universal, brand, min_price, max_price, in_stock, attrs } = req.query as any;
    const pageNum = parseInt(page) || 1;
    const perPage = Math.min(parseInt(per_page) || 20, 50);
    const offset = (pageNum - 1) * perPage;

    const cacheKey = `/api/catalog/products?search=${search || ''}&category_id=${category_id || ''}&page=${page}&per_page=${per_page}&universal=${universal || ''}&brand=${brand || ''}&min_price=${min_price || ''}&max_price=${max_price || ''}&in_stock=${in_stock || ''}&attrs=${attrs || ''}`;

    const result = await executeSWR(cacheKey, async () => {
      const conditions = sql`WHERE status IN ('published', 'active') AND name NOT LIKE 'Aplicaciones:%' AND name NOT LIKE 'Applications:%' AND sku NOT LIKE 'Aplicaciones:%' AND sku NOT LIKE 'Applications:%'`;

      if (universal === 'true') {
        conditions.append(sql` AND (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')`);
      }

      if (search) {
        const searchPattern = `%${sanitizeLike(search)}%`;
        conditions.append(sql`
          AND (
            LOWER(name) LIKE LOWER(${searchPattern}) ESCAPE '\\'
            OR LOWER(sku) LIKE LOWER(${searchPattern}) ESCAPE '\\'
            OR LOWER(description) LIKE LOWER(${searchPattern}) ESCAPE '\\'
            OR LOWER(supplier_code) LIKE LOWER(${searchPattern}) ESCAPE '\\'
            OR LOWER(barcode) LIKE LOWER(${searchPattern}) ESCAPE '\\'
            OR LOWER(old_part_number) LIKE LOWER(${searchPattern}) ESCAPE '\\'
          )`);
      }

      // Filter params
      if (brand) {
        const brandLower = brand.toLowerCase();
        conditions.append(sql` AND LOWER(brand) = LOWER(${brandLower})`);
      }
      if (min_price) {
        const mp = parseInt(min_price);
        if (!isNaN(mp)) conditions.append(sql` AND price >= ${mp * 100}`);
      }
      if (max_price) {
        const mp = parseInt(max_price);
        if (!isNaN(mp)) conditions.append(sql` AND price <= ${mp * 100}`);
      }
      if (in_stock === 'true') {
        conditions.append(sql` AND stock > 0`);
      }
      if (attrs) {
        try {
          const attrsObj = JSON.parse(attrs);
          if (typeof attrsObj === 'object' && !Array.isArray(attrsObj)) {
            conditions.append(sql` AND attributes @> ${attrsObj}::jsonb`);
          }
        } catch {}
      }

      if (category_id) {
        const catId = parseInt(category_id);
        if (!isNaN(catId)) {
          const parentId = Math.floor(catId / 100);
          conditions.append(sql`
            AND (
              category_id IN (
                WITH RECURSIVE descendants AS (
                  SELECT id FROM categories WHERE id = ${catId}
                  UNION ALL
                  SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
                )
                SELECT id FROM descendants
              )
              OR (category_id = ${parentId})
            )`);
        }
      }
      if (category_slug && !category_id) {
        const slugLower = String(category_slug).toLowerCase();
        conditions.append(sql`
          AND category_id IN (
            WITH RECURSIVE descendants AS (
              SELECT id FROM categories WHERE LOWER(slug) LIKE ${'%' + slugLower + '%'} OR LOWER(name) LIKE ${'%' + slugLower + '%'}
              UNION ALL
              SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
            )
            SELECT id FROM descendants
          )`);
      }

      const countRes = await db.execute(sql`SELECT count(*) as total FROM (SELECT 1 FROM products ${conditions} LIMIT 10000) sub`);
      const total = Number(countRes.rows[0]?.total || 0);
      const totalPages = total > 10000 ? Math.ceil(10000 / perPage) : Math.ceil(total / perPage) || 1;

      const productsRes = await db.execute(sql`
        SELECT * FROM (
          SELECT DISTINCT ON (split_part(p.name, ',', 1))
            p.*,
            COALESCE((SELECT avg_rating FROM product_rating_stats WHERE product_id = p.id), 0) AS avg_rating,
            COALESCE((SELECT review_count FROM product_rating_stats WHERE product_id = p.id), 0) AS review_count
          FROM products p
          ${conditions}
          ORDER BY split_part(p.name, ',', 1), p.stock DESC, p.id ASC
        ) distinct_products
        ORDER BY created_at DESC
        LIMIT ${perPage} OFFSET ${offset}
      `);
      const products = productsRes.rows.map(mapProductToFrontend);

      return { products, total, totalPages };
    }, 60, 600);

    res.setHeader('Access-Control-Expose-Headers', 'X-WP-Total, X-WP-TotalPages');
    res.setHeader('X-WP-Total', result.total.toString());
    res.setHeader('X-WP-TotalPages', result.totalPages.toString());
    res.json(result.products);
  } catch (err: any) {
    console.error('[CATALOG ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// FILTER OPTIONS
// ================================================================
const FILTER_ATTR_KEYS = new Set([
  'Talla', 'Color',
  'Estilo de casco', 'Tipo de cierre', 'Modelo de casco',
  'Estilo de pintura', 'Acabado de la pintura',
  'Composición', 'Homologación', 'Colección',
  'Tipo de pieza de repuesto'
]);

app.get('/api/catalog/filters', async (req, res) => {
  try {
    const { category_id, search, universal } = req.query as any;

    const cacheKey = `/api/catalog/filters?category_id=${category_id || ''}&search=${search || ''}&universal=${universal || ''}`;

    const result = await executeSWR(cacheKey, async () => {
      const conditions = sql`WHERE status = 'published'`;

      if (universal === 'true') {
        conditions.append(sql` AND (compatibility IS NULL OR compatibility = '[]'::jsonb OR compatibility::text = '[]')`);
      }

      if (search) {
        const searchPattern = `%${sanitizeLike(search)}%`;
        conditions.append(sql` AND (LOWER(name) LIKE LOWER(${searchPattern}) ESCAPE '\\' OR LOWER(sku) LIKE LOWER(${searchPattern}) ESCAPE '\\')`);
      }

      if (category_id) {
        const catId = parseInt(category_id);
        if (!isNaN(catId)) {
          conditions.append(sql` AND category_id IN (
            WITH RECURSIVE descendants AS (
              SELECT id FROM categories WHERE id = ${catId}
              UNION ALL
              SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
            )
            SELECT id FROM descendants
          )`);
        }
      }

      const attrKeysArr = Array.from(FILTER_ATTR_KEYS);

      const [brandsRes, priceRes, attrsRes] = await Promise.all([
        db.execute(sql`SELECT DISTINCT brand FROM products ${conditions} AND brand IS NOT NULL AND brand != '' ORDER BY brand`),
        db.execute(sql`SELECT MIN(price) as min_p, MAX(price) as max_p FROM products ${conditions}`),
        db.execute(sql`
          SELECT att.key, JSON_AGG(DISTINCT att.value) AS values
          FROM products p, jsonb_each_text(p.attributes) AS att(key, value)
          ${conditions}
            AND att.value IS NOT NULL AND att.value != ''
            AND att.key IN (${buildInClause(attrKeysArr)})
          GROUP BY att.key
          ORDER BY att.key
        `)
      ]);

      const brands = brandsRes.rows.map((r: any) => r.brand).filter(Boolean);
      const priceMinRow: any = priceRes.rows[0] || {};
      const priceMin = priceMinRow.min_p ? Math.round(Number(priceMinRow.min_p) / 100) : 0;
      const priceMax = priceMinRow.max_p ? Math.round(Number(priceMinRow.max_p) / 100) : 1000;

      const attributes: Record<string, string[]> = {};
      for (const row of attrsRes.rows) {
        const r: any = row;
        attributes[r.key] = r.values;
      }

      return { brands, price_min: priceMin, price_max: priceMax, attributes };
    }, 300, 1800);

    res.json(result);
  } catch (err: any) {
    console.error('[FILTERS ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/product/:id', async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT p.*,
             COALESCE(rs.avg_rating, 0) AS avg_rating,
             COALESCE(rs.review_count, 0) AS review_count
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
      WHERE p.id = ${parseInt(req.params.id)} AND p.status = 'published'
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapProductToFrontend(result.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const fbCache = new Map<string, { data: any[]; expiresAt: number }>();
const FB_TTL_MS = 5 * 60 * 1000;

app.get('/api/catalog/frequently-bought-together/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId)) return res.json([]);

    const cached = fbCache.get(String(productId));
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    const result = await db.execute(sql`
      WITH related AS (
        SELECT oi2.product_id AS related_id, COUNT(*) AS co_count
        FROM order_items oi1
        JOIN order_items oi2 ON oi1.order_id = oi2.order_id
        WHERE oi1.product_id = ${productId} AND oi2.product_id != ${productId}
        GROUP BY oi2.product_id
        ORDER BY co_count DESC
        LIMIT 6
      )
      SELECT p.id, p.sku, p.name, p.brand, p.price, p.sale_price, p.stock, p.images,
             r.co_count
      FROM related r
      JOIN products p ON p.id = r.related_id
      WHERE p.status = 'published' AND p.stock > 0
      ORDER BY r.co_count DESC
      LIMIT 6
    `);

    const items = (result.rows as any[]).map((row) => {
      let imgs: any[] = [];
      try {
        imgs = typeof row.images === 'string' ? JSON.parse(row.images) : (row.images || []);
      } catch {}
      let firstImage: string = imgs[0]?.src || imgs[0]?.url || '';
      if (firstImage && /^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(firstImage)) {
        firstImage = `/api/image-proxy?w=400&url=${encodeURIComponent(firstImage)}`;
      }
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        brand: row.brand,
        price: row.price,
        sale_price: row.sale_price,
        stock: row.stock,
        image: firstImage,
        co_count: row.co_count,
      };
    });

    fbCache.set(String(productId), { data: items, expiresAt: Date.now() + FB_TTL_MS });
    res.json(items);
  } catch (err: any) {
    console.error('[FREQ BOUGHT ERROR]:', err);
    res.json([]);
  }
});

app.get('/api/catalog/product-by-slug/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const sku = slug.replace(/-/g, '');
    const result = await db.execute(sql`
      SELECT p.*,
             COALESCE(rs.avg_rating, 0) AS avg_rating,
             COALESCE(rs.review_count, 0) AS review_count
      FROM products p
      LEFT JOIN product_rating_stats rs ON rs.product_id = p.id
      WHERE p.sku = ${sku} AND p.status = 'published'
      LIMIT 1
    `);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json(mapProductToFrontend(result.rows[0]));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/product-by-sku/:sku/variants', async (req, res) => {
  try {
    const sku = req.params.sku;
    const productRes = await db.execute(sql`SELECT * FROM products WHERE sku = ${sku}`);
    if (productRes.rows.length === 0) return res.json([]);
    
    const product = productRes.rows[0];
    let parentSku = '';
    
    if (product.attributes) {
      let attrs: any = {};
      try {
        attrs = typeof product.attributes === 'string' ? JSON.parse(product.attributes) : product.attributes;
      } catch (e) {}
      parentSku = attrs.parent_sku || '';
    }
    
    if (parentSku) {
      const variantsRes = await db.execute(sql`
        SELECT * FROM products 
        WHERE attributes->>'parent_sku' = ${parentSku} 
          AND status = 'published'
        ORDER BY price ASC
      `);
      return res.json(variantsRes.rows.map(mapProductToFrontend));
    }
    
    const baseName = (product as any).name?.split(',')[0].trim() || '';
    if (baseName.length > 8) {
      const variantsRes = await db.execute(sql`
        SELECT * FROM products 
        WHERE name LIKE ${baseName + '%'} 
          AND status = 'published'
        ORDER BY price ASC
        LIMIT 100
      `);
      return res.json(variantsRes.rows.map(mapProductToFrontend));
    }
    
    return res.json([mapProductToFrontend(product)]);
  } catch (err: any) {
    console.error('[VARIANTS ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/product-compatibility/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.json([]);
    
    const productRes = await db.execute(sql`SELECT compatibility FROM products WHERE id = ${id}`);
    if (productRes.rows.length === 0) return res.json([]);
    
    const row = productRes.rows[0];
    let compatibility: any[] = [];
    try {
      if (row.compatibility) {
        compatibility = typeof row.compatibility === 'string' ? JSON.parse(row.compatibility) : row.compatibility;
      }
    } catch (e) {}
    
    return res.json(compatibility);
  } catch (err: any) {
    console.error('[COMPATIBILITY ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/stock-check', async (req, res) => {
  try {
    const { ids } = req.query as any;
    if (!ids) return res.status(400).json({ error: 'Falta ids' });
    const idsList = ids.split(',').map((id: string) => parseInt(id)).filter((id: number) => !isNaN(id) && id > 0);
    if (idsList.length === 0) return res.json({ checks: [] });

    const result = await db.execute(sql`
      SELECT id, sku, name, stock
      FROM products
      WHERE id IN (${sql.join(idsList.map((id: number) => sql`${id}`), sql`, `)})
    `);

    const checks = (result.rows as any[]).map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      stock: typeof row.stock === 'string' ? parseInt(row.stock) : (row.stock || 0),
      available: (typeof row.stock === 'string' ? parseInt(row.stock) : (row.stock || 0)) > 0,
    }));

    return res.json({ checks });
  } catch (err: any) {
    console.error('[STOCK CHECK ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catalog/products-by-skus', async (req, res) => {
  try {
    const { skus, ids, category_id } = req.query as any;

    const conditions = sql`WHERE status = 'published'`;

    if (ids) {
      const idsList = ids.split(',').map((id: string) => parseInt(id)).filter((id: number) => !isNaN(id));
      if (idsList.length === 0) return res.json([]);
      conditions.append(sql` AND id IN (${buildInClause(idsList)})`);
    } else if (skus) {
      const skusList = skus.split(',').map((s: string) => sanitizeString(s.trim()));
      if (skusList.length === 0) return res.json([]);
      conditions.append(sql` AND sku IN (${buildInClause(skusList)})`);
    } else {
      return res.json([]);
    }

    if (category_id) {
      const catId = parseInt(category_id);
      if (!isNaN(catId)) {
        const parentId = Math.floor(catId / 100);
        conditions.append(sql`
          AND (
            category_id IN (
              WITH RECURSIVE descendants AS (
                SELECT id FROM categories WHERE id = ${catId}
                UNION ALL
                SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
              )
              SELECT id FROM descendants
            )
            OR category_id = ${parentId}
          )`);
      }
    }

    const productsRes = await db.execute(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (split_part(name, ',', 1)) *
        FROM products
        ${conditions}
        ORDER BY split_part(name, ',', 1), stock DESC, id ASC
      ) distinct_products
      ORDER BY price ASC
    `);
    const products = productsRes.rows.map(mapProductToFrontend);
    return res.json(products);
  } catch (err: any) {
    console.error('[PRODUCTS BY SKUS ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const { userId, email, status } = req.query as any;
    if (!userId && !email) return res.status(400).json({ error: 'Falta userId o email' });

    const conditions = sql`WHERE 1=1`;
    if (status && status !== 'all') {
      conditions.append(sql` AND status = ${status}`);
    }
    if (userId) {
      const safeUserId = parseIntSafe(userId);
      if (!safeUserId) return res.status(400).json({ error: 'userId inválido' });
      conditions.append(sql` AND user_id = ${safeUserId}`);
    } else if (email) {
      conditions.append(sql` AND shipping_data->>'email' = ${email}`);
    }

    conditions.append(sql` ORDER BY created_at DESC LIMIT 5`);

    const ordersRes = await db.execute(sql`SELECT * FROM orders ${conditions}`);
    const result = ordersRes.rows.map((row: any) => {
      let shippingDataObj = {};
      try {
        shippingDataObj = typeof row.shippingData === 'string' ? JSON.parse(row.shippingData) : row.shippingData;
      } catch (e) {}

      return {
        id: row.id,
        status: row.status,
        total: row.total / 100,
        payment_method: 'card',
        billing: shippingDataObj,
        created_at: row.createdAt
      };
    });

    return res.json(result);
  } catch (err: any) {
    console.error('[ORDERS GET ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// COMPARTIDO & FACTURACIÓN PDF
// ================================================================
async function createInvoiceForOrder(orderId: number) {
  // Check if invoice already exists
  const existingInv = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
  if (existingInv.rows.length > 0) {
    return existingInv.rows[0];
  }

  // Load order
  const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${orderId}`);
  const order = orderRes.rows[0] as any;
  if (!order) throw new Error('Pedido no encontrado');

  // Generate invoice number: EYMAS-YYYY-NNNNNN
  const year = new Date().getFullYear();
  const countRes = await db.execute(sql`SELECT COUNT(*) as cnt FROM invoices WHERE issued_at >= date_trunc('year', NOW())`);
  const seqNum = String((Number((countRes.rows[0] as any).cnt) + 1)).padStart(6, '0');
  const invoiceNumber = `EYMAS-${year}-${seqNum}`;

  // Fetch items from database (order_items table!)
  const itemsRes = await db.execute(sql`
    SELECT oi.*, p.name as product_name
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ${orderId}
  `);
  const items = itemsRes.rows as any[];

  const shippingData = (() => { try { return JSON.parse(order.shipping_data || '{}'); } catch { return {}; } })();
  const subtotal = order.subtotal || order.total || 0;
  const shippingCost = order.shipping_cost || 0;
  const discountAmount = order.discount_amount || 0;
  const totalCents = order.total || 0;

  // COGS (cost_total) update: let's also update order.cost_total if not set!
  let calculatedCostTotal = 0;
  for (const item of items) {
    const pCostRes = await db.execute(sql`SELECT cost FROM products WHERE id = ${item.product_id}`);
    const costVal = pCostRes.rows[0] ? (pCostRes.rows[0] as any).cost || 0 : 0;
    calculatedCostTotal += costVal * (item.quantity || 1);
  }
  
  if (calculatedCostTotal > 0 && (!order.cost_total || order.cost_total === 0)) {
    await db.execute(sql`UPDATE orders SET cost_total = ${calculatedCostTotal} WHERE id = ${orderId}`);
  }

  // IVA 21% inverso del total bruto
  const taxAmount = Math.round(totalCents * 21 / 121);

  // Generate PDF
  const invoicesDir = path.join(process.cwd(), 'invoices');
  if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir, { recursive: true });
  const pdfFileName = `${invoiceNumber}.pdf`;
  const pdfPath = path.join(invoicesDir, pdfFileName);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // ── HEADER ──────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').text('ESCAPES Y MÁS', 50, 50);
    doc.fontSize(9).font('Helvetica').fillColor('#666666')
      .text('info@escapesymas.com  |  www.escapesymas.com', 50, 78)
      .text('CIF: B-XXXXXXXX  |  Dirección fiscal: C/ Ejemplo 1, 28001 Madrid', 50, 90);

    // Invoice title block
    doc.fillColor('#FF6B00').roundedRect(400, 45, 145, 55, 4).fill();
    doc.fillColor('#FFFFFF').fontSize(11).font('Helvetica-Bold')
      .text('FACTURA', 415, 55)
      .fontSize(10).font('Helvetica')
      .text(invoiceNumber, 415, 72)
      .text(new Date().toLocaleDateString('es-ES'), 415, 86);

    doc.fillColor('#000000');

    // ── DIVIDER ──────────────────────────────────────────────────
    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#EEEEEE').lineWidth(1).stroke();

    // ── BILLING DATA ─────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('FACTURAR A:', 50, 130);
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
      .text(`${shippingData.firstName || ''} ${shippingData.lastName || ''}`, 50, 145)
      .text(shippingData.email || '', 50, 158)
      .text(shippingData.address || '', 50, 171)
      .text(`${shippingData.city || ''} ${shippingData.postcode || ''} ${shippingData.country || ''}`, 50, 184);

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#888888').text('PEDIDO Nº:', 350, 130);
    doc.fontSize(10).font('Helvetica').fillColor('#000000')
      .text(`#${order.id}`, 350, 145)
      .text(new Date(order.created_at).toLocaleDateString('es-ES'), 350, 158);

    // ── LINE ITEMS ────────────────────────────────────────────────
    const tableTop = 220;
    doc.fillColor('#1A1A1A').rect(50, tableTop, 495, 20).fill();
    doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
      .text('DESCRIPCIÓN', 58, tableTop + 6)
      .text('CANT.', 370, tableTop + 6)
      .text('PRECIO UNIT.', 410, tableTop + 6)
      .text('TOTAL', 475, tableTop + 6);

    doc.fillColor('#000000');
    let yPos = tableTop + 28;
    let lineNum = 0;

    for (const item of items) {
      if (lineNum % 2 === 0) {
        doc.fillColor('#F9F9F9').rect(50, yPos - 4, 495, 18).fill();
      }
      const unitPrice = ((item.price || 0) / 100).toFixed(2);
      const lineTotal = (((item.price || 0) * (item.quantity || 1)) / 100).toFixed(2);
      doc.fillColor('#222222').fontSize(9).font('Helvetica')
        .text(item.product_name || item.name || 'Producto', 58, yPos, { width: 300 })
        .text(String(item.quantity || 1), 380, yPos)
        .text(`${unitPrice}€`, 415, yPos)
        .text(`${lineTotal}€`, 472, yPos);
      yPos += 20;
      lineNum++;
    }

    // ── TOTALS ────────────────────────────────────────────────────
    yPos += 10;
    doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#EEEEEE').lineWidth(0.5).stroke();
    yPos += 12;

    const totalBlock = (label: string, val: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .fillColor(bold ? '#FF6B00' : '#333333')
        .text(label, 350, yPos)
        .text(val, 472, yPos);
      yPos += bold ? 18 : 16;
    };

    if (discountAmount > 0) totalBlock('Descuento:', `-${(discountAmount / 100).toFixed(2)}€`);
    if (shippingCost > 0) totalBlock('Envío:', `${(shippingCost / 100).toFixed(2)}€`);
    totalBlock('Base imponible:', `${((totalCents - taxAmount) / 100).toFixed(2)}€`);
    totalBlock('IVA (21%):', `${(taxAmount / 100).toFixed(2)}€`);
    totalBlock('TOTAL:', `${(totalCents / 100).toFixed(2)}€`, true);

    // ── FOOTER ────────────────────────────────────────────────────
    doc.fontSize(7).fillColor('#AAAAAA')
      .text('Gracias por tu confianza en Escapes y Más. Esta factura es el documento legal de tu compra.', 50, 760, { align: 'center', width: 495 });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // Save invoice record
  try {
    await db.execute(sql`
      INSERT INTO invoices (order_id, invoice_number, subtotal, tax_amount, shipping_cost, discount_amount, total, pdf_path)
      VALUES (${orderId}, ${invoiceNumber}, ${subtotal}, ${taxAmount}, ${shippingCost}, ${discountAmount}, ${totalCents}, ${pdfPath})
    `);
  } catch (err: any) {
    if (err.code === '23505') { // Unique constraint violation in postgres
      const dup = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
      return dup.rows[0];
    }
    throw err;
  }

  const invRes = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${orderId}`);
  return invRes.rows[0];
}

app.get('/api/orders/download-invoice', async (req: any, res: any) => {
  const { orderId, userEmail } = req.query as any;
  if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

  try {
    const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${parseInt(orderId)}`);
    const order = orderRes.rows[0] as any;
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

    let isAuthorized = false;
    if (userEmail) {
      if (userEmail.toLowerCase() === 'info@escapesymas.com') {
        isAuthorized = true;
      } else {
        const uRes = await db.execute(sql`SELECT id FROM users WHERE email = ${userEmail}`);
        if (uRes.rows.length > 0 && uRes.rows[0].id === order.user_id) {
          isAuthorized = true;
        }
      }
    }

    if (!isAuthorized) {
      return res.status(401).json({ error: 'No autorizado para ver esta factura' });
    }

    const invRow = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${parseInt(orderId)}`);
    if (!invRow.rows.length) {
      return res.status(404).json({ error: 'Factura no generada todavía.' });
    }

    const inv = invRow.rows[0] as any;
    const pdfFile = inv.pdf_path;

    if (!pdfFile || !fs.existsSync(pdfFile)) {
      return res.status(404).json({ error: 'Archivo PDF no encontrado en el servidor.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);
    fs.createReadStream(pdfFile).pipe(res);
  } catch (err: any) {
    console.error('[CUSTOMER INVOICE DOWNLOAD ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN (requiere autenticación)
// ================================================================
app.post('/api/auth/logout', (req: any, res: any) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.all('/api/admin', adminLimiter, async (req, res) => {
  const { action, userId, email } = req.query as any;

  let isAdmin = false;
  let jwtUser: any = null;

  const auth = authenticateRequest(req);
  if (auth && auth.role === 'admin') {
    isAdmin = true;
    jwtUser = auth;
  }

  // Rutas públicas del catálogo (legacy compat)
  if (action?.startsWith('catalog-')) {
    // Redirigir internamente
    if (action === 'catalog-products') {
      req.query = { ...req.query, ...{ search: req.query.search, page: req.query.page, per_page: req.query.per_page } };
      return app._router.handle(Object.assign(req, { url: '/api/catalog/products', method: 'GET' }), res, () => {});
    }
  }

  // Allow moderate-thread for thread owners (checked inside the action handler)
  if (!isAdmin && action === 'moderate-thread') {
    // Skip admin check, let the action handler verify ownership
  } else if (!isAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    switch (action) {
      case 'dashboard-stats': {
        const uR = await db.execute(sql`SELECT count(*) as count FROM users`);
        const pR = await db.execute(sql`SELECT count(*) as count FROM forum_posts`);
        const oR = await db.execute(sql`SELECT count(*) as count FROM orders`);
        const sR = await db.execute(sql`SELECT COALESCE(SUM(total), 0) as total FROM orders`);
        
        // VPS Telemetry
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memPercent = Math.round((usedMem / totalMem) * 100);
        
        // 1-minute load average
        const cpuLoad = os.loadavg()[0];
        const cpuCores = os.cpus().length;
        const cpuPercent = Math.min(Math.round((cpuLoad / cpuCores) * 100), 100);

        let diskStats = { total: "115G", used: "20.5G", free: "94.5G", percent: "18%" };
        try {
          const dfOutput = execSync("df -h / | tail -n 1").toString();
          const parts = dfOutput.split(/\s+/);
          if (parts.length >= 5) {
            diskStats = {
              total: parts[1],
              used: parts[2],
              free: parts[3],
              percent: parts[4]
            };
          }
        } catch (e) {}

        // Image Optimization stats - lee estado del script Python
        let imageStats: any = {
          status: "En Proceso",
          optimized: 0,
          omitted: 0,
          failed: 0,
          total: 103989,
          purged: 0,
          purgedTotal: 0,
          cardOptimized: 0,
          cardPending: 0,
          cardTotal: 0,
          regenerating: false,
          regenProcessed: 0,
          regenSuccess: 0,
          regenFailed: 0,
          regenSkipped: 0,
          regenCurrentSku: '',
          regenPercent: 0
        };
        
        // Leer estado del script de regeneración de imágenes
        try {
          let usedFallback = false;
          const stateResult = await pool.query('SELECT * FROM image_regen_state WHERE id = 1');
          if (stateResult.rows.length > 0) {
            const state = stateResult.rows[0];
            if (state.status !== 'idle') {
              imageStats.regenerating = state.status === 'running';
              imageStats.regenProcessed = state.processed || 0;
              imageStats.regenSuccess = state.success || 0;
              imageStats.regenFailed = state.failed || 0;
              imageStats.regenSkipped = state.skipped || 0;
              imageStats.regenCurrentSku = state.current_sku || '';
              if (state.total > 0) {
                imageStats.regenPercent = Math.round((state.processed / state.total) * 100);
              }
              if (state.status === 'completed') {
                imageStats.status = "Finalizado";
              } else if (state.status === 'running') {
                imageStats.status = `Regenerando imágenes (${imageStats.regenPercent}%)`;
              }
            } else {
              usedFallback = true;
            }
          } else {
            usedFallback = true;
          }

          if (usedFallback) {
            // Fallback: leer fichero de /tmp/image_regen_state.json generado por python script
            const stateFile = '/tmp/image_regen_state.json';
            if (fs.existsSync(stateFile)) {
              const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              imageStats.regenerating = state.status === 'running';
              imageStats.regenProcessed = state.processed || 0;
              imageStats.regenSuccess = state.success || 0;
              imageStats.regenFailed = state.failed || 0;
              imageStats.regenSkipped = state.skipped || 0;
              imageStats.regenCurrentSku = state.current_sku || '';
              if (state.total > 0) {
                imageStats.regenPercent = Math.round((state.processed / state.total) * 100);
              }
              if (state.status === 'completed') {
                imageStats.status = "Finalizado";
              } else if (state.status === 'running') {
                imageStats.status = `Regenerando imágenes (${imageStats.regenPercent}%)`;
              }
            }
          }
        } catch (e) {
          console.error('Error reading regen state from DB or FS:', e);
        }

        // Stats de la base de datos
        try {
          const optR = await db.execute(sql`SELECT count(*) as count FROM products WHERE images::text LIKE '%/uploads/optimized/%'`);
          const pendingR = await db.execute(sql`SELECT count(*) as count FROM products WHERE images::text LIKE '%api.mybihr.com%' OR images::text LIKE '%static.bihr.pro%'`);
          const placeR = await db.execute(sql`SELECT count(*) as count FROM products WHERE images::text LIKE '%placehold.co%'`);
          const cardOptR = await db.execute(sql`SELECT count(*) as count FROM products WHERE images::text LIKE '%srcCardDesktop%'`);
          // Contadores por proveedor
          const bihrOptR = await db.execute(sql`SELECT count(*) as count FROM products WHERE (provider_id IS NULL OR provider_id = 'bihr') AND images::text LIKE '%/uploads/optimized/%'`);
          const bihrPendR = await db.execute(sql`SELECT count(*) as count FROM products WHERE (provider_id IS NULL OR provider_id = 'bihr') AND (images::text LIKE '%api.mybihr.com%' OR images::text LIKE '%static.bihr.pro%')`);
          const andrOptR = await db.execute(sql`SELECT count(*) as count FROM products WHERE provider_id = 'andreani' AND images::text LIKE '%/uploads/optimized/%'`);
          const andrPendR = await db.execute(sql`SELECT count(*) as count FROM products WHERE provider_id = 'andreani' AND images::text LIKE '%andreanimhs.com%'`);
          const andrEmptyR = await db.execute(sql`SELECT count(*) as count FROM products WHERE provider_id = 'andreani' AND (images = '[]'::jsonb OR images IS NULL OR images::text = '[]')`);

          const optCount = Number(optR.rows[0]?.count || 0);
          const pendingCount = Number(pendingR.rows[0]?.count || 0);
          const placeCount = Number(placeR.rows[0]?.count || 0);
          const cardOptCount = Number(cardOptR.rows[0]?.count || 0);

          imageStats.optimized = optCount;
          imageStats.omitted = placeCount;
          imageStats.failed = 0; // Fallbacks are placeholders
          imageStats.total = optCount + pendingCount + placeCount;

          // Card specific stats
          imageStats.cardOptimized = cardOptCount;
          imageStats.cardPending = Math.max(0, optCount - cardOptCount);
          imageStats.cardTotal = optCount;

          // Purged images can be approximated or set as:
          imageStats.purged = optCount;
          imageStats.purgedTotal = optCount;

          // Por proveedor
          imageStats.bihrOptimized = Number(bihrOptR.rows[0]?.count || 0);
          imageStats.bihrPending = Number(bihrPendR.rows[0]?.count || 0);
          imageStats.andreaniOptimized = Number(andrOptR.rows[0]?.count || 0);
          imageStats.andreaniPending = Number(andrPendR.rows[0]?.count || 0);
          imageStats.andreaniEmpty = Number(andrEmptyR.rows[0]?.count || 0);
          imageStats.andreaniTotal = imageStats.andreaniOptimized + imageStats.andreaniPending + imageStats.andreaniEmpty;

          if (pendingCount === 0 && optCount > 0 && imageStats.cardPending === 0) {
            imageStats.status = "Finalizado";
          } else if (imageStats.cardPending > 0) {
            imageStats.status = `Generando tarjetas 1:1 (${imageStats.cardPending} pendientes)`;
          }
        } catch (e) {
          console.error("Error fetching dynamic image stats:", e);
        }

        return res.json({
          users: Number(uR.rows[0]?.count || 0),
          posts: Number(pR.rows[0]?.count || 0),
          orders: Number(oR.rows[0]?.count || 0),
          sales: Number(sR.rows[0]?.total || 0),
          vps: {
            cpu: cpuPercent,
            cores: cpuCores,
            ramTotal: `${Math.round(totalMem / (1024 * 1024 * 1024))}GB`,
            ramUsed: `${Math.round(usedMem / (1024 * 1024 * 1024))}GB`,
            ramPercent: memPercent,
            disk: diskStats,
            os: `${os.type()} ${os.release()}`,
            uptime: `${Math.round(os.uptime() / 3600)} horas`,
            imageStats
          }
        });
      }

      
      case 'get-attributes': {
        const attrsRes = await pool.query('SELECT * FROM product_attributes ORDER BY id ASC');
        const termsRes = await pool.query('SELECT * FROM product_attribute_terms ORDER BY id ASC');
        
        // Group terms by attribute_id
        const attributes = attrsRes.rows.map(a => {
          return {
            ...a,
            terms: termsRes.rows.filter(t => t.attribute_id === a.id)
          };
        });
        
        return res.json(attributes);
      }

      case 'add-attribute': {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Nombre requerido' });
        const r = await pool.query('INSERT INTO product_attributes (name) VALUES ($1) RETURNING *', [name]);
        return res.json(r.rows[0]);
      }

      case 'add-attribute-term': {
        const { attribute_id, name } = req.body;
        if (!attribute_id || !name) return res.status(400).json({ error: 'Faltan datos' });
        const r = await pool.query('INSERT INTO product_attribute_terms (attribute_id, name) VALUES ($1, $2) RETURNING *', [attribute_id, name]);
        return res.json(r.rows[0]);
      }

      case 'get-product-variations': {
        const { product_id } = req.query;
        if (!product_id) return res.status(400).json({ error: 'Falta product_id' });
        
        const variationsRes = await pool.query('SELECT * FROM product_variations WHERE parent_product_id = $1', [product_id]);
        const variations = variationsRes.rows;
        
        if (variations.length > 0) {
          const varIds = variations.map(v => v.id);
          const varTermsRes = await pool.query(`
            SELECT pva.variation_id, pva.attribute_id, pva.term_id, pa.name as attribute_name, pat.name as term_name
            FROM product_variation_attributes pva
            JOIN product_attributes pa ON pva.attribute_id = pa.id
            JOIN product_attribute_terms pat ON pva.term_id = pat.id
            WHERE pva.variation_id = ANY($1)
          `, [varIds]);
          
          variations.forEach(v => {
            v.attributes = varTermsRes.rows.filter(t => t.variation_id === v.id);
          });
        }
        
        return res.json(variations);
      }

      case 'save-product-variations': {
        const { product_id, variations } = req.body;
        if (!product_id || !Array.isArray(variations)) return res.status(400).json({ error: 'Datos inválidos' });
        
        // Empezamos una transacción
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Por simplicidad, borramos todas las variaciones anteriores y las recreamos (o se podría hacer un UPSERT)
          await client.query('DELETE FROM product_variations WHERE parent_product_id = $1', [product_id]);
          
          for (const v of variations) {
            const resVar = await client.query(`
              INSERT INTO product_variations (parent_product_id, sku, price, stock_status, stock_quantity)
              VALUES ($1, $2, $3, $4, $5) RETURNING id
            `, [product_id, v.sku || null, v.price || 0, v.stock_status || 'instock', v.stock_quantity || 0]);
            
            const newVarId = resVar.rows[0].id;
            
            if (v.attributes && Array.isArray(v.attributes)) {
              for (const attr of v.attributes) {
                if (attr.attribute_id && attr.term_id) {
                  await client.query(`
                    INSERT INTO product_variation_attributes (variation_id, attribute_id, term_id)
                    VALUES ($1, $2, $3)
                  `, [newVarId, attr.attribute_id, attr.term_id]);
                }
              }
            }
          }
          await client.query('COMMIT');
          return res.json({ success: true });
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }

      case 'products-list': {
        const {
          search, brand, category_id, category2_id, category3_id,
          stock_min, stock_max, price_min, price_max,
          dropshipping, ondemand, status,
          barcode, supplier_code,
          limit = '100', page = '1', sort = 'created_at', order = 'DESC'
        } = req.query as any;
        const lim = Math.min(parseIntSafe(limit) || 100, 500);
        const p = parseIntSafe(page) || 1;
        const offset = (p - 1) * lim;

        const conditions = sql``;
        let hasConditions = false;

      if (search) {
        if (!/^[a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ\s\-_,.]+$/.test(search)) {
          return res.status(400).json({ error: 'Búsqueda inválida' });
        }
          const s = `%${search}%`;
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; }
          conditions.append(sql`(
            LOWER(name) LIKE LOWER(${s})
            OR LOWER(sku) LIKE LOWER(${s})
            OR LOWER(description) LIKE LOWER(${s})
            OR LOWER(supplier_code) LIKE LOWER(${s})
            OR LOWER(barcode) LIKE LOWER(${s})
            OR LOWER(old_part_number) LIKE LOWER(${s})
          )`);
        }
        if (brand) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`LOWER(brand) = LOWER(${brand})`);
        }
        const selectedCatId = category3_id ? parseInt(category3_id) : (category2_id ? parseInt(category2_id) : (category_id ? parseInt(category_id) : null));
        if (selectedCatId && !isNaN(selectedCatId)) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`category_id IN (
            WITH RECURSIVE descendants AS (
              SELECT id FROM categories WHERE id = ${selectedCatId}
              UNION ALL
              SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
            )
            SELECT id FROM descendants
          )`);
        }
        if (stock_min) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`stock >= ${parseInt(stock_min)}`);
        }
        if (stock_max) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`stock <= ${parseInt(stock_max)}`);
        }
        if (price_min) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`price >= ${Math.round(parseFloat(price_min) * 100)}`);
        }
        if (price_max) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`price <= ${Math.round(parseFloat(price_max) * 100)}`);
        }
        if (dropshipping === 'true' || dropshipping === '1') {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`dropshipping = true`);
        } else if (dropshipping === 'false' || dropshipping === '0') {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`dropshipping = false`);
        }
        if (ondemand === 'true' || ondemand === '1') {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`ondemand = true`);
        } else if (ondemand === 'false' || ondemand === '0') {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`ondemand = false`);
        }
        if (status) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`status = ${status}`);
        }
        if (barcode) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`barcode LIKE ${'%' + barcode + '%'}`);
        }
        if (supplier_code) {
          if (!hasConditions) { conditions.append(sql` WHERE `); hasConditions = true; } else { conditions.append(sql` AND `); }
          conditions.append(sql`supplier_code LIKE ${'%' + supplier_code + '%'}`);
        }

        const allowedSorts = ['created_at', 'name', 'sku', 'price', 'stock', 'brand', 'barcode', 'supplier_code'];
        const safeSort = allowedSorts.includes(sort) ? sort : 'created_at';
        const safeOrder = order === 'ASC' ? 'ASC' : 'DESC';

        const query = sql`SELECT * FROM products ${conditions} ORDER BY ${sql.raw(safeSort)} ${sql.raw(safeOrder)} LIMIT ${lim} OFFSET ${offset}`;
        const products = await db.execute(query);
        const rows = products.rows;
        
        if (rows.length > 0) {
          try {
            const productIds = rows.map(r => r.id);
            const linksRes = await pool.query(`
              SELECT pl.id as link_id, pl.linked_product_id as id, pl.product_id, pl.link_type, p.name, p.sku 
              FROM product_links pl 
              JOIN products p ON pl.linked_product_id = p.id 
              WHERE pl.product_id = ANY($1)
            `, [productIds]);
            
            rows.forEach(r => {
              const productLinks = linksRes.rows.filter(l => l.product_id === r.id);
              r.upsells = productLinks.filter(l => l.link_type === 'upsell');
              r.cross_sells = productLinks.filter(l => l.link_type === 'cross_sell');
            });
          } catch (e) {
            console.error('Error fetching product links:', e);
          }
        }

        return res.json(rows);
      }

      case 'create-product': {
        if (req.method !== 'POST') return res.status(405).end();
        const b = req.body;
        const safeName = (b.name || "Sin nombre").substring(0, 255);
        const safeSku = (b.sku || `SKU-${Date.now()}`).substring(0, 100);
        const raw = parseFloat(b.price);
        const priceInCents = isNaN(raw) ? 0 : Math.round(raw * 100);
        const rawSale = parseFloat(b.salePrice);
        const saleCents = isNaN(rawSale) ? null : Math.round(rawSale * 100);
        const stock = parseInt(b.stock) || 0;
        const desc = b.description || null;
        const imgs = b.images?.length > 0 ? JSON.stringify(b.images) : null;
        const compat = b.compatibility?.length > 0 ? JSON.stringify(b.compatibility) : null;
        const status = b.status || 'published';
        const brand = b.brand || '';
        const cost = b.cost ? Math.round(parseFloat(b.cost) * 100) : null;
        const categoryId = b.categoryId ? parseInt(b.categoryId) : null;
        const category2Id = b.category2Id ? parseInt(b.category2Id) : null;
        const category3Id = b.category3Id ? parseInt(b.category3Id) : null;

        const stockStatus = b.stock_status || 'in_stock';
        const lowStockThreshold = b.low_stock_threshold ? parseInt(b.low_stock_threshold) : null;

        const insertRes = await pool.query(`
          INSERT INTO products (name, sku, price, sale_price, stock, description, images, compatibility, status, brand, cost, category_id, category2_id, category3_id, type, stock_status, low_stock_threshold)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id
        `, [safeName, safeSku, priceInCents, saleCents, stock, desc, imgs, compat, status, brand, cost, categoryId, category2Id, category3Id, b.type || 'simple', stockStatus, lowStockThreshold]);
        
        const newId = insertRes.rows[0].id;
        
        // Save variations if variable
        if (b.type === 'variable' && b.variations) {
          for (const v of b.variations) {
            const resVar = await pool.query(`
              INSERT INTO product_variations (parent_product_id, sku, price, stock_status, stock_quantity)
              VALUES ($1, $2, $3, $4, $5) RETURNING id
            `, [newId, v.sku || null, v.price ? Math.round(parseFloat(v.price) * 100) : 0, v.stock_status || 'instock', v.stock_quantity || 0]);
            
            const newVarId = resVar.rows[0].id;
            
            if (v.attributes && Array.isArray(v.attributes)) {
              for (const attr of v.attributes) {
                if (attr.attribute_id && attr.term_id) {
                  await pool.query(`
                    INSERT INTO product_variation_attributes (variation_id, attribute_id, term_id)
                    VALUES ($1, $2, $3)
                  `, [newVarId, attr.attribute_id, attr.term_id]);
                }
              }
            }
          }
        }
        
        if (b.upsells && Array.isArray(b.upsells)) {
          for (const u of b.upsells) {
            await pool.query('INSERT INTO product_links (product_id, linked_product_id, link_type) VALUES ($1, $2, $3)', [newId, u.id, 'upsell']);
          }
        }
        if (b.crossSells && Array.isArray(b.crossSells)) {
          for (const c of b.crossSells) {
            await pool.query('INSERT INTO product_links (product_id, linked_product_id, link_type) VALUES ($1, $2, $3)', [newId, c.id, 'cross_sell']);
          }
        }

        return res.json({ success: true, id: newId });
      }

      case 'orders-list': {
        const { limit = '50', page = '1', status } = req.query as any;
        const lim = Math.min(parseIntSafe(limit) || 50, 200);
        const p = parseIntSafe(page) || 1;
        const offset = (p - 1) * lim;

        let statusFilter = sql``;
        if (status && status !== 'all') {
          statusFilter = sql` WHERE status = ${status}`;
        }

        const countRes = await db.execute(sql`SELECT count(*) as total FROM orders${statusFilter}`);
        const total = Number(countRes.rows[0]?.total || 0);
        const totalPages = Math.ceil(total / lim);

        const ordersRes = await db.execute(sql`
          SELECT * FROM orders${statusFilter} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${offset}
        `);
        const result = [];
        for (const rawOrder of ordersRes.rows) {
          const order = rawOrder as any;
          const itemsRes = await db.execute(sql`
            SELECT oi.*, p.name as product_name
            FROM order_items oi
            LEFT JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = ${order.id}
          `);
          const notesRes = await db.execute(sql`SELECT * FROM order_notes WHERE order_id = ${order.id} ORDER BY created_at DESC`);
          // Check if invoice exists
          const invCheck = await db.execute(sql`SELECT invoice_number FROM invoices WHERE order_id = ${order.id}`);
          result.push({
            id: order.id,
            userId: order.user_id,
            total: order.total,
            subtotal: order.subtotal,
            shippingCost: order.shipping_cost,
            discountAmount: order.discount_amount,
            status: order.status,
            paymentId: order.payment_id,
            shippingData: order.shipping_data ? JSON.parse(order.shipping_data as string) : {},
            createdAt: order.created_at,
            items: itemsRes.rows,
            bihrTicketId: order.bihr_ticket_id,
            dropshippingStatus: order.dropshipping_status || 'not_sent',
            trackingNumber: order.tracking_number,
            trackingUrl: order.tracking_url,
            costTotal: order.cost_total || 0,
            notes: notesRes.rows,
            invoiceNumber: invCheck.rows.length > 0 ? (invCheck.rows[0] as any).invoice_number : null,
          });
        }
        return res.json({
          orders: result,
          pagination: {
            page: p,
            limit: lim,
            total,
            totalPages
          }
        });
      }

      case 'update-order-status': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId, status } = req.body;
        if (!orderId || !status) return res.status(400).json({ error: 'Faltan datos' });
        await db.execute(sql`
          UPDATE orders
          SET status = ${status}
          WHERE id = ${parseInt(orderId)}
        `);

        // Auto-generate invoice if manually moved to paid status
        if (status === 'processing' || status === 'completed') {
          try {
            await createInvoiceForOrder(parseInt(orderId));
            console.log(`[AUTO-INVOICE] Invoice auto-generated on manual status update for Order ${orderId}`);
          } catch (e: any) {
            console.error(`[AUTO-INVOICE ERROR] Failed to auto-generate invoice on manual status update for Order ${orderId}:`, e);
          }
        }
        return res.json({ success: true });
      }

      case 'bulk-update-orders': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderIds, status } = req.body;
        if (!orderIds || !Array.isArray(orderIds) || !status) return res.status(400).json({ error: 'Faltan datos' });
        
        await db.execute(sql`
          UPDATE orders
          SET status = ${status}
          WHERE id = ANY(${orderIds})
        `);

        if (status === 'processing' || status === 'completed') {
          for (const id of orderIds) {
            try {
              await createInvoiceForOrder(parseInt(id));
            } catch (e: any) {
              console.error(`[AUTO-INVOICE ERROR] Failed for Order ${id}:`, e);
            }
          }
        }
        return res.json({ success: true });
      }

      case 'get-order-notes': {
        const { orderId } = req.query as any;
        if (!orderId) return res.status(400).json({ error: 'Falta orderId' });
        const notesRes = await pool.query('SELECT * FROM order_notes WHERE order_id = $1 ORDER BY created_at DESC', [orderId]);
        return res.json(notesRes.rows);
      }

      case 'add-order-note': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId, note, isCustomerNote } = req.body;
        if (!orderId || !note) return res.status(400).json({ error: 'Faltan datos' });
        
        const noteRes = await pool.query(
          'INSERT INTO order_notes (order_id, note, is_customer_note, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
          [orderId, note, isCustomerNote ? true : false, email || 'Admin']
        );
        
        if (isCustomerNote) {
          try {
            const orderRes = await pool.query('SELECT user_id, shipping_data FROM orders WHERE id = $1', [orderId]);
            let toEmail = '';
            if (orderRes.rows.length > 0) {
              const order = orderRes.rows[0];
              if (order.shipping_data) {
                const sdata = JSON.parse(order.shipping_data);
                toEmail = sdata.email || '';
              }
            }
            if (toEmail) {
              const htmlContent = `
                <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; border-radius: 6px; color: #0f172a; border: 1px solid #e2e8f0;">
                  <div style="text-align: center; margin-bottom: 30px;">
                    <img src="https://www.escapesymas.com/logo-cabecera-negro.svg" alt="Escapes y Más" style="max-width: 250px;">
                  </div>
                  <h2 style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; text-align: center; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">¡HOLA!</h2>
                  <div style="background-color: #ffffff; padding: 25px; border-radius: 6px; border-left: 4px solid #eab308; margin: 20px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
                    <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">
                      Hemos añadido una actualización a tu pedido <strong>#${orderId}</strong>:
                    </p>
                    <div style="background-color: #f1f5f9; padding: 15px; border-radius: 4px; margin-top: 15px; font-style: italic; color: #334155;">
                      "${note}"
                    </div>
                  </div>
                  <p style="color: #64748b; font-size: 14px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">
                    ¿Tienes dudas? Responde a este correo o escríbenos a <a href="mailto:info@escapesymas.com" style="color: #0f172a; font-weight: 600;">info@escapesymas.com</a>.<br><br>
                    <strong>Escapes y Más</strong>
                  </p>
                </div>
              `;
              await sendMail(toEmail, `Actualización de tu pedido #${orderId}`, `Hola,\n\nHemos añadido una actualización a tu pedido #${orderId}:\n\n"${note}"\n\nSaludos,\nEl equipo de Escapes y Más.`, htmlContent);
            }
          } catch(e) {
            console.error('Error sending note email:', e);
          }
        }
        return res.json(noteRes.rows[0]);
      }

      case 'refund-order': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId, amount, reason } = req.body;
        if (!orderId || !amount) return res.status(400).json({ error: 'Faltan datos' });
        
        const orderRes = await db.execute(sql`SELECT stripe_charge_id, payment_id FROM orders WHERE id = ${parseInt(orderId)}`);
        const order = orderRes.rows[0] as any;
        if (!order || (!order.stripe_charge_id && !order.payment_id)) {
          return res.status(400).json({ error: 'El pedido no tiene un ID de pago válido de Stripe.' });
        }

        const chargeId = order.stripe_charge_id || order.payment_id;

        try {
          const client = getStripeClient(req);
          const refund = await client.refunds.create({
            payment_intent: chargeId.startsWith('pi_') ? chargeId : undefined,
            charge: chargeId.startsWith('ch_') ? chargeId : undefined,
            amount: Math.round(parseFloat(amount) * 100), // convert to cents
            reason: reason || 'requested_by_customer'
          });

          await db.execute(sql`
            UPDATE orders 
            SET refunded_amount = COALESCE(refunded_amount, 0) + ${amount},
                status = 'refunded'
            WHERE id = ${parseInt(orderId)}
          `);

          return res.json({ success: true, refund });
        } catch (error: any) {
          console.error('[STRIPE REFUND ERROR]', error);
          return res.status(400).json({ error: error.message });
        }
      }

      case 'create-manual-order': {
        if (req.method !== 'POST') return res.status(405).end();
        const { customerData, items, shippingCost, generatePaymentLink } = req.body;
        if (!customerData || !items || items.length === 0) return res.status(400).json({ error: 'Faltan datos' });

        // calculate totals
        let subtotal = 0;
        let costTotal = 0;
        for (const it of items) {
           subtotal += (it.price * it.quantity);
           // get original cost
           const pRes = await db.execute(sql`SELECT cost FROM products WHERE id = ${it.id}`);
           if (pRes.rows[0] && (pRes.rows[0] as any).cost) {
             costTotal += (parseFloat((pRes.rows[0] as any).cost as string) * it.quantity);
           }
        }
        
        const total = subtotal + parseFloat(shippingCost || 0);

        try {
          // create order
          const oRes = await db.execute(sql`
            INSERT INTO orders (
              user_id, total, subtotal, shipping_cost, status, shipping_data, cost_total
            ) VALUES (
              ${customerData.userId || null}, ${total}, ${subtotal}, ${parseFloat(shippingCost || 0)}, 
              ${generatePaymentLink ? 'pending_payment' : 'processing'}, 
              ${JSON.stringify(customerData)}, ${costTotal}
            ) RETURNING id
          `);
          const orderId = oRes.rows[0].id;

          for (const it of items) {
             await db.execute(sql`
               INSERT INTO order_items (order_id, product_id, quantity, price)
               VALUES (${orderId}, ${it.id}, ${it.quantity}, ${it.price})
             `);
          }

          let paymentLinkUrl = null;
          if (generatePaymentLink) {
             const client = getStripeClient(req);
             
             const lineItems = items.map((it: any) => ({
               price_data: {
                 currency: 'eur',
                 product_data: { name: it.name },
                 unit_amount: Math.round(it.price)
               },
               quantity: it.quantity
             }));

             if (parseFloat(shippingCost) > 0) {
               lineItems.push({
                 price_data: {
                   currency: 'eur',
                   product_data: { name: 'Gastos de envío' },
                   unit_amount: Math.round(parseFloat(shippingCost) * 100)
                 },
                 quantity: 1
               });
             }

             const storeUrl = process.env.STORE_URL || 'https://escapesymas.com'; // Default to production domain
             const returnUrl = `${storeUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
             const paymentLinkUrl = `${storeUrl}/pagar/${orderId}`;

             const sessionParams = {
               payment_method_types: ['card', 'klarna', 'bizum'],
               line_items: lineItems,
               mode: 'payment',
               ui_mode: 'embedded_page',
               return_url: returnUrl,
               client_reference_id: `manual_${orderId}`,
               metadata: { orderId: orderId.toString() }
             } as any;
             if (customerData.email) sessionParams.customer_email = customerData.email;
             
             const stripeSession = await client.checkout.sessions.create(sessionParams);
             
             await db.execute(sql`UPDATE orders SET payment_id = ${stripeSession.id} WHERE id = ${orderId}`);

             if (customerData.email) {
                 const nameText = customerData.name ? ` ${customerData.name}` : '';
                 const emailHtml = `
                    <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; border-radius: 6px; color: #0f172a; border: 1px solid #e2e8f0;">
                      <div style="text-align: center; margin-bottom: 30px;">
                        <img src="https://www.escapesymas.com/logo-cabecera-negro.svg" alt="Escapes y Más" style="max-width: 250px;">
                      </div>
                      <h2 style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; text-align: center; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">¡Hola${nameText}!</h2>
                      <div style="background-color: #ffffff; padding: 25px; border-radius: 6px; border-left: 4px solid #eab308; margin: 20px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
                        <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">
                          Hemos preparado tu pedido <strong>#${orderId}</strong>.
                        </p>
                        <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 0;">
                          Para finalizar la compra y que podamos procesar tu envío de inmediato, por favor accede a nuestra plataforma segura para completar el pago.
                        </p>
                      </div>
                      <div style="text-align: center; margin: 40px 0;">
                        <a href="${paymentLinkUrl}" style="background-color: #eab308; color: #000000; padding: 16px 32px; text-decoration: none; font-size: 16px; border-radius: 6px; font-weight: 700; display: inline-block; text-transform: uppercase; letter-spacing: 0.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">Finalizar Pago Ahora</a>
                      </div>
                      <p style="color: #64748b; font-size: 14px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">
                        ¿Tienes dudas? Responde a este correo o escríbenos a <a href="mailto:info@escapesymas.com" style="color: #0f172a; font-weight: 600;">info@escapesymas.com</a>.<br><br>
                        <strong>Escapes y Más</strong>
                      </p>
                    </div>
                 `;
                 
                 // Run asynchronously so frontend doesn't hang if SMTP is slow
                 sendMail(
                   customerData.email, 
                   `Finaliza tu pedido #${orderId} en Escapes y Más`, 
                   `Hola ${customerData.name || ''},\nHemos preparado tu pedido manualmente. Por favor, págala en este enlace: ${paymentLinkUrl}`,
                   emailHtml
                 ).catch(e => console.error('[EMAIL BACKGROUND ERROR]', e));
             }
          }

          return res.json({ success: true, orderId });

        } catch(e: any) {
          console.error('[MANUAL ORDER ERROR]', e);
          return res.status(400).json({ error: e.message });
        }
      }

      case 'search-customer': {
        const query = req.query.q as string;
        if (!query || query.length < 4) return res.json(null);
        
        try {
          const sqlQuery = sql`
            SELECT shipping_data FROM orders 
            WHERE shipping_data::text ILIKE ${'%' + query + '%'}
            ORDER BY created_at DESC 
            LIMIT 1
          `;
          const result = await db.execute(sqlQuery);
          if (result.rows.length > 0 && result.rows[0].shipping_data) {
            let data = typeof result.rows[0].shipping_data === 'string' ? JSON.parse(result.rows[0].shipping_data) : result.rows[0].shipping_data;
            if (data && (data.email?.includes(query) || data.phone?.includes(query))) {
              return res.json(data);
            }
          }
          return res.json(null);
        } catch(e) {
          console.error('[SEARCH CUSTOMER ERROR]', e);
          return res.status(500).json({ error: 'Error searching customer' });
        }
      }

      case 'delete-order': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Faltan datos' });
        await db.execute(sql`
          DELETE FROM order_items
          WHERE order_id = ${parseInt(orderId)}
        `);
        await db.execute(sql`
          DELETE FROM orders
          WHERE id = ${parseInt(orderId)}
        `);
        return res.json({ success: true });
      }

      case 'send-dropshipping-order': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

        const orderIdInt = parseInt(orderId);
        const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${orderIdInt}`);
        if (orderRes.rows.length === 0) {
          return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        const order = orderRes.rows[0] as any;

        const itemsRes = await db.execute(sql`
          SELECT oi.*, p.sku
          FROM order_items oi
          LEFT JOIN products p ON oi.product_id = p.id
          WHERE oi.order_id = ${orderIdInt}
        `);

        if (itemsRes.rows.length === 0) {
          return res.status(400).json({ error: 'El pedido no tiene artículos' });
        }

        const shippingData = order.shipping_data ? JSON.parse(order.shipping_data as string) : {};

        const deliveryAddress = {
          firstName: shippingData.firstName || '',
          lastName: shippingData.lastName || '',
          companyName: shippingData.companyName || '',
          street: `${shippingData.address || ''} ${shippingData.apartment || ''}`.trim(),
          zipCode: shippingData.zipCode || '',
          city: shippingData.city || '',
          countryCode: shippingData.country || 'ES',
          phoneNumber: shippingData.phone || '',
          email: shippingData.email || '',
        };

        const items = itemsRes.rows.map((item: any) => ({
          productCode: item.sku,
          quantity: item.quantity,
        }));

        try {
          const { createBihrOrder } = await import('./bihrService.js');
          const bihrResponse = await createBihrOrder({
            deliveryAddress,
            items,
            customerOrderReference: `order_${order.id}`,
            isDropshipping: true
          });

          const ticketId = bihrResponse.ticketId || bihrResponse.TicketId || bihrResponse.ticket_id || '';
          
          await db.execute(sql`
            UPDATE orders
            SET bihr_ticket_id = ${ticketId},
                dropshipping_status = 'pending_bihr'
            WHERE id = ${orderIdInt}
          `);

          return res.json({ success: true, ticketId });
        } catch (e: any) {
          console.error('[DROPSHIPPING SEND ERROR]:', e);
          return res.status(500).json({ error: e.message || 'Error al enviar pedido a Bihr' });
        }
      }

      case 'query-dropshipping-status': {
        const { orderId } = req.query as any;
        if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

        const orderIdInt = parseInt(orderId);
        const orderRes = await db.execute(sql`SELECT * FROM orders WHERE id = ${orderIdInt}`);
        if (orderRes.rows.length === 0) {
          return res.status(404).json({ error: 'Pedido no encontrado' });
        }
        const order = orderRes.rows[0] as any;
        if (!order.bihr_ticket_id) {
          return res.status(400).json({ error: 'El pedido no tiene un ticket de Bihr asociado' });
        }

        try {
          const { getBihrOrderStatus } = await import('./bihrService.js');
          const statusData = await getBihrOrderStatus(order.bihr_ticket_id);
          
          const bihrStatus = (statusData.status || statusData.Status || '').toLowerCase();
          
          let dropshippingStatus = 'pending_bihr';
          if (bihrStatus === 'shipped') {
            dropshippingStatus = 'shipped';
          } else if (bihrStatus === 'cancelled' || bihrStatus === 'canceled') {
            dropshippingStatus = 'cancelled';
          }

          const trackingNumber = statusData.trackingNumber || statusData.TrackingNumber || order.tracking_number || null;
          const trackingUrl = statusData.trackingUrl || statusData.TrackingUrl || order.tracking_url || null;
          
          await db.execute(sql`
            UPDATE orders
            SET dropshipping_status = ${dropshippingStatus},
                tracking_number = ${trackingNumber},
                tracking_url = ${trackingUrl}
            WHERE id = ${orderIdInt}
          `);

          return res.json({ 
            success: true, 
            dropshippingStatus, 
            trackingNumber, 
            trackingUrl, 
            bihrRaw: statusData 
          });
        } catch (e: any) {
          console.error('[QUERY DROPSHIPPING STATUS ERROR]:', e);
          return res.status(500).json({ error: e.message || 'Error al consultar estado en Bihr' });
        }
      }

      case 'pricing-rules-list': {
        const rules = await db.execute(sql`SELECT * FROM pricing_rules ORDER BY created_at DESC`);
        return res.json(rules.rows);
      }

      case 'save-pricing-rule': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, ruleType, targetId, marginPercent, active } = req.body;
        const activeVal = active === false || active === 0 ? 0 : 1;

        if (!ruleType || marginPercent === undefined) {
          return res.status(400).json({ error: 'Faltan parámetros obligatorios' });
        }

        if (id) {
          await db.execute(sql`
            UPDATE pricing_rules
            SET rule_type = ${ruleType},
                target_id = ${targetId || null},
                margin_percent = ${parseInt(marginPercent)},
                active = ${activeVal}
            WHERE id = ${parseInt(id)}
          `);
        } else {
          await db.execute(sql`
            INSERT INTO pricing_rules (rule_type, target_id, margin_percent, active)
            VALUES (${ruleType}, ${targetId || null}, ${parseInt(marginPercent)}, ${activeVal})
          `);
        }
        return res.json({ success: true });
      }

      case 'delete-pricing-rule': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'Falta ID de regla' });
        
        await db.execute(sql`DELETE FROM pricing_rules WHERE id = ${parseInt(id)}`);
        return res.json({ success: true });
      }

      case 'recalculate-all-prices': {
        if (req.method !== 'POST') return res.status(405).end();
        
        const rulesRes = await db.execute(sql`SELECT * FROM pricing_rules WHERE active = 1`);
        const rules = (rulesRes.rows || []) as any[];
 
        const productsRes = await db.execute(sql`SELECT id, brand, category_id, cost, price FROM products WHERE cost > 0`);
        const products = (productsRes.rows || []) as any[];
 
        let updateCount = 0;
 
        const getPrice = (costVal: number, catId: number, brandName: string) => {
          let margin = 20; // default margin
          const brandRule = rules.find(r => r.rule_type === 'brand' && (r.target_id as string)?.toLowerCase() === brandName?.toLowerCase());
          if (brandRule) {
            margin = Number(brandRule.margin_percent);
          } else {
            const parentId = catId >= 100 ? Math.floor(catId / 100) : catId;
            const categoryRule = rules.find(r => r.rule_type === 'category' && (r.target_id === String(catId) || r.target_id === String(parentId)));
            if (categoryRule) {
              margin = Number(categoryRule.margin_percent);
            } else {
              const globalRule = rules.find(r => r.rule_type === 'global');
              if (globalRule) {
                margin = Number(globalRule.margin_percent);
              }
            }
          }
          return Math.round(costVal * (1 + margin / 100));
        };
 
        const batchSize = 200;
        for (let idx = 0; idx < products.length; idx += batchSize) {
          const pBatch = products.slice(idx, idx + batchSize);
          const updateQueries = pBatch.map((p: any) => {
            const newPrice = getPrice(Number(p.cost || 0), Number(p.category_id || 0), p.brand || '');
            if (newPrice !== Number(p.price || 0)) {
              updateCount++;
              return db.execute(sql`UPDATE products SET price = ${newPrice}, updated_at = NOW() WHERE id = ${p.id}`);
            }
            return null;
          }).filter(Boolean);

          if (updateQueries.length > 0) {
            await Promise.all(updateQueries);
          }
        }

        return res.json({ success: true, updatedCount: updateCount });
      }

      case 'generate-invoice': {
        if (req.method !== 'POST') return res.status(405).end();
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

        try {
          const invoice = await createInvoiceForOrder(parseInt(orderId));
          return res.json({ success: true, invoice });
        } catch (e: any) {
          console.error('[GENERATE INVOICE ERROR]:', e);
          return res.status(500).json({ error: e.message || 'Error al generar la factura' });
        }
      }

      case 'download-invoice': {
        const { orderId: dlOrderId } = req.query as any;
        if (!dlOrderId) return res.status(400).json({ error: 'Falta orderId' });

        const invRow = await db.execute(sql`SELECT * FROM invoices WHERE order_id = ${parseInt(dlOrderId)}`);
        if (!invRow.rows.length) return res.status(404).json({ error: 'Factura no generada. Genérala primero.' });

        const inv = invRow.rows[0] as any;
        const pdfFile = inv.pdf_path;

        if (!pdfFile || !fs.existsSync(pdfFile)) {
          return res.status(404).json({ error: 'Archivo PDF no encontrado en el servidor.' });
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);
        fs.createReadStream(pdfFile).pipe(res);
        return;
      }

      case 'invoices-list': {
        const invList = await db.execute(sql`
          SELECT i.*, o.shipping_data
          FROM invoices i
          LEFT JOIN orders o ON i.order_id = o.id
          ORDER BY i.issued_at DESC
          LIMIT 200
        `);
        return res.json(invList.rows.map((r: any) => {
          const sd = (() => { try { return JSON.parse(r.shipping_data || '{}'); } catch { return {}; } })();
          return {
            id: r.id,
            orderId: r.order_id,
            invoiceNumber: r.invoice_number,
            subtotal: r.subtotal,
            taxAmount: r.tax_amount,
            shippingCost: r.shipping_cost,
            discountAmount: r.discount_amount,
            total: r.total,
            issuedAt: r.issued_at,
            customerName: `${sd.firstName || ''} ${sd.lastName || ''}`.trim(),
            customerEmail: sd.email || '',
          };
        }));
      }

      case 'financial-analytics': {
        const { period = '30d' } = req.query as any;
        let intervalExpr = sql`NOW() - INTERVAL '30 days'`;
        if (period === '7d') intervalExpr = sql`NOW() - INTERVAL '7 days'`;
        else if (period === '90d') intervalExpr = sql`NOW() - INTERVAL '90 days'`;
        else if (period === '365d') intervalExpr = sql`NOW() - INTERVAL '365 days'`;

        // Revenue over time (daily)
        const revenueByDay = await db.execute(sql`
          SELECT 
            DATE(created_at) as date,
            SUM(total) as revenue,
            SUM(COALESCE(shipping_cost, 0)) as shipping,
            SUM(COALESCE(discount_amount, 0)) as discounts,
            COUNT(*) as order_count
          FROM orders
          WHERE created_at >= ${intervalExpr}
            AND status NOT IN ('cancelled', 'refunded')
          GROUP BY DATE(created_at)
          ORDER BY date ASC
        `);

        // Summary totals
        const summaryRes = await db.execute(sql`
          SELECT 
            COUNT(*) as total_orders,
            COALESCE(SUM(total), 0) as gross_revenue,
            COALESCE(SUM(COALESCE(shipping_cost, 0)), 0) as total_shipping,
            COALESCE(SUM(COALESCE(discount_amount, 0)), 0) as total_discounts,
            COALESCE(AVG(total), 0) as avg_order_value
          FROM orders
          WHERE created_at >= ${intervalExpr}
            AND status NOT IN ('cancelled', 'refunded')
        `);

        // COGS (cost of goods sold) from products table
        const cogsRes = await db.execute(sql`
          SELECT COALESCE(SUM(p.cost * oi.quantity), 0) as cogs
          FROM orders o
          LEFT JOIN order_items oi ON oi.order_id = o.id
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.created_at >= ${intervalExpr}
            AND o.status NOT IN ('cancelled', 'refunded')
        `).catch(() => ({ rows: [{ cogs: 0 }] }));

        // Top products by revenue
        const topProductsRes = await db.execute(sql`
          SELECT 
            p.name,
            p.sku,
            SUM(oi.price * oi.quantity) as revenue,
            SUM(oi.quantity) as units_sold
          FROM orders o
          LEFT JOIN order_items oi ON oi.order_id = o.id
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE o.created_at >= ${intervalExpr}
            AND o.status NOT IN ('cancelled', 'refunded')
            AND p.name IS NOT NULL
          GROUP BY p.name, p.sku
          ORDER BY revenue DESC
          LIMIT 10
        `).catch(() => ({ rows: [] }));

        // Orders by status
        const statusBreakdown = await db.execute(sql`
          SELECT status, COUNT(*) as count, SUM(total) as revenue
          FROM orders
          WHERE created_at >= ${intervalExpr}
          GROUP BY status
        `);

        // Monthly revenue comparison (current vs previous period)
        const prevSummary = await db.execute(sql`
          SELECT COALESCE(SUM(total), 0) as gross_revenue, COUNT(*) as total_orders
          FROM orders
          WHERE created_at >= ${intervalExpr} - (${intervalExpr} - NOW())
            AND created_at < ${intervalExpr}
            AND status NOT IN ('cancelled', 'refunded')
        `).catch(() => ({ rows: [{ gross_revenue: 0, total_orders: 0 }] }));

        const summary = summaryRes.rows[0] as any;
        const grossRevenue = Number(summary.gross_revenue || 0);
        const cogs = Number((cogsRes.rows[0] as any)?.cogs || 0);
        const taxBase = Math.round(grossRevenue / 1.21);
        const vatCollected = grossRevenue - taxBase;
        const grossProfit = grossRevenue - cogs;

        return res.json({
          period,
          summary: {
            totalOrders: Number(summary.total_orders || 0),
            grossRevenue,
            totalShipping: Number(summary.total_shipping || 0),
            totalDiscounts: Number(summary.total_discounts || 0),
            avgOrderValue: Math.round(Number(summary.avg_order_value || 0)),
            cogs,
            grossProfit,
            vatCollected,
            taxBase,
          },
          prevPeriod: {
            grossRevenue: Number((prevSummary.rows[0] as any)?.gross_revenue || 0),
            totalOrders: Number((prevSummary.rows[0] as any)?.total_orders || 0),
          },
          revenueByDay: revenueByDay.rows.map((r: any) => ({
            date: r.date,
            revenue: Number(r.revenue || 0),
            shipping: Number(r.shipping || 0),
            discounts: Number(r.discounts || 0),
            orderCount: Number(r.order_count || 0),
          })),
          topProducts: topProductsRes.rows.map((r: any) => ({
            name: r.name,
            sku: r.sku,
            revenue: Number(r.revenue || 0),
            unitsSold: Number(r.units_sold || 0),
          })),
          statusBreakdown: statusBreakdown.rows.map((r: any) => ({
            status: r.status,
            count: Number(r.count || 0),
            revenue: Number(r.revenue || 0),
          })),
        });
      }

      case 'export-accounting-csv': {
        const { period: csvPeriod = '30d' } = req.query as any;
        let csvIntervalExpr = sql`NOW() - INTERVAL '30 days'`;
        if (csvPeriod === '7d') csvIntervalExpr = sql`NOW() - INTERVAL '7 days'`;
        else if (csvPeriod === '90d') csvIntervalExpr = sql`NOW() - INTERVAL '90 days'`;
        else if (csvPeriod === '365d') csvIntervalExpr = sql`NOW() - INTERVAL '365 days'`;

        const csvOrders = await db.execute(sql`
          SELECT 
            o.id, o.created_at, o.status, o.total, 
            o.subtotal, o.shipping_cost, o.discount_amount, o.promo_code,
            o.shipping_data,
            i.invoice_number,
            i.tax_amount
          FROM orders o
          LEFT JOIN invoices i ON i.order_id = o.id
          WHERE o.created_at >= ${csvIntervalExpr}
          ORDER BY o.created_at DESC
        `);

        const csvRows = csvOrders.rows.map((r: any) => {
          const sd = (() => { try { return JSON.parse(r.shipping_data || '{}'); } catch { return {}; } })();
          const total = Number(r.total || 0);
          const taxAmt = r.tax_amount ? Number(r.tax_amount) : Math.round(total * 21 / 121);
          const taxBase = total - taxAmt;
          return [
            r.id,
            new Date(r.created_at).toLocaleDateString('es-ES'),
            r.status,
            r.invoice_number || '',
            `${sd.firstName || ''} ${sd.lastName || ''}`.trim(),
            sd.email || '',
            (Number(r.subtotal || total) / 100).toFixed(2),
            (Number(r.shipping_cost || 0) / 100).toFixed(2),
            (Number(r.discount_amount || 0) / 100).toFixed(2),
            (taxBase / 100).toFixed(2),
            (taxAmt / 100).toFixed(2),
            (total / 100).toFixed(2),
            r.promo_code || '',
          ].join(';');
        });

        const header = 'ID Pedido;Fecha;Estado;Nº Factura;Cliente;Email;Base Subtotal;Envío;Descuento;Base Imponible;IVA 21%;Total EUR;Cupón';
        const csvContent = [header, ...csvRows].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="libro_ventas_${csvPeriod}_${new Date().toISOString().slice(0,10)}.csv"`);
        return res.send('\uFEFF' + csvContent); // BOM for Excel UTF-8
      }

      case 'carts-list': {
        const cartsRes = await db.execute(sql`
          SELECT c.*, u.email as user_email, u.first_name as user_firstname, u.last_name as user_lastname, u.username as user_username
          FROM carts c
          LEFT JOIN users u ON c.user_id = u.wp_id OR c.user_id = u.id
          ORDER BY c.updated_at DESC
        `);
        const result = [];
        for (const row of cartsRes.rows) {
          const cart = row as any;
          result.push({
            id: cart.id,
            userId: cart.user_id,
            userEmail: cart.user_email || 'Invitado',
            userFirstName: cart.user_firstname,
            userLastName: cart.user_lastname,
            userUsername: cart.user_username,
            sessionToken: cart.session_token,
            isDeleted: cart.is_deleted || 0,
            items: cart.items ? JSON.parse(cart.items as string) : [],
            updatedAt: cart.updated_at
          });
        }
        return res.json(result);
      }

      case 'delete-cart': {
        if (req.method !== 'POST') return res.status(405).end();
        const { cartId } = req.body;
        if (!cartId) return res.status(400).json({ error: 'Falta cartId' });
        await db.execute(sql`
          UPDATE carts
          SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${parseInt(cartId)}
        `);
        return res.json({ success: true });
      }

      case 'permanently-delete-cart': {
        if (req.method !== 'POST') return res.status(405).end();
        const { cartId } = req.body;
        if (!cartId) return res.status(400).json({ error: 'Falta cartId' });
        await db.execute(sql`
          DELETE FROM carts
          WHERE id = ${parseInt(cartId)}
        `);
        return res.json({ success: true });
      }

      case 'send-abandoned-email': {
        if (req.method !== 'POST') return res.status(405).end();
        const { cartId, email, firstName, items } = req.body;
        if (!cartId || !email) return res.status(400).json({ error: 'Faltan datos' });

        try {
          const cartDb = await db.execute(sql`
            SELECT session_token FROM carts WHERE id = ${parseInt(cartId)}
          `);
          const sessionToken = cartDb.rows[0] ? (cartDb.rows[0] as any).session_token : '';

          const transporter = nodemailer.createTransport({
            host: "smtp.buzondecorreo.com",
            port: 465,
            secure: true,
            auth: {
              user: process.env.SMTP_USER || "web@escapesymas.com",
              pass: process.env.SMTP_PASSWORD
            },
            tls: {
              rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true'
            }
          });

          await transporter.verify();

          const clientName = firstName || 'Motero';
          const itemsList = Array.isArray(items) ? items : [];

          const nameText = clientName ? ` ${clientName}` : '';
          let itemsHtml = '';
          let total = 0;
          for (const item of itemsList) {
            const price = parseFloat(item.price || 0);
            const qty = parseInt(item.quantity || 1);
            const subtotal = price * qty;
            total += subtotal;
            itemsHtml += `
              <tr>
                <td style="padding: 12px 10px; border-bottom: 1px solid #f1f5f9;">
                  <a href="https://escapesymas.com/producto/${item.id}" style="color: #0f172a; text-decoration: none; font-weight: 700; font-size: 14px; border-bottom: 1.5px solid #eab308;" target="_blank">${item.title || item.name || 'Producto'}</a><br/>
                  <span style="color: #64748b; font-size: 12px;">Cantidad: ${qty} x ${price.toFixed(2)}€</span>
                </td>
                <td style="padding: 12px 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 700; color: #eab308; font-size: 14px;">
                  ${subtotal.toFixed(2)}€
                </td>
              </tr>
            `;
          }

          const mailOptions = {
            from: '"Escapes y Más" <web@escapesymas.com>',
            to: email,
            subject: `🏍️ ¡Te guardamos tu carrito en Escapes y Más!`,
            html: `
              <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; border-radius: 6px; color: #0f172a; border: 1px solid #e2e8f0;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <img src="https://www.escapesymas.com/logo-cabecera-negro.svg" alt="Escapes y Más" style="max-width: 250px;">
                </div>
                <h2 style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; text-align: center; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">¡HOLA${nameText}!</h2>
                <div style="background-color: #ffffff; padding: 25px; border-radius: 6px; border-left: 4px solid #eab308; margin: 20px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
                  <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">
                    Vemos que has dejado algunos artículos espectaculares en tu carrito de compra. ¡No te preocupes! Los hemos guardado de forma segura para ti para que no pierdas tus selecciones.
                  </p>
                  
                  <h3 style="margin-top: 25px; border-bottom: 2px solid #f1f5f9; padding-bottom: 8px; text-transform: uppercase; font-size: 14px; letter-spacing: 0.5px; color: #0f172a; font-weight: 700;">Tu Carrito Seleccionado</h3>
                  <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #475569;">
                    ${itemsHtml}
                    <tr>
                      <td style="padding: 15px 10px; font-weight: bold; font-size: 14px; color: #0f172a; border-top: 2px solid #f1f5f9;">TOTAL ESTIMADO</td>
                      <td style="padding: 15px 10px; text-align: right; font-weight: 700; font-size: 16px; color: #eab308; border-top: 2px solid #f1f5f9;">${total.toFixed(2)}€</td>
                    </tr>
                  </table>
                </div>
                <div style="text-align: center; margin: 40px 0;">
                  <a href="https://escapesymas.com/?tab=cart${sessionToken ? `&sessionToken=${sessionToken}` : ''}" style="background-color: #eab308; color: #000000; padding: 16px 32px; text-decoration: none; font-size: 16px; border-radius: 6px; font-weight: 700; display: inline-block; text-transform: uppercase; letter-spacing: 0.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">Completar mi Compra Ahora</a>
                </div>
                
                <p style="color: #64748b; font-size: 14px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">
                  ¿Tienes dudas? Responde a este correo o escríbenos a <a href="mailto:info@escapesymas.com" style="color: #0f172a; font-weight: 600;">info@escapesymas.com</a>.<br><br>
                  <strong>Escapes y Más</strong>
                </p>
              </div>
            `
          };

          await transporter.sendMail(mailOptions);
          return res.json({ success: true });
        } catch (e: any) {
          console.error('[SEND ABANDONED EMAIL ERROR]:', e);
          return res.status(500).json({ error: e.message });
        }
      }

      case 'users-list': {
        const usersRes = await db.execute(sql`
          SELECT id, email, first_name as "firstName", last_name as "lastName", role, rank_level as "rankLevel", rank_xp as "rankXp", created_at as "createdAt", billing FROM users ORDER BY id ASC
        `);
        return res.json(usersRes.rows);
      }

      case 'update-user-role': {
        if (req.method !== 'POST') return res.status(405).end();
        const { userId: targetUserId, role } = req.body;
        if (!targetUserId || !role) return res.status(400).json({ error: 'Faltan datos' });
        await logAdminAction(req, 'update-user-role', { targetUserId, role });
        await db.execute(sql`
          UPDATE users
          SET role = ${role}
          WHERE id = ${parseInt(targetUserId)}
        `);
        return res.json({ success: true });
      }

      case 'moderate-thread': {
        if (req.method !== 'POST') return res.status(405).end();
        const { threadId, isPinned, isClosed, deleteThread, userId } = req.body;
        if (!threadId) return res.status(400).json({ error: 'Falta threadId' });
        
        // Allow if admin OR the thread owner
        if (userId && !isAdmin) {
          const owner = await db.execute(sql`SELECT user_id FROM forum_posts WHERE id = ${parseInt(threadId)}`);
          if (owner.rows[0]?.user_id !== parseInt(userId)) {
            return res.status(403).json({ error: 'No puedes modificar un hilo que no te pertenece' });
          }
        }
        
        if (deleteThread) {
          await db.execute(sql`DELETE FROM forum_replies WHERE post_id = ${parseInt(threadId)}`);
          await db.execute(sql`DELETE FROM forum_likes WHERE content_type = 'post' AND content_id = ${parseInt(threadId)}`);
          await db.execute(sql`DELETE FROM forum_posts WHERE id = ${parseInt(threadId)}`);
        } else {
          const setClauses = [];
          if (isPinned !== undefined) setClauses.push(sql`is_pinned = ${parseInt(isPinned)}`);
          if (isClosed !== undefined) setClauses.push(sql`is_closed = ${parseInt(isClosed)}`);

          if (setClauses.length > 0) {
            const threadIdInt = parseInt(threadId);
            await db.execute(sql`UPDATE forum_posts SET ${sql.join(setClauses, ', ')} WHERE id = ${threadIdInt}`);
          }
        }
        // Invalidate forum cache
        swrCache.invalidatePattern('/api/forum');
        return res.json({ success: true });
      }

      case 'moderate-reply': {
        if (req.method !== 'POST') return res.status(405).end();
        const { replyId } = req.body;
        if (!replyId) return res.status(400).json({ error: 'Falta replyId' });
        await db.execute(sql`DELETE FROM forum_replies WHERE id = ${parseInt(replyId)}`);
        // Invalidate forum cache
        swrCache.invalidatePattern('/api/forum');
        return res.json({ success: true });
      }

      case 'delete-product': {
        if (req.method !== 'POST') return res.status(405).end();
        const { productId } = req.body;
        if (!productId) return res.status(400).json({ error: 'Falta productId' });
        
        await db.execute(sql`
          DELETE FROM order_items WHERE product_id = ${parseInt(productId)}
        `);
        await db.execute(sql`
          DELETE FROM products WHERE id = ${parseInt(productId)}
        `);
        return res.json({ success: true });
      }

      case 'update-product': {
        if (req.method !== 'POST') return res.status(405).end();
        const b = req.body;
        const productId = parseInt(b.id);
        if (!productId) return res.status(400).json({ error: 'Falta productId' });

        const safeName = (b.name || "Sin nombre").substring(0, 255);
        const safeSku = (b.sku || `SKU-${Date.now()}`).substring(0, 100);
        const raw = parseFloat(b.price);
        const priceInCents = isNaN(raw) ? 0 : Math.round(raw * 100);
        const rawSale = parseFloat(b.salePrice);
        const saleCents = isNaN(rawSale) ? null : Math.round(rawSale * 100);
        const stock = parseInt(b.stock) || 0;
        const desc = b.description || null;
        // Handle images: only update when content is provided; preserve existing if empty array sent
        let imgsToSet: string | undefined | null = undefined;
        if (b.images !== undefined) {
          if (Array.isArray(b.images) && b.images.length > 0) {
            imgsToSet = JSON.stringify(b.images);
          } else {
            const existing = await db.execute(sql`SELECT images FROM products WHERE id = ${productId}`);
            if (existing.rows.length > 0 && existing.rows[0].images) {
              imgsToSet = undefined;
            } else {
              imgsToSet = null;
            }
          }
        }
        const compat = b.compatibility?.length > 0 ? JSON.stringify(b.compatibility) : null;
        const status = b.status || 'published';
        const brand = b.brand || '';
        const cost = b.cost ? Math.round(parseFloat(b.cost) * 100) : null;
        const categoryId = b.categoryId ? parseInt(b.categoryId) : null;
        const category2Id = b.category2Id ? parseInt(b.category2Id) : null;
        const category3Id = b.category3Id ? parseInt(b.category3Id) : null;
        const dropshipping = b.dropshipping === true || b.dropshipping === 'true';
        const ondemand = b.ondemand === true || b.ondemand === 'true';
        const barcode = b.barcode || '';
        const supplierCode = b.supplierCode || '';
        const weightG = b.weight_g ? parseInt(b.weight_g) : null;
        const lengthMm = b.length_mm ? parseInt(b.length_mm) : null;
        const widthMm = b.width_mm ? parseInt(b.width_mm) : null;
        const heightMm = b.height_mm ? parseInt(b.height_mm) : null;
        const deliveryPlant = b.deliveryPlant || '';

        const stockStatus = b.stock_status || 'in_stock';
        const lowStockThreshold = b.low_stock_threshold ? parseInt(b.low_stock_threshold) : null;

        const setClauses = [
          sql`name = ${safeName}`,
          sql`sku = ${safeSku}`,
          sql`price = ${priceInCents}`,
          sql`sale_price = ${saleCents}`,
          sql`stock = ${stock}`,
          sql`stock_status = ${stockStatus}`,
          sql`low_stock_threshold = ${lowStockThreshold}`,
          sql`description = ${desc}`,
          sql`compatibility = ${compat}`,
          sql`status = ${status}`,
          sql`brand = ${brand}`,
          sql`cost = ${cost}`,
          sql`category_id = ${categoryId}`,
          sql`category2_id = ${category2Id}`,
          sql`category3_id = ${category3Id}`,
          sql`dropshipping = ${dropshipping}`,
          sql`ondemand = ${ondemand}`,
          sql`barcode = ${barcode}`,
          sql`supplier_code = ${supplierCode}`,
          sql`weight_g = ${weightG}`,
          sql`length_mm = ${lengthMm}`,
          sql`width_mm = ${widthMm}`,
          sql`height_mm = ${heightMm}`,
          sql`delivery_plant = ${deliveryPlant}`,
          sql`type = ${b.type || 'simple'}`,
        ];
        if (imgsToSet !== undefined) {
          setClauses.push(sql`images = ${imgsToSet}`);
        }

        await db.execute(sql`
          UPDATE products
          SET ${sql.join(setClauses, sql`, `)}
          WHERE id = ${productId}
        `);

        // Save variations if variable
        if (b.type === 'variable' && b.variations) {
          await pool.query('DELETE FROM product_variations WHERE parent_product_id = $1', [productId]);
          for (const v of b.variations) {
            const resVar = await pool.query(`
              INSERT INTO product_variations (parent_product_id, sku, price, stock_status, stock_quantity)
              VALUES ($1, $2, $3, $4, $5) RETURNING id
            `, [productId, v.sku || null, v.price ? Math.round(parseFloat(v.price) * 100) : 0, v.stock_status || 'instock', v.stock_quantity || 0]);
            
            const newVarId = resVar.rows[0].id;
            
            if (v.attributes && Array.isArray(v.attributes)) {
              for (const attr of v.attributes) {
                if (attr.attribute_id && attr.term_id) {
                  await pool.query(`
                    INSERT INTO product_variation_attributes (variation_id, attribute_id, term_id)
                    VALUES ($1, $2, $3)
                  `, [newVarId, attr.attribute_id, attr.term_id]);
                }
              }
            }
          }
        } else {
          // If changed to simple, delete any existing variations
          await pool.query('DELETE FROM product_variations WHERE parent_product_id = $1', [productId]);
        }

        await pool.query('DELETE FROM product_links WHERE product_id = $1', [productId]);
        if (b.upsells && Array.isArray(b.upsells)) {
          for (const u of b.upsells) {
            await pool.query('INSERT INTO product_links (product_id, linked_product_id, link_type) VALUES ($1, $2, $3)', [productId, u.id, 'upsell']);
          }
        }
        if (b.crossSells && Array.isArray(b.crossSells)) {
          for (const c of b.crossSells) {
            await pool.query('INSERT INTO product_links (product_id, linked_product_id, link_type) VALUES ($1, $2, $3)', [productId, c.id, 'cross_sell']);
          }
        }

        return res.json({ success: true, id: productId });
      }

      case 'coupons-list': {
        const couponsRes = await db.execute(sql`
          SELECT * FROM coupons ORDER BY created_at DESC
        `);
        return res.json(couponsRes.rows);
      }


      case 'create-coupon': {
        if (req.method !== 'POST') return res.status(405).end();
        const { code, type, value, active, expiresAt, maxUses } = req.body;
        if (!code || !type || value === undefined) {
          return res.status(400).json({ error: 'Faltan datos obligatorios' });
        }
        const codeUpper = code.trim().toUpperCase();
        const expiresVal = expiresAt ? new Date(expiresAt) : null;
        
        await db.execute(sql`
          INSERT INTO coupons (code, type, value, active, expires_at, max_uses, times_used)
          VALUES (${codeUpper}, ${type}, ${parseInt(value)}, ${active !== undefined ? parseInt(active) : 1}, ${expiresVal}, ${maxUses !== undefined ? parseInt(maxUses) : 999999}, 0)
        `);
        return res.json({ success: true });
      }

      // --- TAXONOMÍAS: CATEGORÍAS ---
      case 'get-categories': {
        const catRes = await pool.query(`
          WITH RECURSIVE category_tree AS (
            -- Base case: L1 categories (parent_id IS NULL)
            SELECT 
              c.*, 
              1 as depth,
              ARRAY[c.name]::text[] AS path_names
            FROM categories c
            WHERE c.parent_id IS NULL
            
            UNION ALL
            
            -- Recursive step
            SELECT 
              c.*, 
              t.depth + 1 as depth,
              t.path_names || c.name AS path_names
            FROM categories c
            JOIN category_tree t ON c.parent_id = t.id
          )
          SELECT 
            ct.*,
            COALESCE(pc.cnt, 0) as product_count
          FROM category_tree ct
          LEFT JOIN (
            SELECT category_id, COUNT(*) as cnt
            FROM products
            GROUP BY category_id
          ) pc ON ct.id = pc.category_id
          ORDER BY ct.path_names ASC
        `);
        return res.json(catRes.rows);
      }
      case 'save-category': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, name, slug, parent_id, description } = req.body;
        if (!name || !slug) return res.status(400).json({ error: 'Faltan datos obligatorios' });
        
        if (id) {
          await pool.query(
            'UPDATE categories SET name = $1, slug = $2, parent_id = $3, description = $4, updated_at = NOW() WHERE id = $5',
            [name, slug, parent_id || null, description || null, id]
          );
        } else {
          await pool.query(
            'INSERT INTO categories (name, slug, parent_id, description, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())',
            [name, slug, parent_id || null, description || null]
          );
        }
        return res.json({ success: true });
      }
      case 'delete-category': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id } = req.body;
        await pool.query('DELETE FROM categories WHERE id = $1', [id]);
        return res.json({ success: true });
      }

      // --- TAXONOMÍAS: ETIQUETAS ---
      case 'get-tags': {
        const tagRes = await pool.query('SELECT * FROM tags ORDER BY name ASC');
        return res.json(tagRes.rows);
      }
      case 'save-tag': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, name, slug } = req.body;
        if (!name || !slug) return res.status(400).json({ error: 'Faltan datos obligatorios' });
        
        if (id) {
          await pool.query('UPDATE tags SET name = $1, slug = $2 WHERE id = $3', [name, slug, id]);
        } else {
          await pool.query('INSERT INTO tags (name, slug) VALUES ($1, $2)', [name, slug]);
        }
        return res.json({ success: true });
      }
      case 'delete-tag': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id } = req.body;
        await pool.query('DELETE FROM tags WHERE id = $1', [id]);
        return res.json({ success: true });
      }

      // --- TAXONOMÍAS: VEHÍCULOS (MARCAS Y MODELOS) ---
      case 'get-vehicle-brands': {
        const brRes = await pool.query('SELECT * FROM vehicle_brands ORDER BY name ASC');
        return res.json(brRes.rows);
      }
      case 'save-vehicle-brand': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, name } = req.body;
        if (!name) return res.status(400).json({ error: 'Faltan datos obligatorios' });
        
        if (id) {
          await pool.query('UPDATE vehicle_brands SET name = $1 WHERE id = $2', [name, id]);
        } else {
          await pool.query('INSERT INTO vehicle_brands (name) VALUES ($1)', [name]);
        }
        return res.json({ success: true });
      }
      case 'delete-vehicle-brand': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id } = req.body;
        await pool.query('DELETE FROM vehicle_brands WHERE id = $1', [id]);
        return res.json({ success: true });
      }
      
      case 'get-vehicle-models': {
        const { brand_id } = req.query;
        let query = 'SELECT m.*, b.name as brand_name FROM vehicle_models m JOIN vehicle_brands b ON m.brand_id = b.id ORDER BY b.name ASC, m.name ASC';
        let params: any[] = [];
        if (brand_id) {
          query = 'SELECT m.*, b.name as brand_name FROM vehicle_models m JOIN vehicle_brands b ON m.brand_id = b.id WHERE m.brand_id = $1 ORDER BY m.name ASC';
          params = [brand_id];
        }
        const modRes = await pool.query(query, params);
        return res.json(modRes.rows);
      }
      case 'save-vehicle-model': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, brand_id, name } = req.body;
        if (!name || !brand_id) return res.status(400).json({ error: 'Faltan datos obligatorios' });
        
        if (id) {
          await pool.query('UPDATE vehicle_models SET brand_id = $1, name = $2 WHERE id = $3', [brand_id, name, id]);
        } else {
          await pool.query('INSERT INTO vehicle_models (brand_id, name) VALUES ($1, $2)', [brand_id, name]);
        }
        return res.json({ success: true });
      }
      case 'delete-vehicle-model': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id } = req.body;
        await pool.query('DELETE FROM vehicle_models WHERE id = $1', [id]);
        return res.json({ success: true });
      }

      case 'delete-coupon': {
        if (req.method !== 'POST') return res.status(405).end();
        const { couponId } = req.body;
        if (!couponId) return res.status(400).json({ error: 'Falta couponId' });
        await db.execute(sql`
          DELETE FROM coupons WHERE id = ${parseInt(couponId)}
        `);
        return res.json({ success: true });
      }

      case 'seo-autolinks-list': {
        const linksRes = await db.execute(sql`
          SELECT * FROM seo_autolinks ORDER BY created_at DESC
        `);
        return res.json(linksRes.rows);
      }

      case 'seo-autolinks-save': {
        if (req.method !== 'POST') return res.status(405).end();
        const { keyword, url, active } = req.body;
        if (!keyword || !url) return res.status(400).json({ error: 'Faltan datos obligatorios' });
        
        await db.execute(sql`
          INSERT INTO seo_autolinks (keyword, url, active)
          VALUES (${keyword.trim()}, ${url.trim()}, ${active !== undefined ? parseInt(active) : 1})
          ON CONFLICT (keyword) DO UPDATE
          SET url = EXCLUDED.url, active = EXCLUDED.active
        `);
        return res.json({ success: true });
      }

      case 'seo-autolinks-delete': {
        if (req.method !== 'POST') return res.status(405).end();
        const { linkId } = req.body;
        if (!linkId) return res.status(400).json({ error: 'Falta linkId' });
        await db.execute(sql`
          DELETE FROM seo_autolinks WHERE id = ${parseInt(linkId)}
        `);
        return res.json({ success: true });
      }

      case 'shipping-zones-list': {
        const zonesRes = await db.execute(sql`SELECT * FROM shipping_zones ORDER BY id ASC`);
        const methodsRes = await db.execute(sql`SELECT * FROM shipping_methods ORDER BY id ASC`);
        
        const result = zonesRes.rows.map((z: any) => {
          return {
            ...z,
            methods: methodsRes.rows.filter((m: any) => m.zone_id === z.id)
          };
        });
        
        return res.json(result);
      }

      case 'save-shipping-zone': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, name, regions } = req.body;
        if (!name || !regions) return res.status(400).json({ error: 'Faltan datos' });
        
        if (id) {
          await db.execute(sql`UPDATE shipping_zones SET name = ${sanitizeString(name)}, regions = ${JSON.stringify(regions)} WHERE id = ${parseIntSafe(id)}`);
        } else {
          await db.execute(sql`INSERT INTO shipping_zones (name, regions) VALUES (${sanitizeString(name)}, ${JSON.stringify(regions)})`);
        }
        return res.json({ success: true });
      }

      case 'delete-shipping-zone': {
        if (req.method !== 'POST') return res.status(405).end();
        const { zoneId } = req.body;
        if (!zoneId) return res.status(400).json({ error: 'Falta zoneId' });
        await db.execute(sql`DELETE FROM shipping_zones WHERE id = ${parseIntSafe(zoneId)}`);
        return res.json({ success: true });
      }

      case 'save-shipping-method': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, zoneId, name, cost, active, freeShippingThreshold } = req.body;
        if (!zoneId || !name || cost === undefined) return res.status(400).json({ error: 'Faltan datos' });
        
        if (id) {
          await db.execute(sql`UPDATE shipping_methods SET name = ${sanitizeString(name)}, cost = ${Number(cost)}, active = ${Number(active || 1)}, free_shipping_threshold = ${freeShippingThreshold === null ? null : Number(freeShippingThreshold)} WHERE id = ${parseIntSafe(id)}`);
        } else {
          await db.execute(sql`INSERT INTO shipping_methods (zone_id, name, cost, active, free_shipping_threshold) VALUES (${parseIntSafe(zoneId)}, ${sanitizeString(name)}, ${Number(cost)}, ${Number(active || 1)}, ${freeShippingThreshold === null ? null : Number(freeShippingThreshold)})`);
        }
        return res.json({ success: true });
      }

      case 'delete-shipping-method': {
        if (req.method !== 'POST') return res.status(405).end();
        const { methodId } = req.body;
        if (!methodId) return res.status(400).json({ error: 'Falta methodId' });
        await db.execute(sql`DELETE FROM shipping_methods WHERE id = ${parseIntSafe(methodId)}`);
        return res.json({ success: true });
      }

      case 'save-user': {
        if (req.method !== 'POST') return res.status(405).end();
        const { id, firstName, lastName, email, role, phone, address, city, postcode } = req.body;
        if (!id) return res.status(400).json({ error: 'Falta id de usuario' });
        
        const billingData = JSON.stringify({ 
          address_1: address || '', 
          city: city || '', 
          postcode: postcode || '', 
          phone: phone || '' 
        });

        await db.execute(sql`
          UPDATE users 
          SET first_name = ${sanitizeString(firstName || '')}, 
              last_name = ${sanitizeString(lastName || '')}, 
              email = ${sanitizeString(email || '')}, 
              role = ${sanitizeString(role || 'customer')},
              billing = ${billingData}
          WHERE id = ${parseIntSafe(id)}
        `);
        return res.json({ success: true });
      }

      default:
        return res.json({ status: 'ok' });
    }
  } catch (err: any) {
    console.error('[ADMIN ERROR]:', err);
    res.status(500).json({ error: err.message, detail: err.detail });
  }
});

// ================================================================
// AUTH (Login/Register/Profile)
// ================================================================
app.get('/api/auth', async (req, res) => {
  const { action, email, id } = req.query as any;

  try {
    if (action === 'get-profile') {
      if (!email && !id) return res.status(400).json({ error: 'Falta email o id' });

      let conditions = sql`WHERE 1=1`;
      if (email) {
        conditions.append(sql` AND LOWER(email) = LOWER(${email})`);
      } else if (id) {
        const safeId = parseIntSafe(id);
        if (!safeId) return res.status(400).json({ error: 'ID inválido' });
        conditions.append(sql` AND id = ${safeId}`);
      }

      const userRes = await db.execute(sql`SELECT * FROM users ${conditions}`);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;
      
      // Intentar decodificar metadatos o billing
      let billing = { address_1: '', city: '', postcode: '', phone: '' };
      try {
        if (user.billing) {
          billing = typeof user.billing === 'string' ? JSON.parse(user.billing) : user.billing;
        }
      } catch (e) {}

      let garage: any[] = [];
      try {
        if (user.garage) {
          garage = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage;
        }
      } catch (e) {}

      let cart: any[] = [];
      try {
        if (user.cart) {
          cart = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
        }
      } catch (e) {}

      return res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        avatarUrl: user.avatar_url || '',
        role: user.role || 'customer',
        rank: user.rank || 'Novato',
        xp: user.xp || 0,
        billing,
        garage,
        cart
      });
    } else if (action === 'search-users') {
      const { q } = req.query as any;
      if (!q) return res.json([]);

      const userRes = await db.execute(sql`
        SELECT id, username, first_name, last_name, avatar_url FROM users
        WHERE LOWER(username) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(email) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(first_name) LIKE ${'%' + q.toLowerCase() + '%'}
           OR LOWER(last_name) LIKE ${'%' + q.toLowerCase() + '%'}
        LIMIT 5
      `);

      const list = userRes.rows.map((row: any) => ({
        id: row.id,
        name: row.first_name ? `${row.first_name} ${row.last_name || ''}`.trim() : row.username,
        avatar: row.avatar_url || ''
      }));

      return res.json(list);
    }

    return res.status(400).json({ error: 'Acción no válida' });
  } catch (err: any) {
    console.error('[AUTH GET PROFILE ERROR]:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth', authLimiter, async (req, res) => {
  const { action } = req.query as any;
  const body = req.body;

  try {
    if (action === 'login' || action === 'social-login') {
      const { username, password } = body;
      if (!username) return res.status(400).json({ error: 'Falta email o usuario' });

      // Buscar por email o username en PostgreSQL
      const userRes = await db.execute(sql`
        SELECT * FROM users
        WHERE LOWER(email) = LOWER(${username}) OR LOWER(username) = LOWER(${username})
      `);

      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;

      // Si es un login social (bypass de contraseña)
      const isSocial = !!(body.provider && body.token);
      
      if (!isSocial) {
        // Verificar contraseña
        const isValid = await verifyPassword(password || '', user.password_hash);
        if (!isValid) {
          return res.status(401).json({ error: 'Contraseña incorrecta' });
        }
        
        // Migrar hash legacy a bcrypt si es necesario
        if (user.password_hash && isLegacyPasswordHash(user.password_hash)) {
          const newHash = await hashPassword(password || '');
          await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
          user.password_hash = newHash;
        }
      }

      // Si el usuario no tiene contraseña establecida, se la guardamos con bcrypt
      if (!user.password_hash) {
        const newHash = await hashPassword(password || '');
        await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`);
        user.password_hash = newHash;
      }

      // Generar JWT y respuesta de sesión
      const token = generateJWT(user);
      setAuthCookie(res, token);
      const session = {
        token,
        user_id: user.id,
        user_email: user.email,
        user_nicename: user.username,
        user_display_name: user.first_name || user.username,
        avatarUrl: user.avatar_url || '',
        role: user.role || 'customer'
      };

      return res.json(session);

    } else if (action === 'get-profile') {
      const { email, id } = body;
      if (!email && !id) return res.status(400).json({ error: 'Falta email o id' });

      let conditions = sql`WHERE 1=1`;
      if (email) {
        conditions.append(sql` AND LOWER(email) = LOWER(${email})`);
      } else if (id) {
        const safeId = parseIntSafe(id);
        if (!safeId) return res.status(400).json({ error: 'ID inválido' });
        conditions.append(sql` AND id = ${safeId}`);
      }

      const userRes = await db.execute(sql`SELECT * FROM users ${conditions}`);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      const user = userRes.rows[0] as any;

      let billing = { address_1: '', city: '', postcode: '', phone: '' };
      try {
        if (user.billing) {
          billing = typeof user.billing === 'string' ? JSON.parse(user.billing) : user.billing;
        }
      } catch (e) {}

      let garage: any[] = [];
      try {
        if (user.garage) {
          garage = typeof user.garage === 'string' ? JSON.parse(user.garage) : user.garage;
        }
      } catch (e) {}

      let cart: any[] = [];
      try {
        if (user.cart) {
          cart = typeof user.cart === 'string' ? JSON.parse(user.cart) : user.cart;
        }
      } catch (e) {}

      return res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        avatarUrl: user.avatar_url || '',
        role: user.role || 'customer',
        rank: user.rank || 'Novato',
        xp: user.xp || 0,
        billing,
        garage,
        cart
      });

    } else if (action === 'register') {
      const { username, email, password, firstName, lastName, phone } = body;
      if (!username || !email || !password) return res.status(400).json({ error: 'Faltan campos obligatorios' });

      // Comprobar si ya existe
      const existRes = await db.execute(sql`
        SELECT id FROM users
        WHERE LOWER(email) = LOWER(${email}) OR LOWER(username) = LOWER(${username})
      `);

      if (existRes.rows.length > 0) {
        return res.status(400).json({ error: 'El email o nombre de usuario ya está registrado' });
      }

      const passHash = await hashPassword(password);
      const role = 'customer';
      const billingData = JSON.stringify({ address_1: '', city: '', postcode: '', phone: phone || '' });

      const insertRes = await db.execute(sql`
        INSERT INTO users (username, email, password_hash, first_name, last_name, role, billing)
        VALUES (${username}, ${email}, ${passHash}, ${firstName || username}, ${lastName || ''}, ${role}, ${billingData})
        RETURNING id
      `);

      const newId = insertRes.rows[0]?.id;

      // Auto-login con JWT
      const newUser = { id: newId, email, username, role };
      const token = generateJWT(newUser);
      setAuthCookie(res, token);
      const session = {
        token,
        user_id: newId,
        user_email: email,
        user_nicename: username,
        user_display_name: firstName || username,
        avatarUrl: '',
        role
      };

      return res.json(session);
    } else if (action === 'update-profile') {
      const { userId, firstName, lastName, email, billing, garage, avatarUrl } = body;
      if (!userId) return res.status(400).json({ error: 'Falta userId' });

      // Cargar el usuario actual
      const userRes = await db.execute(sql`SELECT * FROM users WHERE id = ${parseInt(userId)}`);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

      const user = userRes.rows[0] as any;

      if (email && email.toLowerCase() !== user.email.toLowerCase()) {
        const existRes = await db.execute(sql`
          SELECT id FROM users
          WHERE LOWER(email) = LOWER(${email}) AND id != ${parseInt(userId)}
        `);
        if (existRes.rows.length > 0) {
          return res.status(400).json({ error: 'El correo electrónico ya está registrado por otro usuario' });
        }
      }

      let billingJson = user.billing;
      if (billing !== undefined) {
        billingJson = typeof billing === 'string' ? billing : JSON.stringify(billing);
      }

      let garageJson = user.garage;
      if (garage !== undefined) {
        garageJson = typeof garage === 'string' ? garage : JSON.stringify(garage);
      }

      await db.execute(sql`
        UPDATE users
        SET 
          first_name = COALESCE(${firstName || null}, first_name),
          last_name = COALESCE(${lastName || null}, last_name),
          email = COALESCE(${email || null}, email),
          billing = ${billingJson || null},
          garage = ${garageJson || null},
          avatar_url = COALESCE(${avatarUrl || null}, avatar_url)
        WHERE id = ${parseInt(userId)}
      `);

      return res.json({ success: true });
    } else if (action === 'save-cart') {
      const { userId, cart } = body;
      if (!userId) return res.status(400).json({ error: 'Falta userId' });
      await db.execute(sql`
        UPDATE users
        SET cart = ${cart ? JSON.stringify(cart) : null}
        WHERE id = ${parseInt(userId)}
      `);
      return res.json({ success: true });
    } else if (action === 'delete-account') {
      const { userId } = body;
      if (!userId) return res.status(400).json({ error: 'Falta userId' });

      const parsedId = parseInt(userId);
      try {
        await db.execute(sql`DELETE FROM users WHERE id = ${parsedId}`);
      } catch (err) {
        await db.execute(sql`
          UPDATE users
          SET 
            username = ${`eliminado_${parsedId}`},
            email = ${`eliminado_${parsedId}@escapesymas.com`},
            first_name = 'Usuario',
            last_name = 'Eliminado',
            password_hash = '',
            avatar_url = '',
            billing = null,
            garage = null,
            cart = null,
            role = 'customer'
          WHERE id = ${parsedId}
        `);
      }
    } else if (action === 'change-password') {
      const { userId, currentPassword, newPassword } = body;
      if (!userId || !currentPassword || !newPassword) return res.status(400).json({ error: 'Faltan campos obligatorios' });

      const userRes = await db.execute(sql`SELECT password_hash FROM users WHERE id = ${parseInt(userId)}`);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

      const user = userRes.rows[0] as any;
      const isValid = await verifyPassword(currentPassword, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
      }

      const newHash = await hashPassword(newPassword);
      await db.execute(sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${parseInt(userId)}`);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Acción no válida' });
  } catch (err: any) {
    console.error('[AUTH ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// FORUM (Paddock)
// ================================================================
const RANKS = [
  { level: 1, title: 'Novato', xpRequired: 0, icon: '🏍️' },
  { level: 2, title: 'Aprendiz', xpRequired: 50, icon: '⚡' },
  { level: 3, title: 'Piloto', xpRequired: 150, icon: '🏁' },
  { level: 4, title: 'Experto', xpRequired: 300, icon: '🔥' },
  { level: 5, title: 'Profesional', xpRequired: 500, icon: '💨' },
  { level: 6, title: 'Leyenda', xpRequired: 1000, icon: '👑' }
];
const XP = { POST: 15, REPLY: 10, RECV_LIKE: 5, GIVE_LIKE: 1 };
const calcRank = (xp: number) => { for (let i = RANKS.length - 1; i >= 0; i--) { if (xp >= RANKS[i].xpRequired) return RANKS[i]; } return RANKS[0]; };

app.all('/api/forum', async (req, res) => {
  const { action, category_id, thread_id } = req.query as any;

  try {
    switch (action) {
      case 'categories': {
        const cacheKey = '/api/forum?action=categories';
        const result = await executeSWR(cacheKey, async () => {
          return [
            { id: 1, title: '🔧 Mecánica y Taller', description: 'Consultas técnicas, bricos y mantenimiento.' },
            { id: 2, title: '🏍️ Compra-Venta', description: 'Mercadillo entre moteros.' },
            { id: 3, title: '🗺️ Rutas y Quedadas', description: 'Planea tu próxima salida.' },
            { id: 4, title: '🏁 General Paddock', description: 'Charlas generales sobre el mundo de las dos ruedas.' }
          ];
        }, 3600, 7200); // 1 hora de TTL fresco para categorías
        return res.json(result);
      }

      case 'threads': {
        const cacheKey = `/api/forum?action=threads&category_id=${category_id || ''}`;
        
        // Las listas de hilos se cachean por 10s frescos y 30s de gracia SWR
        const result = await executeSWR(cacheKey, async () => {
          const threads = await db.select({
            id: forumPosts.id, title: forumPosts.title, createdAt: forumPosts.createdAt,
            likes: forumPosts.likes, authorName: users.username, authorAvatar: users.avatarUrl,
            isPinned: forumPosts.isPinned, isClosed: forumPosts.isClosed
          }).from(forumPosts).leftJoin(users, eq(forumPosts.userId, users.id))
            .where(category_id ? eq(forumPosts.category, category_id) : undefined)
            .orderBy(desc(forumPosts.isPinned), desc(forumPosts.createdAt));
          return { data: threads };
        }, 10, 30);
        return res.json(result);
      }

      case 'thread-detail': {
        if (!thread_id) return res.status(400).json({ error: 'Falta thread_id' });
        const cacheKey = `/api/forum?action=thread-detail&thread_id=${thread_id}`;

        // Detalle de hilos: 5s frescos y 15s de gracia SWR
        const result = await executeSWR(cacheKey, async () => {
          const thread = await db.select().from(forumPosts).where(eq(forumPosts.id, parseInt(thread_id))).limit(1);
          const replies = await db.select({
            id: forumReplies.id, content: forumReplies.content, createdAt: forumReplies.createdAt,
            authorName: users.username, authorAvatar: users.avatarUrl, authorXP: users.rankXp
          }).from(forumReplies).leftJoin(users, eq(forumReplies.userId, users.id))
            .where(eq(forumReplies.postId, parseInt(thread_id))).orderBy(forumReplies.createdAt);
          return { thread: thread[0], replies: replies.map(r => ({ ...r, authorRank: calcRank(r.authorXP || 0) })) };
        }, 5, 15);
        return res.json(result);
      }

      case 'create-thread': {
        if (req.method !== 'POST') return res.status(405).end();
        const { title, content, userId, category } = req.body;
        const [newPost] = await db.insert(forumPosts).values({ userId, title, content, category: category || 'general' }).returning();
        await db.update(users).set({ rankXp: sql`${users.rankXp} + ${XP.POST}` }).where(eq(users.id, userId));
        
        // Purgar de inmediato la caché del foro al haber escritura
        swrCache.invalidatePattern('/api/forum');

        return res.json({ success: true, id: newPost.id });
      }

      case 'reply': {
        if (req.method !== 'POST') return res.status(405).end();
        const { postId, replyUserId, replyContent } = req.body;
        
        // Comprobar si el hilo está cerrado
        const thread = await db.select().from(forumPosts).where(eq(forumPosts.id, postId)).limit(1);
        if (thread[0]?.isClosed) {
          return res.status(400).json({ error: 'Este tema está cerrado y no admite más respuestas.' });
        }

        await db.insert(forumReplies).values({ postId, userId: replyUserId, content: replyContent });
        await db.update(users).set({ rankXp: sql`${users.rankXp} + ${XP.REPLY}` }).where(eq(users.id, replyUserId));
        
        // Purgar de inmediato la caché del foro al haber escritura
        swrCache.invalidatePattern('/api/forum');

        return res.json({ success: true });
      }

      case 'toggle-like': {
        if (req.method !== 'POST') return res.status(405).end();
        const { targetType, targetId, currentUserId } = req.body;
        const existing = await db.select().from(forumLikes).where(
          and(eq(forumLikes.userId, currentUserId), eq(forumLikes.contentType, targetType), eq(forumLikes.contentId, targetId))
        ).limit(1);

        if (existing.length > 0) {
          await db.delete(forumLikes).where(eq(forumLikes.id, existing[0].id));
          if (targetType === 'post') await db.update(forumPosts).set({ likes: sql`${forumPosts.likes} - 1` }).where(eq(forumPosts.id, targetId));
          
          swrCache.invalidatePattern('/api/forum');
          return res.json({ success: true, liked: false });
        } else {
          await db.insert(forumLikes).values({ userId: currentUserId, contentType: targetType, contentId: targetId });
          if (targetType === 'post') await db.update(forumPosts).set({ likes: sql`${forumPosts.likes} + 1` }).where(eq(forumPosts.id, targetId));
          await db.update(users).set({ rankXp: sql`${users.rankXp} + ${XP.GIVE_LIKE}` }).where(eq(users.id, currentUserId));
          
          swrCache.invalidatePattern('/api/forum');
          return res.json({ success: true, liked: true });
        }
      }

      default:
        return res.status(400).json({ error: 'Acción no reconocida' });
    }
  } catch (err: any) {
    console.error('[FORUM ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// USER RANK (nativo PostgreSQL)
// ================================================================
app.get('/api/user/:id/rank', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (!userId || isNaN(userId)) return res.status(400).json({ error: 'ID inválido' });

    const uRes = await db.execute(sql`SELECT rank_xp, rank_level, username FROM users WHERE id = ${userId}`);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = uRes.rows[0] as any;
    const xp: number = user.rank_xp || 0;
    const rank = calcRank(xp);
    const nextRank = RANKS.find(r => r.xpRequired > xp);

    return res.json({
      level: rank.level,
      title: rank.title,
      xp,
      next_xp: nextRank ? nextRank.xpRequired : xp,
      discount: Math.min((rank.level - 1) * 2, 10),
      icon: rank.icon
    });
  } catch (err: any) {
    console.error('[RANK ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// GARAGE
// ================================================================
app.all('/api/garage', async (req, res) => {
  const { userEmail } = req.query as any;
  if (!userEmail) return res.status(401).json({ error: 'No autorizado' });

  try {
    const user = await db.select().from(users).where(eq(users.email, userEmail)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = user[0].id;

    if (req.method === 'GET') {
      const vehicles = await db.select().from(garage).where(eq(garage.userId, userId));
      return res.json(vehicles);
    }
    if (req.method === 'POST') {
      const { brand, model, year } = req.body;
      if (!brand || !model || !year) return res.status(400).json({ error: 'Faltan datos' });
      const [v] = await db.insert(garage).values({ userId, brand, model, year }).returning();
      return res.status(201).json(v);
    }
    if (req.method === 'DELETE') {
      const { vehicleId } = req.body;
      await db.delete(garage).where(and(eq(garage.id, vehicleId), eq(garage.userId, userId)));
      return res.json({ success: true });
    }
    res.status(405).json({ error: 'Método no permitido' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// PUBLIC VALIDATIONS & dynamic mappings
// ================================================================
app.post('/api/coupons/validate', async (req: any, res: any) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, error: 'Falta el código de cupón' });

  try {
    const codeUpper = code.trim().toUpperCase();
    const coupRes = await db.execute(sql`
      SELECT * FROM coupons WHERE UPPER(code) = ${codeUpper} AND active = 1
    `);

    if (coupRes.rows.length > 0) {
      const c = coupRes.rows[0] as any;
      const now = new Date();
      const expiry = c.expires_at ? new Date(c.expires_at) : null;
      const underLimit = c.max_uses === null || c.times_used < c.max_uses;

      if ((!expiry || expiry > now) && underLimit) {
        return res.json({
          valid: true,
          code: c.code,
          type: c.type,
          value: c.value // en céntimos (si es fixed) o porcentaje (si es percent)
        });
      } else {
        return res.json({ valid: false, error: 'El cupón ha expirado o alcanzado su límite de uso' });
      }
    } else {
      // Legacy hardcoded fallbacks
      if (codeUpper === 'WELCOME10') {
        return res.json({ valid: true, code: 'WELCOME10', type: 'percent', value: 10 });
      } else if (codeUpper === 'RIDER20') {
        return res.json({ valid: true, code: 'RIDER20', type: 'percent', value: 20 });
      } else if (codeUpper === 'ENVIOFREE') {
        return res.json({ valid: true, code: 'ENVIOFREE', type: 'free_shipping', value: 0 });
      }
      return res.json({ valid: false, error: 'Cupón no válido' });
    }
  } catch (err: any) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post('/api/stock-notify', formsLimiter, async (req: any, res: any) => {
  const { email, productId } = req.body;
  if (!email || !productId) {
    return res.status(400).json({ success: false, error: 'Email y productId son requeridos' });
  }

  try {
    const productRes = await db.execute(sql`
      SELECT id FROM products WHERE id = ${productId}
    `);
    if (productRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Producto no encontrado' });
    }

    await db.execute(sql`
      INSERT INTO stock_notifications (product_id, email)
      VALUES (${productId}, ${email.trim().toLowerCase()})
      ON CONFLICT (product_id, email) DO NOTHING
    `);

    console.log(`[STOCK-NOTIFY] ${email} quiere que le avisen cuando el producto ${productId} vuelva a estar disponible`);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/seo/autolinks', async (req, res) => {
  try {
    const linksRes = await db.execute(sql`
      SELECT keyword, url FROM seo_autolinks WHERE active = 1
    `);
    const mapping: Record<string, string> = {};
    linksRes.rows.forEach((row: any) => {
      mapping[row.keyword] = row.url;
    });
    return res.json(mapping);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ENVÍOS PUBLIC (Cálculo dinámico en el Checkout)
// ================================================================
app.post('/api/shipping-estimate', async (req: any, res: any) => {
  try {
    const { country, zipCode, subtotalEur } = req.body;
    let shippingCents = 1500; // Fallback

    const reqCountry = country || 'ES';
    const reqZip = zipCode || '';
    const prefix2 = reqZip.substring(0, 2);

    const zonesRes = await db.execute(sql`SELECT * FROM shipping_zones`);
    const methodsRes = await db.execute(sql`SELECT * FROM shipping_methods WHERE active = 1`);

    let matchedZoneId = null;
    let exactMatch = false;

    for (const z of zonesRes.rows) {
      const regions = z.regions as string[];
      if (regions && regions.includes(`${reqCountry}-${prefix2}`)) {
        matchedZoneId = z.id;
        exactMatch = true;
        break;
      }
    }

    if (!exactMatch) {
      for (const z of zonesRes.rows) {
        const regions = z.regions as string[];
        if (regions && regions.includes(reqCountry)) {
          matchedZoneId = z.id;
          break;
        }
      }
    }

    if (matchedZoneId) {
      const zoneMethods = methodsRes.rows.filter((m: any) => m.zone_id === matchedZoneId);
      if (zoneMethods.length > 0) {
        const method = zoneMethods[0] as any;
        shippingCents = method.cost;
        if (method.free_shipping_threshold && subtotalEur >= method.free_shipping_threshold) {
          shippingCents = 0;
        }
      }
    }

    return res.json({ shippingCents, shippingCost: shippingCents / 100 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ================================================================
// PEDIDOS & CHECKOUT CUSTOM (PostgreSQL)
// ================================================================
app.post('/api/orders/create', async (req: any, res: any) => {
  try {
    const { userEmail, cart, shippingData, paymentMethod, promoCode } = req.body;
    if (!cart || cart.length === 0) return res.status(400).json({ error: 'El carrito está vacío' });
    if (!shippingData) return res.status(400).json({ error: 'Faltan datos de envío' });

    let dbUserId = null;
    if (userEmail) {
      const uRes = await db.execute(sql`SELECT id FROM users WHERE email = ${userEmail}`);
      if (uRes.rows.length > 0) dbUserId = uRes.rows[0].id;
    }

    // Calcular total seguro en céntimos consultando los productos en la BD
    let subtotalCents = 0;
    const itemsToInsert = [];
    const stockErrors: any[] = [];

    for (const item of cart) {
      const pRes = await db.execute(sql`SELECT price, sale_price, stock FROM products WHERE id = ${parseInt(item.id as string)}`);
      if (pRes.rows.length === 0) return res.status(400).json({ error: `Producto con ID ${item.id} no existe` });

      const dbRow = pRes.rows[0] as any;
      const dbPrice = dbRow.sale_price || dbRow.price || 0; // en céntimos
      const reqQty = parseInt(item.quantity as string);
      subtotalCents += (dbPrice as number) * reqQty;

      const currentStock = typeof dbRow.stock === 'string' ? parseInt(dbRow.stock) : (dbRow.stock || 0);
      if (currentStock < reqQty) {
        stockErrors.push({ id: item.id, requested: reqQty, available: currentStock });
      }

      itemsToInsert.push({
        productId: parseInt(item.id as string),
        quantity: reqQty,
        price: dbPrice
      });
    }

    if (stockErrors.length > 0) {
      console.warn(`[ORDER CREATE] Stock insuficiente:`, stockErrors);
      return res.status(409).json({
        error: 'Stock insuficiente para uno o más productos. Por favor, actualiza tu carrito.',
        stockErrors
      });
    }

    // Aplicar lógica de Tiers
    let discountPercent = 0;
    
    // ================================================================
    // LOGICA AVANZADA DE ENVÍOS (ZONAS Y TARIFAS)
    // ================================================================
    let shippingCents = 1500; // Fallback 15.00€
    const subtotalEur = subtotalCents / 100;
    
    // Obtener zona y método
    const reqCountry = shippingData.country || 'ES';
    const reqZip = shippingData.postcode || shippingData.zipCode || '';
    const prefix2 = reqZip.substring(0, 2);
    
    // Buscar la zona adecuada (intentar match exacto de país+prefijo, luego match de país, luego usar fallback)
    const zonesRes = await db.execute(sql`SELECT * FROM shipping_zones`);
    const methodsRes = await db.execute(sql`SELECT * FROM shipping_methods WHERE active = 1`);
    
    let matchedZoneId = null;
    let exactMatch = false;
    
    // 1. Match exacto (ej. "ES-07")
    for (const z of zonesRes.rows) {
      const regions = z.regions as string[];
      if (regions && regions.includes(`${reqCountry}-${prefix2}`)) {
        matchedZoneId = z.id;
        exactMatch = true;
        break;
      }
    }
    
    // 2. Match general de país (ej. "ES" sin más sufijos) si no hubo match exacto
    if (!exactMatch) {
      for (const z of zonesRes.rows) {
        const regions = z.regions as string[];
        if (regions && regions.includes(reqCountry)) {
          matchedZoneId = z.id;
          break;
        }
      }
    }
    
    if (matchedZoneId) {
      // Buscar método de envío asociado
      const zoneMethods = methodsRes.rows.filter((m: any) => m.zone_id === matchedZoneId);
      if (zoneMethods.length > 0) {
        const method = zoneMethods[0] as any;
        shippingCents = method.cost;
        if (method.free_shipping_threshold && subtotalEur >= method.free_shipping_threshold) {
          shippingCents = 0;
        }
      }
    }
    // ================================================================

    if (subtotalEur >= 500) {
      discountPercent = 15;
      shippingCents = 0;
    } else if (subtotalEur >= 300) {
      discountPercent = 10;
      shippingCents = 0;
    } else if (subtotalEur >= 150) {
      discountPercent = 5;
      shippingCents = 0;
    }

    // Aplicar lógica de Cupones/Promo Codes
    let promoDiscountPercent = 0;
    let promoFreeShipping = false;
    let promoFixedDiscountCents = 0;

    if (promoCode) {
      const codeUpper = promoCode.trim().toUpperCase();
      const coupRes = await db.execute(sql`
        SELECT * FROM coupons WHERE UPPER(code) = ${codeUpper} AND active = 1
      `);
      if (coupRes.rows.length > 0) {
        const c = coupRes.rows[0] as any;
        const now = new Date();
        const expiry = c.expires_at ? new Date(c.expires_at) : null;
        const underLimit = c.max_uses === null || c.times_used < c.max_uses;

        if ((!expiry || expiry > now) && underLimit) {
          if (c.type === 'percent') {
            promoDiscountPercent = c.value;
          } else if (c.type === 'fixed') {
            promoFixedDiscountCents = c.value; // en céntimos
          } else if (c.type === 'free_shipping') {
            promoFreeShipping = true;
          }
          
          // Incrementar contador de usos
          await db.execute(sql`
            UPDATE coupons SET times_used = times_used + 1 WHERE id = ${c.id}
          `);
        }
      } else {
        // Fallbacks legacy
        if (codeUpper === 'WELCOME10') {
          promoDiscountPercent = 10;
        } else if (codeUpper === 'RIDER20') {
          promoDiscountPercent = 20;
        } else if (codeUpper === 'ENVIOFREE') {
          promoFreeShipping = true;
        }
      }
    }

    const totalDiscountPercent = discountPercent + promoDiscountPercent;
    let discountCents = Math.round((subtotalCents * totalDiscountPercent) / 100) + promoFixedDiscountCents;
    
    if (promoFreeShipping) {
      shippingCents = 0;
    }

    const totalCents = Math.max(0, subtotalCents + shippingCents - discountCents);

    // Enriquecer shippingData con una traza financiera auditada de doble entrada
    const enrichedShippingData = {
      ...shippingData,
      financials: {
        subtotal: subtotalEur,
        discountPercent: totalDiscountPercent,
        discountAmount: discountCents / 100,
        shippingCost: shippingCents / 100,
        total: totalCents / 100,
        promoCode: promoCode || null,
        timestamp: new Date().toISOString()
      }
    };
    const shippingJson = JSON.stringify(enrichedShippingData);

    // Crear la orden en PostgreSQL con las columnas de contabilidad dedicadas
    const upperPromo = promoCode ? promoCode.trim().toUpperCase() : null;
    if (userEmail && userEmail !== 'undefined' && userEmail.includes('@')) {
      try {
        await db.execute(sql`
          UPDATE cart_abandoned_emails
          SET recovered_at = NOW(),
              last_activity_at = NOW()
          WHERE user_email = ${userEmail} AND recovered_at IS NULL
        `);
      } catch (e: any) {
        console.error('[MARK RECOVERED ERROR]:', e.message);
      }
    }

    const orderInsert = await db.execute(sql`
      INSERT INTO orders (user_id, total, status, shipping_data, subtotal, discount_amount, shipping_cost, promo_code)
      VALUES (${dbUserId}, ${totalCents}, 'pending', ${shippingJson}, ${subtotalCents}, ${discountCents}, ${shippingCents}, ${upperPromo})
      RETURNING id
    `);
    
    const newOrderId = orderInsert.rows[0].id;

    // Insertar items de la orden
    for (const item of itemsToInsert) {
      await db.execute(sql`
        INSERT INTO order_items (order_id, product_id, quantity, price)
        VALUES (${newOrderId}, ${item.productId}, ${item.quantity}, ${item.price})
      `);
    }

    res.status(201).json({
      success: true,
      orderId: newOrderId,
      total: totalCents / 100, // en euros
      subtotal: subtotalEur,
      discount: discountCents / 100,
      shipping: shippingCents / 100
    });
  } catch (err: any) {
    console.error('[ORDER CREATE ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/my-orders', async (req: any, res: any) => {
  const { userEmail } = req.query as any;
  if (!userEmail) return res.status(400).json({ error: 'Falta userEmail' });

  try {
    const uRes = await db.execute(sql`SELECT id FROM users WHERE email = ${userEmail}`);
    if (uRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    const userId = uRes.rows[0].id;

    const ordersRes = await db.execute(sql`
      SELECT * FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC
    `);

    const result = [];
    for (const rawOrder of ordersRes.rows) {
      const order = rawOrder as any;
      const itemsRes = await db.execute(sql`
        SELECT oi.*, p.name as product_name, p.images as product_images
        FROM order_items oi
        LEFT JOIN products p ON oi.product_id = p.id
        WHERE oi.order_id = ${order.id}
      `);
      
      let parsedShipping = {};
      try { parsedShipping = order.shipping_data ? JSON.parse(order.shipping_data as string) : {}; } catch { }

      result.push({
        id: order.id,
        total: (order.total as number) / 100, // en euros
        status: order.status,
        paymentId: order.payment_id,
        shippingData: parsedShipping,
        createdAt: order.created_at,
        items: itemsRes.rows.map(rawItem => {
          const item = rawItem as any;
          let imgs = [];
          try { imgs = item.product_images ? JSON.parse(item.product_images as string) : []; } catch { }
          return {
            id: item.id,
            productId: item.product_id,
            productName: item.product_name || 'Producto eliminado',
            image: imgs[0]?.src || imgs[0] || '',
            quantity: item.quantity,
            price: (item.price as number) / 100 // en euros
          };
        })
      });
    }

    res.json(result);
  } catch (err: any) {
    console.error('[MY ORDERS ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/finalize', async (req: any, res: any) => {
  try {
    const { orderId, paymentId, status } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Falta orderId' });

    if (!paymentId || typeof paymentId !== 'string') {
      console.warn(`[SECURITY] /api/orders/finalize rejected: missing paymentId. orderId=${orderId} ip=${req.ip}`);
      return res.status(400).json({ error: 'Falta paymentId. La finalización de pedidos requiere verificación con Stripe.' });
    }

    try {
      const client = getStripeClient(req);
      const paymentIntent = await client.paymentIntents.retrieve(paymentId);
      if (paymentIntent.status !== 'succeeded') {
        console.warn(`[ORDER FINALIZE WARNING]: PaymentIntent ${paymentId} is in status ${paymentIntent.status}. Rejecting order finalization.`);
        return res.status(400).json({ error: 'El pago ha sido rechazado o cancelado. Por favor, inténtalo de nuevo o prueba con otro método de pago.' });
      }
      const piOrderId = (paymentIntent.metadata && (paymentIntent.metadata.order_id || paymentIntent.metadata.orderId)) || null;
      if (piOrderId && String(piOrderId) !== String(orderId)) {
        console.warn(`[SECURITY] /api/orders/finalize rejected: paymentIntent ${paymentId} metadata.order_id=${piOrderId} does not match request orderId=${orderId}`);
        return res.status(400).json({ error: 'El paymentIntent no corresponde a esta orden.' });
      }
    } catch (stripeErr: any) {
      console.error('[ORDER FINALIZE STRIPE VERIFY ERROR]:', stripeErr);
      return res.status(400).json({ error: 'No se pudo verificar el estado del pago con Stripe.' });
    }

    await db.execute(sql`
      UPDATE orders
      SET status = ${status || 'processing'}, payment_id = ${paymentId}
      WHERE id = ${parseInt(orderId)}
    `);

    const finalStatus = status || 'processing';
    if (finalStatus === 'processing' || finalStatus === 'completed') {
      const itemsRes = await db.execute(sql`
        SELECT product_id, quantity FROM order_items WHERE order_id = ${parseInt(orderId)}
      `);

      for (const rawItem of itemsRes.rows) {
        const item = rawItem as any;
        await db.execute(sql`
          UPDATE products
          SET stock = GREATEST(0, stock - ${parseInt(item.quantity as string)})
          WHERE id = ${parseInt(item.product_id as string)}
        `);
      }

      try {
        await createInvoiceForOrder(parseInt(orderId));
        console.log(`[AUTO-INVOICE] Invoice auto-generated successfully for Order ${orderId}`);
      } catch (e: any) {
        console.error(`[AUTO-INVOICE ERROR] Failed to auto-generate invoice for Order ${orderId}:`, e);
      }
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('[ORDER FINALIZE ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ABANDONED CART EMAIL CRON
// ================================================================
import { renderAbandonedCartEmail } from './templates/abandoned-cart.js';

async function processAbandonedCartEmails() {
  try {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const windows = [
      { stage: 1 as const, afterMs: 1 * HOUR, beforeMs: 24 * HOUR, discount: 0 },
      { stage: 2 as const, afterMs: 24 * HOUR, beforeMs: 72 * HOUR, discount: 0.05 },
      { stage: 3 as const, afterMs: 72 * HOUR, beforeMs: 168 * HOUR, discount: 0.10 },
    ];

    for (const w of windows) {
      const after = new Date(now - w.afterMs).toISOString();
      const before = new Date(now - w.beforeMs).toISOString();
      const discountPct = w.discount;

      const rows = await db.execute(sql`
        SELECT id, user_email, cart_snapshot, cart_total_cents, emails_sent, recovery_token
        FROM cart_abandoned_emails
        WHERE recovered_at IS NULL
          AND emails_sent = ${w.stage - 1}
          AND last_activity_at < ${after}::timestamptz
          AND last_activity_at >= ${before}::timestamptz
        ORDER BY last_activity_at ASC
        LIMIT 50
      `);

      for (const raw of rows.rows) {
        const row = raw as any;
        const cartTotalCents = parseInt(row.cart_total_cents) || 0;
        const discountCents = Math.floor(cartTotalCents * discountPct);
        try {
          const { subject, html, text } = renderAbandonedCartEmail(
            {
              id: row.id,
              user_email: row.user_email,
              cart_snapshot: row.cart_snapshot,
              cart_total_cents: cartTotalCents,
              discount_cents: discountCents,
              emails_sent: row.emails_sent,
              last_activity_at: new Date(),
              recovery_token: row.recovery_token,
            },
            {
              siteUrl: process.env.SITE_URL || 'https://escapesymas.com',
              stage: w.stage,
            }
          );
          await sendMail(row.user_email, subject, text, html);
          await db.execute(sql`
            UPDATE cart_abandoned_emails
            SET emails_sent = ${w.stage},
                last_emailed_at = NOW(),
                discount_cents = ${discountCents}
            WHERE id = ${row.id}
          `);
          console.log(`[ABANDONED CART] Stage ${w.stage} email sent to ${row.user_email} (cart id ${row.id})`);
        } catch (sendErr: any) {
          console.error(`[ABANDONED CART] Failed to send stage ${w.stage} to ${row.user_email}:`, sendErr.message);
        }
      }
    }
  } catch (e: any) {
    console.error('[ABANDONED CART CRON ERROR]:', e.message);
  }
}

setInterval(() => {
  processAbandonedCartEmails().catch(e => console.error('[ABANDONED CART CRON INTERVAL ERROR]:', e));
}, 10 * 60 * 1000);

processAbandonedCartEmails().catch(e => console.error('[ABANDONED CART CRON INITIAL ERROR]:', e));

// ================================================================
// PERSISTENT CART ENDPOINTS
// ================================================================
app.post('/api/cart', async (req: any, res: any) => {
  try {
    const { userId, sessionToken, items, userEmail, userFirstName, userLastName, userUsername } = req.body;
    if (!sessionToken) return res.status(400).json({ error: 'Falta sessionToken' });
    const itemsStr = JSON.stringify(items || []);

    const safeUserId = userId && userId !== 'undefined' ? parseInt(userId) : null;

    if (safeUserId) {
      // Auto-sync WordPress customer profile to PostgreSQL users table
      const emailVal = userEmail || `wp_user_${safeUserId}@escapesymas.com`;
      const usernameVal = userUsername || `wp_user_${safeUserId}`;
      const fnameVal = userFirstName || '';
      const lnameVal = userLastName || '';

      const userExists = await db.execute(sql`
        SELECT id, wp_id FROM users WHERE wp_id = ${safeUserId} OR LOWER(email) = LOWER(${emailVal})
      `);

      if (userExists.rows.length > 0) {
        const matched = userExists.rows[0] as any;
        await db.execute(sql`
          UPDATE users
          SET wp_id = ${safeUserId}, email = ${emailVal}, username = ${usernameVal}, first_name = ${fnameVal}, last_name = ${lnameVal}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ${matched.id}
        `);
      } else {
        const usernameExists = await db.execute(sql`
          SELECT id FROM users WHERE LOWER(username) = LOWER(${usernameVal})
        `);
        const finalUsername = usernameExists.rows.length > 0 ? `${usernameVal}_${safeUserId}` : usernameVal;

        await db.execute(sql`
          INSERT INTO users (wp_id, username, email, first_name, last_name, role)
          VALUES (${safeUserId}, ${finalUsername}, ${emailVal}, ${fnameVal}, ${lnameVal}, 'customer')
        `);
      }
    }

    const existing = await db.execute(sql`
      SELECT id FROM carts WHERE session_token = ${sessionToken}
    `);

    if (existing.rows.length > 0) {
      await db.execute(sql`
        UPDATE carts
        SET user_id = ${safeUserId}, items = ${itemsStr}, updated_at = CURRENT_TIMESTAMP
        WHERE session_token = ${sessionToken}
      `);
    } else {
      await db.execute(sql`
        INSERT INTO carts (user_id, session_token, items)
        VALUES (${safeUserId}, ${sessionToken}, ${itemsStr})
      `);
    }

    try {
      const safeEmail = (userEmail && userEmail !== 'undefined' && userEmail.includes('@')) ? userEmail : null;
      const safeItems = Array.isArray(items) ? items.filter((it: any) => it && (it.id || it.product_id)) : [];
      if (safeEmail && safeItems.length > 0) {
        const cartTotalCents = safeItems.reduce((acc: number, it: any) => {
          const cents = typeof it.price === 'number' ? it.price : (parseInt(it.price) || 0);
          const qty = parseInt(it.quantity) || 1;
          return acc + cents * qty;
        }, 0);

        const existingAbandoned = await db.execute(sql`
          SELECT id, recovered_at FROM cart_abandoned_emails
          WHERE user_email = ${safeEmail} AND recovered_at IS NULL
          LIMIT 1
        `);

        if (cartTotalCents > 0) {
          const snapshot = JSON.stringify(items);
          if (existingAbandoned.rows.length > 0) {
            await db.execute(sql`
              UPDATE cart_abandoned_emails
              SET cart_snapshot = ${snapshot}::jsonb,
                  cart_total_cents = ${cartTotalCents},
                  last_activity_at = NOW(),
                  emails_sent = 0,
                  last_emailed_at = NULL
              WHERE id = ${(existingAbandoned.rows[0] as any).id}
            `);
          } else {
            await db.execute(sql`
              INSERT INTO cart_abandoned_emails (user_email, cart_snapshot, cart_total_cents)
              VALUES (${safeEmail}, ${snapshot}::jsonb, ${cartTotalCents})
            `);
          }
        }
      }
    } catch (abandonedErr: any) {
      console.error('[CART ABANDONED TRACK ERROR]:', abandonedErr.message);
    }

    try {
      const { sendServerSideEvent } = await import('./lib/server-tracking.js');
      const safeItemsForTrack = Array.isArray(items) ? items.filter((it: any) => it && (it.id || it.product_id)) : [];
      const safeEmailForTrack = (userEmail && userEmail !== 'undefined' && userEmail.includes('@')) ? userEmail : undefined;
      if (safeItemsForTrack.length > 0 && safeEmailForTrack) {
        const itemForEvent = safeItemsForTrack[safeItemsForTrack.length - 1] as any;
        const itemCents = typeof itemForEvent.price === 'number' ? itemForEvent.price : (parseInt(itemForEvent.price) || 0);
        const itemQty = parseInt(itemForEvent.quantity) || 1;
        const itemProductId = itemForEvent.id || itemForEvent.product_id;
        const cartTotalCents = safeItemsForTrack.reduce((acc: number, it: any) => {
          const cents = typeof it.price === 'number' ? it.price : (parseInt(it.price) || 0);
          const qty = parseInt(it.quantity) || 1;
          return acc + cents * qty;
        }, 0);
        await sendServerSideEvent({
          eventName: 'add_to_cart',
          eventId: `add_to_cart_${safeEmailForTrack}_${itemProductId}_${Date.now()}`,
          userEmail: safeEmailForTrack,
          userAgent: req.headers['user-agent'] as string,
          clientIp: req.ip,
          payload: {
            currency: 'EUR',
            value: cartTotalCents / 100,
            content_ids: [String(itemProductId)],
            content_type: 'product',
            content_name: itemForEvent.name || itemForEvent.title || '',
            content_price: itemCents / 100,
            quantity: itemQty,
          },
        });
      }
    } catch (trackErr: any) {
      console.error('[CART ADD SERVER TRACKING ERROR]:', trackErr.message);
    }

    return res.json({ success: true });
  } catch (e: any) {
    console.error('[CART SAVE ERROR]:', e);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/cart/recover/:token', async (req: any, res: any) => {
  try {
    const { token } = req.params;
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
      return res.status(400).json({ error: 'Token inválido' });
    }

    const result = await db.execute(sql`
      SELECT id, user_email, cart_snapshot, cart_total_cents, discount_cents, recovered_at
      FROM cart_abandoned_emails
      WHERE recovery_token = ${token}::uuid
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrito no encontrado' });
    }

    const row = result.rows[0] as any;
    const wasAlreadyRecovered = row.recovered_at !== null;

    if (wasAlreadyRecovered) {
      await db.execute(sql`
        UPDATE cart_abandoned_emails
        SET recovered_at = NULL,
            emails_sent = 0,
            last_emailed_at = NULL,
            last_activity_at = NOW()
        WHERE id = ${row.id}
      `);
    }

    res.json({
      email: row.user_email,
      cart: row.cart_snapshot,
      total_cents: row.cart_total_cents,
      discount_cents: row.discount_cents,
      already_recovered: wasAlreadyRecovered,
      recovery_token: token,
    });
  } catch (err: any) {
    console.error('[CART RECOVER GET ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cart/recover/:token', async (req: any, res: any) => {
  try {
    const { token } = req.params;
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
      return res.status(400).json({ error: 'Token inválido' });
    }

    const result = await db.execute(sql`
      UPDATE cart_abandoned_emails
      SET recovered_at = NOW(), last_activity_at = NOW()
      WHERE recovery_token = ${token}::uuid AND recovered_at IS NULL
      RETURNING id, user_email
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carrito ya recuperado o no encontrado' });
    }

    res.json({ success: true, email: (result.rows[0] as any).user_email });
  } catch (err: any) {
    console.error('[CART RECOVER POST ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cart', async (req: any, res: any) => {
  try {
    const { sessionToken, userId } = req.query as any;
    if (!sessionToken) return res.status(400).json({ error: 'Falta sessionToken' });

    let cartRes;
    if (userId && userId !== 'undefined') {
      cartRes = await db.execute(sql`
        SELECT * FROM carts 
        WHERE user_id = ${parseInt(userId)} OR session_token = ${sessionToken}
        ORDER BY updated_at DESC LIMIT 1
      `);
    } else {
      cartRes = await db.execute(sql`
        SELECT * FROM carts WHERE session_token = ${sessionToken}
      `);
    }

    if (cartRes.rows.length > 0) {
      const cart = cartRes.rows[0] as any;
      return res.json({
        id: cart.id,
        userId: cart.user_id,
        sessionToken: cart.session_token,
        items: cart.items ? JSON.parse(cart.items as string) : [],
        updatedAt: cart.updated_at
      });
    } else {
      return res.json({ items: [] });
    }
  } catch (e: any) {
    console.error('[CART GET ERROR]:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ================================================================
// COMPLEMENTARY ENDPOINTS (Checkout, Stripe, Contact, Warranty)
// ================================================================

app.post('/api/create-payment-intent', async (req: any, res: any) => {
  const { orderId, amount, currency, customerEmail, eventId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Importe inválido' });

  try {
    const client = getStripeClient(req);
    const metadata: Record<string, string> = { orderId: String(orderId) };
    if (eventId) {
      metadata.event_id = eventId;
      metadata.customer_email = customerEmail || '';
    }
    const paymentIntent = await client.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: (currency || 'eur').toLowerCase(),
      metadata,
      receipt_email: customerEmail || undefined,
      payment_method_types: ['card', 'bizum', 'klarna'],
    });

    console.log(`[STRIPE] PaymentIntent created: ${paymentIntent.id} for order ${orderId} (${amount} EUR)`);
    return res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error: any) {
    console.error('[STRIPE CREATE PAYMENT INTENT ERROR]:', error.message || error);
    console.error('[STRIPE ERROR TYPE]:', error.type);
    console.error('[STRIPE ERROR CODE]:', error.code);
    console.error('[STRIPE ERROR DETAIL]:', error.detail);

    const isExpiredKey = (error.message || '').includes('Expired API Key') || error.code === 'authentication_error';
    const isInvalidKey = (error.message || '').includes('Invalid API Key') || error.code === 'authentication_error';
    const userMessage = isExpiredKey
      ? 'La clave de Stripe ha expirado. El administrador debe renovarla en https://dashboard.stripe.com/apikeys'
      : isInvalidKey
      ? 'La clave de Stripe es inválida. Verifica STRIPE_SECRET_KEY en la configuración del servidor.'
      : 'Error al procesar el pago. Inténtalo de nuevo o contacta con soporte si persiste.';

    return res.status(isExpiredKey || isInvalidKey ? 503 : 500).json({
      error: userMessage,
      detail: error.message,
      code: error.code || 'unknown',
      type: error.type || 'unknown',
      requires_admin_action: isExpiredKey || isInvalidKey,
    });
  }
});

app.post('/api/contact', formsLimiter, async (req: any, res: any) => {
  const { name, email, subject, message } = req.body;

  console.log("[CONTACT] Received request from:", name, email);

  if (!name || !email || !message) {
    console.log("[CONTACT] Missing required fields");
    return res.status(400).json({ error: "Faltan campos requeridos" });
  }

  try {
    console.log("[CONTACT] Creating transporter...");
    const transporter = nodemailer.createTransport({
      host: "smtp.buzondecorreo.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER || "web@escapesymas.com",
        pass: process.env.SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true'
      }
    });

    console.log("[CONTACT] Verifying transporter connection...");
    await transporter.verify();
    console.log("[CONTACT] Transporter verified successfully");

    const mailOptions = {
      from: '"Escapes y Más Web" <web@escapesymas.com>',
      to: "info@escapesymas.com",
      replyTo: email,
      subject: `Consulta de ${subject || 'General'}`,
      html: `
        <h3>Nueva Consulta desde la Web</h3>
        <p><strong>De:</strong> ${name} (${email})</p>
        <p><strong>Asunto:</strong> ${subject || 'General'}</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-left: 5px solid #ff4500;">
          <p>${message.replace(/\n/g, '<br>').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
        </div>
      `
    };

    console.log("[CONTACT] Sending email...");
    const info = await transporter.sendMail(mailOptions);
    console.log("[CONTACT] ✅ Email sent successfully:", info.messageId);
    return res.status(200).json({ success: true, messageId: info.messageId });

  } catch (error: any) {
    console.error("[CONTACT] ❌ Email error:", error.message);
    return res.status(500).json({ error: "Error al enviar el correo: " + error.message });
  }
});

app.post('/api/warranty', formsLimiter, async (req: any, res: any) => {
  const { invoiceNumber, purchaseDate, installationDate, buyerName, email, phone, products, images } = req.body;

  console.log("[WARRANTY] Received request from:", buyerName, email);

  if (!invoiceNumber || !email || !buyerName) {
    console.log("[WARRANTY] Missing required fields");
    return res.status(400).json({ message: 'Faltan datos obligatorios' });
  }

  try {
    console.log("[WARRANTY] Creating transporter...");
    const transporter = nodemailer.createTransport({
      host: 'smtp.buzondecorreo.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER || 'web@escapesymas.com',
        pass: process.env.SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true'
      }
    });

    const productRows = (products || []).map((p: any) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${p.name}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${p.issue}</td>
      </tr>
    `).join('');

    const htmlContent = `
      <h2>Nueva Solicitud de Garantía</h2>
      <p><strong>Factura:</strong> ${invoiceNumber}</p>
      <p><strong>Fecha Compra:</strong> ${purchaseDate}</p>
      <p><strong>Fecha Instalación:</strong> ${installationDate || 'No indicada'}</p>
      <p><strong>Titular:</strong> ${buyerName}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Teléfono:</strong> ${phone}</p>
      
      <h3>Productos e Incidencias</h3>
      <table style="width: 100%; border-collapse: collapse;">
        <thead>
          <tr style="background: #f0f0f0;">
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Producto</th>
            <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Incidencia</th>
          </tr>
        </thead>
        <tbody>
          ${productRows}
        </tbody>
      </table>
    `;

    const attachments = (images || []).map((img: string, index: number) => {
      const split = img.split(',');
      const typeMatch = split[0].match(/:(.*?);/);
      const type = typeMatch ? typeMatch[1] : 'image/jpeg';
      const itemContent = split[1];
      const ext = type.split('/')[1] || 'jpg';

      return {
        filename: `evidencia_${index + 1}.${ext}`,
        content: itemContent,
        encoding: 'base64'
      };
    });

    try {
      await transporter.sendMail({
        from: '"Portal Garantías" <web@escapesymas.com>',
        to: 'garantiasydevoluciones@escapesymas.com',
        replyTo: email,
        subject: `[GARANTÍA] ${invoiceNumber} - ${buyerName}`,
        html: htmlContent,
        attachments: attachments
      });

      await transporter.sendMail({
        from: '"Escapes y Más" <web@escapesymas.com>',
        to: email,
        replyTo: 'garantiasydevoluciones@escapesymas.com',
        subject: 'Hemos recibido tu solicitud de garantía',
        html: `
          <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; border-radius: 6px; color: #0f172a; border: 1px solid #e2e8f0;">
            <div style="text-align: center; margin-bottom: 30px;">
              <img src="https://www.escapesymas.com/logo-cabecera-negro.svg" alt="Escapes y Más" style="max-width: 250px;">
            </div>
            <h2 style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; text-align: center; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">¡HOLA ${buyerName}!</h2>
            <div style="background-color: #ffffff; padding: 25px; border-radius: 6px; border-left: 4px solid #eab308; margin: 20px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
              <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">
                Hemos recibido tu solicitud de garantía asociada a la factura <strong>${invoiceNumber}</strong>.
              </p>
              <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 0;">
                Nuestro equipo revisará la información y te contactará en breve. Gracias por confiar en Escapes y Más.
              </p>
            </div>
            <p style="color: #64748b; font-size: 14px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">
              ¿Tienes dudas? Responde a este correo o escríbenos a <a href="mailto:info@escapesymas.com" style="color: #0f172a; font-weight: 600;">info@escapesymas.com</a>.<br><br>
              <strong>Escapes y Más</strong>
            </p>
          </div>
        `
      });

      return res.status(200).json({ success: true, message: 'Correo enviado correctamente' });

    } catch (error: any) {
      console.error('Error enviando correo:', error);
      return res.status(500).json({ success: false, message: 'Error al enviar el correo: ' + error.message });
    }
  } catch (err: any) {
    console.error('[WARRANTY] Outer error:', err);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

// ================================================================
// WP PROXY — ELIMINADO (WordPress fue desinstalado, endpoint removido)
// ================================================================
// El endpoint /wp-json/* fue eliminado. Todas las peticiones deben usar /api/*

// ================================================================
// UTILIDADES
// ================================================================
const PUBLIC_ATTR_KEYS = new Set([
  'Talla', 'Color',
  'Estilo de casco', 'Tipo de cierre', 'Modelo de casco',
  'Estilo de pintura', 'Acabado de la pintura',
  'Composición', 'Homologación', 'Colección',
  'Tipo de pieza de repuesto'
]);

function parseAttributes(raw: any): { name: string; value: string }[] {
  if (!raw) return [];
  let obj: Record<string, any> = {};
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return []; }
  } else if (typeof raw === 'object') {
    obj = raw;
  } else {
    return [];
  }
  return Object.entries(obj)
    .filter(([key, val]) => PUBLIC_ATTR_KEYS.has(key) && val !== null && val !== undefined && val !== '')
    .map(([key, val]) => ({ name: key, value: String(val) }));
}

function mapProductToFrontend(row: any) {
  const priceEur = (row.price || 0) / 100;
  const salePriceEur = row.sale_price ? row.sale_price / 100 : null;
  let images: any[] = [];
  if (row.images) {
    if (typeof row.images === 'string') {
      try { images = JSON.parse(row.images); } catch { images = []; }
    } else {
      images = row.images;
    }
  }
  
  images = (Array.isArray(images) ? images : []).map((img: any, idx: number) => {
    if (typeof img === 'string') {
      img = { src: img, alt: row.name };
    }
    if (img.srcSet && typeof img.srcSet === 'object') {
      img = {
        src: img.src,
        srcMobile: img.srcSet.mobile || img.srcSet['mobile'],
        srcCardDesktop: img.srcSet['card-desktop'] || img.srcSet.cardDesktop,
        srcCardMobile: img.srcSet['card-mobile'] || img.srcSet.cardMobile,
        alt: img.alt || row.name
      };
    }
    // Map URL to SRC for legacy data or API data
    if (img.url && !img.src) {
      img.src = img.url;
    }
    // Auto-fill srcCardMobile/Desktop/Mobile from src si faltan (productos Bihr sin srcSet)
    if (img.src && !img.srcCardMobile) img.srcCardMobile = img.src;
    if (img.src && !img.srcCardDesktop) img.srcCardDesktop = img.src;
    if (img.src && !img.srcMobile) img.srcMobile = img.src;
    // Reescritura a local: si src apunta a una URL remota y existe archivo local para este SKU/variante, sustituir.
    if (img.src && isRemoteImageUrl(img.src)) {
      const local = localImageForSku(row.sku, 'desktop', idx);
      if (local) img.src = local;
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.src)) {
        img.src = `/api/image-proxy?w=800&url=${encodeURIComponent(img.src)}`;
      }
    }
    if (img.srcMobile && isRemoteImageUrl(img.srcMobile)) {
      const local = localImageForSku(row.sku, 'mobile', idx);
      if (local) img.srcMobile = local;
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.srcMobile)) {
        img.srcMobile = `/api/image-proxy?w=600&url=${encodeURIComponent(img.srcMobile)}`;
      }
    }
    if (img.srcCardDesktop && isRemoteImageUrl(img.srcCardDesktop)) {
      const local = localImageForSku(row.sku, 'card-desktop', idx);
      if (local) img.srcCardDesktop = local;
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.srcCardDesktop)) {
        img.srcCardDesktop = `/api/image-proxy?w=400&url=${encodeURIComponent(img.srcCardDesktop)}`;
      }
    }
    if (img.srcCardMobile && isRemoteImageUrl(img.srcCardMobile)) {
      const local = localImageForSku(row.sku, 'card-mobile', idx);
      if (local) img.srcCardMobile = local;
      else if (/^https?:\/\/(api\.|cdn\.)?mybihr\.com\//i.test(img.srcCardMobile)) {
        img.srcCardMobile = `/api/image-proxy?w=200&url=${encodeURIComponent(img.srcCardMobile)}`;
      }
    }
    return img;
  });
  if (row.sku === '1124335') {
    console.log('[DEBUG] 1124335 raw images:', row.images);
    console.log('[DEBUG] 1124335 mapped images:', JSON.stringify(images));
  }
  let compatibility: any[] = [];
  try {
    if (row.compatibility) {
      compatibility = typeof row.compatibility === 'string' ? JSON.parse(row.compatibility) : row.compatibility;
    }
  } catch { }

  const catInfo = categoryMap[row.category_id] || { name: "General", slug: "general" };

  const productImage = images[0]?.src || '';
  const finalImage = productImage || '';

  // Subcategorías
  const cat2Info = row.category2_id ? categoryMap[row.category2_id] : null;
  const cat3Info = row.category3_id ? categoryMap[row.category3_id] : null;

  return {
    id: row.id, title: row.name, name: row.name,
    slug: row.sku?.toLowerCase().replace(/[^a-z0-9]/g, '-') || `product-${row.id}`,
    price: salePriceEur || priceEur, regularPrice: priceEur, salePrice: salePriceEur,
    sku: row.sku || '', image: finalImage, images: images.length ? images : [{ src: '', alt: row.name }],
    providerId: row.provider_id || 'bihr',
    inStock: (row.stock || 0) > 0, stock: row.stock || 0,
    category: catInfo.name, categorySlug: catInfo.slug, categoryId: row.category_id || 0,
    category2: row.category2 || '', category3: row.category3 || '',
    category2Id: row.category2_id || null, category3Id: row.category3_id || null,
    category2Name: cat2Info?.name || '', category2Slug: cat2Info?.slug || '',
    category3Name: cat3Info?.name || '', category3Slug: cat3Info?.slug || '',
    description: row.description || '',
    shortDescription: row.description ? row.description.substring(0, 150) + '...' : '',
    status: row.status, compatibility, attributes: parseAttributes(row.attributes),
    brand: row.brand || '', barcode: row.barcode || '',
    supplierCode: row.supplier_code || '', oldPartNumber: row.old_part_number || '',
    weight_g: row.weight_g || null, length_mm: row.length_mm || null,
    width_mm: row.width_mm || null, height_mm: row.height_mm || null,
    volume_cm3: row.volume_cm3 || null,
    dropshipping: row.dropshipping || false, ondemand: row.ondemand || false,
    deliveryPlant: row.delivery_plant || '', commodityCode: row.commodity_code || '',
    averageRating: parseFloat(row.avg_rating) || 0,
    ratingCount: parseInt(row.review_count) || 0,
    source: 'postgresql'
  };
}

// ================================================================
// CATEGORÍAS (público)
// ================================================================
app.get('/api/catalog/categories', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, parent_id
       FROM categories
       WHERE status = 'active'
       ORDER BY sort_order, id`
    );

    const categories = result.rows.map((row: any) => {
      if (row.parent_id === null) {
        return { id: row.id, name: row.name, slug: row.slug, parentId: 0, parentName: '', parentSlug: '' };
      }
      const parent = result.rows.find((r: any) => r.id === row.parent_id);
      return {
        id: row.id, name: row.name, slug: row.slug,
        parentId: row.parent_id,
        parentName: parent?.name || '', parentSlug: parent?.slug || ''
      };
    });

    res.json(categories);
  } catch (err) {
    console.error('[CATEGORIES API ERROR]:', err);
    res.status(500).json([]);
  }
});

// ================================================================
// DROPSHIPPING STATUS & TRACKING DAEMON
// ================================================================

async function sendShipmentNotificationEmail(orderId: number, email: string, firstName: string, trackingNumber: string, trackingUrl: string) {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.buzondecorreo.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER || "web@escapesymas.com",
        pass: process.env.SMTP_PASSWORD
      },
      tls: {
        rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true'
      }
    });

    const clientName = firstName || 'Motero';
    const trackLink = trackingUrl || `https://www.google.com/search?q=tracking+${trackingNumber}`;

    const mailOptions = {
      from: '"Escapes y Más" <web@escapesymas.com>',
      to: email,
      subject: `🏍️ ¡Tu pedido #${orderId} ha sido enviado!`,
      html: `
        <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #f8fafc; border-radius: 6px; color: #0f172a; border: 1px solid #e2e8f0;">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://www.escapesymas.com/logo-cabecera-negro.svg" alt="Escapes y Más" style="max-width: 250px;">
          </div>
          <h2 style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #0f172a; text-align: center; font-size: 24px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">¡HOLA ${clientName}!</h2>
          <div style="background-color: #ffffff; padding: 25px; border-radius: 6px; border-left: 4px solid #eab308; margin: 20px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0;">
            <p style="color: #475569; font-size: 16px; line-height: 1.6; margin-top: 0;">
              ¡Buenas noticias! Tu pedido <strong>#${orderId}</strong> ha sido empaquetado y enviado.
            </p>
            
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 15px; margin: 20px 0; text-align: center;">
              <p style="margin: 0 0 10px 0; font-size: 12px; text-transform: uppercase; color: #64748b; letter-spacing: 1px; font-weight: 600;">NÚMERO DE SEGUIMIENTO (TRACKING)</p>
              <div style="font-size: 20px; font-weight: 700; color: #eab308; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 1px;">${trackingNumber}</div>
            </div>
          </div>
          
          <div style="text-align: center; margin: 40px 0;">
            <a href="${trackLink}" target="_blank" style="background-color: #eab308; color: #000000; padding: 16px 32px; text-decoration: none; font-size: 16px; border-radius: 6px; font-weight: 700; display: inline-block; text-transform: uppercase; letter-spacing: 0.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">Seguir Mi Envío</a>
          </div>

          <p style="color: #64748b; font-size: 14px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 20px; margin-bottom: 0;">
            ¿Tienes dudas? Responde a este correo o escríbenos a <a href="mailto:info@escapesymas.com" style="color: #0f172a; font-weight: 600;">info@escapesymas.com</a>.<br><br>
            <strong>Escapes y Más</strong>
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    console.log(`[SHIPMENT EMAIL]: Sent shipment email to ${email} for order #${orderId}`);
  } catch (error) {
    console.error(`[SHIPMENT EMAIL ERROR] Failed to send email to ${email}:`, error);
  }
}

async function checkPendingDropshippingOrders() {
  try {
    const { getBihrOrderStatus } = await import('./bihrService.js');
    const pendingOrdersRes = await db.execute(sql`
      SELECT id, bihr_ticket_id, tracking_number, shipping_data FROM orders
      WHERE dropshipping_status = 'pending_bihr' AND bihr_ticket_id IS NOT NULL AND bihr_ticket_id <> ''
    `);

    for (const row of pendingOrdersRes.rows) {
      const order = row as any;
      try {
        const statusData = await getBihrOrderStatus(order.bihr_ticket_id);
        const bihrStatus = (statusData.status || statusData.Status || '').toLowerCase();
        
        let dropshippingStatus = 'pending_bihr';
        if (bihrStatus === 'shipped') {
          dropshippingStatus = 'shipped';
        } else if (bihrStatus === 'cancelled' || bihrStatus === 'canceled') {
          dropshippingStatus = 'cancelled';
        }

        const trackingNumber = statusData.trackingNumber || statusData.TrackingNumber || order.tracking_number || null;
        const trackingUrl = statusData.trackingUrl || statusData.TrackingUrl || null;

        await db.execute(sql`
          UPDATE orders
          SET dropshipping_status = ${dropshippingStatus},
              tracking_number = ${trackingNumber},
              tracking_url = ${trackingUrl},
              status = CASE WHEN ${dropshippingStatus} = 'shipped' THEN 'completed' ELSE status END
          WHERE id = ${order.id}
        `);

        // Enviar correo si acaba de pasar a enviado
        if (dropshippingStatus === 'shipped' && trackingNumber && trackingNumber !== order.tracking_number) {
          const shippingData = order.shipping_data ? JSON.parse(order.shipping_data as string) : {};
          const clientEmail = shippingData.email;
          const clientName = shippingData.firstName;
          if (clientEmail) {
            await sendShipmentNotificationEmail(order.id, clientEmail, clientName, trackingNumber, trackingUrl || '');
          }
        }
      } catch (err) {
        console.error(`[DROPSHIPPING CRON]: Error checking order #${order.id}:`, err);
      }
    }
  } catch (error) {
    console.error('[DROPSHIPPING CRON]: Error running periodic dropshipping status update:', error);
  }
}

// ================================================================
// STRIPE WEBHOOK
// ================================================================
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req: any, res: any) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const testWebhookSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET;

  let event: any;
  try {
    if (!sig) throw new Error('No Stripe signature header');
    if (!webhookSecret && !testWebhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }
    if (testWebhookSecret) {
      try {
        event = stripeTest.webhooks.constructEvent(req.body, sig, testWebhookSecret);
      } catch (e) {
        // Ignore and check live secret
      }
    }
    if (!event && webhookSecret) {
      try {
        event = stripeLive.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (e) {
        // Ignore
      }
    }
    if (!event) {
      throw new Error('Signature verification failed');
    }
  } catch (err: any) {
    console.error('[STRIPE WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[STRIPE WEBHOOK] Received event: ${event.type}`);

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as any;
    const orderId = paymentIntent.metadata?.orderId;

    if (orderId) {
      try {
        await db.execute(sql`
          UPDATE orders
          SET status = 'processing', payment_id = ${paymentIntent.id}
          WHERE id = ${parseInt(orderId)} AND status = 'pending'
        `);

        const itemsRes = await db.execute(sql`
          SELECT product_id, quantity FROM order_items WHERE order_id = ${parseInt(orderId)}
        `);
        for (const rawItem of itemsRes.rows) {
          const item = rawItem as any;
          await db.execute(sql`
            UPDATE products
            SET stock = GREATEST(0, stock - ${parseInt(item.quantity as string)})
            WHERE id = ${parseInt(item.product_id as string)}
          `);
        }

        let invoiceRecord: any = null;
        try {
          invoiceRecord = await createInvoiceForOrder(parseInt(orderId));
          console.log(`[STRIPE WEBHOOK] Invoice auto-generated for Order ${orderId}`);
        } catch (e: any) {
          console.error(`[STRIPE WEBHOOK] Invoice error for Order ${orderId}:`, e);
        }

        try {
          const orderRowRes = await db.execute(sql`
            SELECT total, subtotal, shipping_cost, discount_amount, shipping_data
            FROM orders WHERE id = ${parseInt(orderId)}
          `);
          const orderRow = orderRowRes.rows[0] as any;
          let customerEmail: string | null = null;
          let customerName = '';
          if (paymentIntent.receipt_email) {
            customerEmail = paymentIntent.receipt_email;
          } else if (paymentIntent.shipping) {
            customerEmail = paymentIntent.shipping.email || null;
          }
          if (!customerEmail && paymentIntent.metadata && paymentIntent.metadata.customer_email) {
            customerEmail = paymentIntent.metadata.customer_email;
          }
          if (!customerEmail && orderRow && orderRow.shipping_data) {
            try {
              const sd = typeof orderRow.shipping_data === 'string' ? JSON.parse(orderRow.shipping_data) : orderRow.shipping_data;
              customerEmail = sd?.email || null;
              customerName = [sd?.firstName, sd?.lastName].filter(Boolean).join(' ');
            } catch {}
          }

          if (customerEmail) {
            const totalEur = ((orderRow?.total || 0) / 100).toFixed(2);
            const invoiceNum = invoiceRecord?.invoice_number || '';
            const subject = `Pedido #${orderId} confirmado · Escapes y Más`;
            const text = `Hola${customerName ? ` ${customerName}` : ''},\n\nTu pedido #${orderId} por ${totalEur}€ ha sido confirmado correctamente. Adjuntamos tu factura en PDF.\n\nEn los próximos días recibirás un email con el código de seguimiento cuando tu pedido salga de nuestro almacén.\n\nGracias por confiar en Escapes y Más.\n\nEl equipo de Escapes y Más.`;
            const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="color:#FF6B00;margin-bottom:8px">¡Pedido confirmado!</h2>
  <p>Hola${customerName ? ` <strong>${customerName}</strong>` : ''},</p>
  <p>Tu pedido <strong>#${orderId}</strong> por <strong style="color:#FF6B00">${totalEur}€</strong> ha sido confirmado correctamente.</p>
  ${invoiceNum ? `<p>Factura: <strong>${invoiceNum}</strong> (adjunta en este email).</p>` : ''}
  <p>En los próximos días recibirás un email con el código de seguimiento cuando tu pedido salga de nuestro almacén.</p>
  <p style="margin-top:24px">Gracias por confiar en nosotros.</p>
  <p style="color:#888;font-size:12px;margin-top:24px">Escapes y Más · <a href="https://escapesymas.com">escapesymas.com</a></p>
</div>`;

            const attachments: any[] = [];
            if (invoiceRecord && invoiceRecord.pdf_path && fs.existsSync(invoiceRecord.pdf_path)) {
              attachments.push({
                filename: `${invoiceRecord.invoice_number}.pdf`,
                path: invoiceRecord.pdf_path,
                contentType: 'application/pdf',
              });
            }

            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST || "smtp.buzondecorreo.com",
              port: parseInt(process.env.SMTP_PORT || "465"),
              secure: true,
              auth: { user: process.env.SMTP_USER || "web@escapesymas.com", pass: process.env.SMTP_PASSWORD },
              tls: { rejectUnauthorized: process.env.SMTP_ALLOW_UNSECURE === 'true' },
            });
            await transporter.sendMail({
              from: '"Escapes y Más" <web@escapesymas.com>',
              to: customerEmail,
              subject,
              text,
              html,
              attachments,
            });
            console.log(`[STRIPE WEBHOOK] Confirmation email sent to ${customerEmail} for Order ${orderId}`);
          } else {
            console.warn(`[STRIPE WEBHOOK] No customer email found for Order ${orderId}; skipping confirmation email`);
          }
        } catch (emailErr: any) {
          console.error(`[STRIPE WEBHOOK] Failed to send confirmation email for Order ${orderId}:`, emailErr.message);
        }

        try {
          const { sendServerSideEvent } = await import('./lib/server-tracking.js');
          const orderForTrack = await db.execute(sql`
            SELECT total, shipping_cost, shipping_data FROM orders WHERE id = ${parseInt(orderId)}
          `);
          const itemsForTrack = await db.execute(sql`
            SELECT oi.product_id, oi.price, oi.quantity, p.sku, p.name, p.brand
            FROM order_items oi
            LEFT JOIN products p ON p.id = oi.product_id
            WHERE oi.order_id = ${parseInt(orderId)}
          `);
          if (orderForTrack.rows.length > 0) {
            const orderRow = orderForTrack.rows[0] as any;
            const totalCents = parseInt(orderRow.total) || 0;
            const eventId =
              (paymentIntent.metadata?.event_id as string) ||
              (paymentIntent.metadata?.eventId as string) ||
              `purchase_${orderId}_${paymentIntent.id}`;
            const customerEmail =
              paymentIntent.receipt_email ||
              paymentIntent.shipping?.email ||
              (paymentIntent.metadata?.customer_email as string) ||
              undefined;
            const items = (itemsForTrack.rows as any[]).map((it) => ({
              id: it.product_id?.toString(),
              sku: it.sku,
              name: it.name,
              brand: it.brand,
              price: parseFloat((parseInt(it.price) / 100).toFixed(2)),
              quantity: parseInt(it.quantity) || 1,
            }));
            const shippingCents = parseInt(orderRow.shipping_cost) || 0;
            const taxCents = Math.floor(totalCents * 0.21);
            await sendServerSideEvent({
              eventName: 'purchase',
              eventId,
              userEmail: customerEmail,
              userAgent: req.headers['user-agent'] as string,
              clientIp: req.ip,
              payload: {
                currency: 'EUR',
                value: totalCents / 100,
                shipping: shippingCents / 100,
                tax: taxCents / 100,
                items,
                content_ids: items.map(i => i.id),
                content_type: 'product',
                num_items: items.length,
                transaction_id: paymentIntent.id,
              },
            });
          }
        } catch (trackErr: any) {
          console.error(`[STRIPE WEBHOOK] Server-side tracking failed for Order ${orderId}:`, trackErr.message);
        }

        console.log(`[STRIPE WEBHOOK] Order ${orderId} finalized via payment_intent.succeeded`);
      } catch (err: any) {
        console.error(`[STRIPE WEBHOOK] Error finalizing order ${orderId}:`, err);
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
    const paymentIntent = event.data.object as any;
    const orderId = paymentIntent.metadata?.orderId;
    if (orderId) {
      await db.execute(sql`
        UPDATE orders SET status = 'cancelled' WHERE id = ${parseInt(orderId)} AND status = 'pending'
      `);
      console.log(`[STRIPE WEBHOOK] Order ${orderId} marked as cancelled (${event.type})`);
    }
  }

  res.json({ received: true });
});

// Daemon de Tracking (cada 15 minutos)
setInterval(() => {
  checkPendingDropshippingOrders().catch(e => console.error('[DROPSHIPPING DAEMON INTERVAL ERROR]:', e));
}, 15 * 60 * 1000);

// Ejecución al iniciar
checkPendingDropshippingOrders().catch(e => console.error('[DROPSHIPPING DAEMON INITIAL RUN ERROR]:', e));

// ================================================================
// CHECKOUT SESSION
// ================================================================
app.get('/api/checkout-session', async (req: any, res: any) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

  try {
    const oRes = await db.execute(sql`SELECT payment_id FROM orders WHERE id = ${parseInt(orderId)}`);
    if (oRes.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    
    const paymentId = oRes.rows[0].payment_id;
    if (!paymentId) return res.status(400).json({ error: 'No payment session for this order' });

    const client = getStripeClient(req);
    const session = await client.checkout.sessions.retrieve(paymentId);
    
    return res.json({ clientSecret: session.client_secret });
  } catch(e: any) {
    console.error('[CHECKOUT SESSION ERROR]', e);
    return res.status(500).json({ error: e.message });
  }
});

// ================================================================
// PRODUCT REVIEWS
// ================================================================
app.get('/api/reviews/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const { limit = '10', offset = '0' } = req.query as any;
    
    const reviewsRes = await db.execute(sql`
      SELECT r.id, r.product_id, r.user_email, r.username, r.rating, r.title, r.content,
             r.verified_purchase, r.created_at
      FROM product_reviews r
      WHERE r.product_id = ${productId}
      ORDER BY r.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
    `);
    
    const countRes = await db.execute(sql`
      SELECT COUNT(*) as total FROM product_reviews 
      WHERE product_id = ${productId}
    `);
    
    const statsRes = await db.execute(sql`
      SELECT 
        AVG(rating)::numeric(2,1) as average,
        COUNT(*) as total,
        COUNT(CASE WHEN rating = 5 THEN 1 END) as five,
        COUNT(CASE WHEN rating = 4 THEN 1 END) as four,
        COUNT(CASE WHEN rating = 3 THEN 1 END) as three,
        COUNT(CASE WHEN rating = 2 THEN 1 END) as two,
        COUNT(CASE WHEN rating = 1 THEN 1 END) as one
      FROM product_reviews 
      WHERE product_id = ${productId}
    `);
    
    const countRow = countRes.rows[0] as { total: string } | undefined;
    
    const stats = statsRes.rows[0] as { average: string; total: string; five: string; four: string; three: string; two: string; one: string } | undefined;
    
    res.json({
      reviews: reviewsRes.rows,
      total: parseInt(countRow?.total || '0'),
      stats: {
        average: parseFloat(stats?.average) || 0,
        total: parseInt(stats?.total || '0'),
        distribution: {
          5: parseInt(stats?.five || '0'),
          4: parseInt(stats?.four || '0'),
          3: parseInt(stats?.three || '0'),
          2: parseInt(stats?.two || '0'),
          1: parseInt(stats?.one || '0')
        }
      }
    });
  } catch (err: any) {
    console.error('[REVIEWS GET ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reviews', async (req, res) => {
  try {
    const { product_id, rating, title, content } = req.body;

    if (!product_id || !rating) {
      return res.status(400).json({ error: 'product_id and rating are required' });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const userId = (req as any).userId || null;
    let verified_purchase = false;
    let userEmail: string | null = null;
    let username: string | null = null;

    if (userId) {
      const userRes = await db.execute(sql`
        SELECT email, username FROM users WHERE id = ${userId} LIMIT 1
      `);
      if (userRes.rows.length > 0) {
        userEmail = (userRes.rows[0] as any).email;
        username = (userRes.rows[0] as any).username;
      }

      const orderRes = await db.execute(sql`
        SELECT o.id FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        WHERE o.user_id = ${userId} AND oi.product_id = ${parseInt(product_id)} AND o.status = 'completed'
        LIMIT 1
      `);
      if (orderRes.rows.length > 0) {
        verified_purchase = true;
      }
    }

    const result = await db.execute(sql`
      INSERT INTO product_reviews (product_id, user_email, username, rating, title, content, verified_purchase)
      VALUES (${parseInt(product_id)}, ${userEmail}, ${username}, ${parseInt(rating)}, ${title || null}, ${content || null}, ${verified_purchase})
      RETURNING *
    `);

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    console.error('[REVIEWS POST ERROR]:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// CHATBOT IA (MiniMax) — Solo usuarios autenticados
// ================================================================
app.get('/api/chat/health', chatHealthHandler);

app.post('/api/chat/message', chatLimiter, chatHandler);

// ================================================================
// ARRANQUE
// ================================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  🏍️  ESCAPES Y MÁS — Backend API v1.0              ║
║  📡  Puerto: ${PORT}                                    ║
║  🗄️  DB: PostgreSQL (localhost)                      ║
║  🌐  WordPress proxy: ${WP_URL}        ║
╚══════════════════════════════════════════════════════╝
  `);
});

export default app;
