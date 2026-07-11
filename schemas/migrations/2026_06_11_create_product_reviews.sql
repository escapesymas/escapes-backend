-- Migration: Create product_reviews table
-- Date: 2026-06-11
-- Author: opencode
-- Description: Table for product reviews with ratings, verified purchase tracking,
--              and status workflow (pending/approved/rejected)
-- Dependencies: products(id), users(id), orders(id)

BEGIN;

CREATE TABLE IF NOT EXISTS product_reviews (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title           VARCHAR(255),
    content         TEXT,
    verified_purchase BOOLEAN NOT NULL DEFAULT false,
    status          VARCHAR(20) NOT NULL DEFAULT 'approved'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Primary query: SELECT reviews by product_id with status filter and ordering
CREATE INDEX idx_reviews_product_status_created
    ON product_reviews(product_id, status, created_at DESC);

-- Secondary: lookup by user_id (for verified purchase queries)
CREATE INDEX idx_reviews_user_id
    ON product_reviews(user_id);

-- Tertiary: status filter for admin queries (pending reviews)
CREATE INDEX idx_reviews_status
    ON product_reviews(status);

-- Trigger to auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_product_reviews_updated_at
    BEFORE UPDATE ON product_reviews
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE product_reviews IS 'Product reviews with ratings, verified purchase flag, and moderation status';
COMMENT ON COLUMN product_reviews.verified_purchase IS 'True if user purchased this product in a completed order';
COMMENT ON COLUMN product_reviews.status IS 'Review moderation: pending (awaiting approval), approved (visible), rejected (hidden)';

COMMIT;