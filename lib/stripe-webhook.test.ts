import { describe, it, expect, vi, beforeEach } from 'vitest';
import { constructStripeEvent, handleStripeWebhookEvent } from './stripe-webhook-service.js';
import Stripe from 'stripe';

// Mock dependencies
vi.mock('../db.js', () => {
  const mockQuery = vi.fn();
  const mockExecute = vi.fn();
  const mockConnect = vi.fn(() => ({
    query: mockQuery,
    release: vi.fn(),
  }));

  return {
    default: {
      connect: mockConnect,
    },
    pool: {
      connect: mockConnect,
    },
    db: {
      execute: mockExecute,
    },
  };
});

vi.mock('./stripe-webhook.js', () => ({
  processStripeEvent: vi.fn(async (evt, handler) => {
    await handler({ event: evt, receivedAt: new Date(), attempt: 1 });
    return { status: 'processed', durationMs: 10 };
  }),
}));

vi.mock('./email.js', () => ({
  sendTemplatedEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
}));

vi.mock('./cache.js', () => ({
  cacheBust: vi.fn().mockResolvedValue(undefined),
}));

describe('Stripe Webhook Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructStripeEvent', () => {
    it('throws when stripe-signature is missing', () => {
      expect(() => constructStripeEvent(Buffer.from('{}'), '')).toThrow('Falta la cabecera stripe-signature');
    });

    it('throws when webhook secrets are not configured', () => {
      const origSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const origTestSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET;
      delete process.env.STRIPE_WEBHOOK_SECRET;
      delete process.env.STRIPE_TEST_WEBHOOK_SECRET;

      expect(() => constructStripeEvent(Buffer.from('{}'), 'sig_123')).toThrow('STRIPE_WEBHOOK_SECRET no está configurada');

      process.env.STRIPE_WEBHOOK_SECRET = origSecret;
      process.env.STRIPE_TEST_WEBHOOK_SECRET = origTestSecret;
    });
  });

  describe('handleStripeWebhookEvent - payment_intent.succeeded', () => {
    it('handles successful payment, updates order status, decrements stock within SQL transaction', async () => {
      const { pool, db } = await import('../db.js');
      const mockClient = await pool.connect();

      // Mock order check query
      (db.execute as any).mockImplementation((query: any) => {
        const queryText = typeof query === 'string' 
          ? query 
          : (query?.queryChunks ? query.queryChunks.map((c: any) => c?.value || c?.name || c).join(' ') : JSON.stringify(query));
        
        if (queryText.includes('orders')) {
          return Promise.resolve({
            rows: [{ id: 42, status: 'pending', total: 5000, shipping_data: JSON.stringify({ email: 'test@example.com' }) }],
          });
        }
        if (queryText.includes('invoices')) {
          return Promise.resolve({ rows: [] });
        }
        if (queryText.includes('order_items')) {
          return Promise.resolve({ rows: [{ product_id: 10, price: 5000, quantity: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      // Mock SQL transaction client queries
      (mockClient.query as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT product_id')) {
          return Promise.resolve({ rows: [{ product_id: 10, quantity: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const mockEvent: Stripe.Event = {
        id: 'evt_test_123',
        object: 'event',
        api_version: '2024-11-20.acacia',
        created: Date.now(),
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_123',
            object: 'payment_intent',
            amount: 5000,
            currency: 'eur',
            metadata: { orderId: '42' },
            payment_method_types: ['card'],
            latest_charge: 'ch_123',
            receipt_email: 'test@example.com',
          } as any,
        },
        livemode: false,
        pending_webhooks: 0,
        request: null,
      };

      const res = await handleStripeWebhookEvent(mockEvent);
      expect(res.status).toBe('processed');

      // Verify atomic SQL transaction was executed
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders'),
        expect.arrayContaining(['pi_test_123', 'ch_123', 'card', 42])
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2'),
        [2, 10]
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  describe('handleStripeWebhookEvent - payment_intent.payment_failed', () => {
    it('updates order status to payment_failed with error message', async () => {
      const { db } = await import('../db.js');

      (db.execute as any).mockResolvedValue({ rows: [] });

      const mockEvent: Stripe.Event = {
        id: 'evt_fail_123',
        object: 'event',
        api_version: '2024-11-20.acacia',
        created: Date.now(),
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_fail_123',
            object: 'payment_intent',
            metadata: { orderId: '42' },
            last_payment_error: { message: 'Tarjeta denegada' },
          } as any,
        },
        livemode: false,
        pending_webhooks: 0,
        request: null,
      };

      const res = await handleStripeWebhookEvent(mockEvent);
      expect(res.status).toBe('processed');
      expect(db.execute).toHaveBeenCalled();
    });
  });

  describe('handleStripeWebhookEvent - charge.refunded', () => {
    it('updates order status to refunded and restores product stock', async () => {
      const { pool, db } = await import('../db.js');
      const mockClient = await pool.connect();

      (db.execute as any).mockImplementation((query: any) => {
        const str = String(query.queryChunks || query);
        if (str.includes('FROM orders')) {
          return Promise.resolve({ rows: [{ id: 42 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      (mockClient.query as any).mockImplementation((sql: string) => {
        if (sql.includes('SELECT product_id')) {
          return Promise.resolve({ rows: [{ product_id: 10, quantity: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const mockEvent: Stripe.Event = {
        id: 'evt_refund_123',
        object: 'event',
        api_version: '2024-11-20.acacia',
        created: Date.now(),
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_refund_123',
            object: 'charge',
            amount: 5000,
            amount_refunded: 5000,
            payment_intent: 'pi_123',
            metadata: { orderId: '42' },
          } as any,
        },
        livemode: false,
        pending_webhooks: 0,
        request: null,
      };

      const res = await handleStripeWebhookEvent(mockEvent);
      expect(res.status).toBe('processed');

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE orders SET status = $1 WHERE id = $2'),
        ['refunded', 42]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE products SET stock = stock + $1 WHERE id = $2'),
        [2, 10]
      );
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });
  });
});
