-- Esquema base de producción (solo estructura, sin datos), extraído el 2026-10-02.
-- Permite levantar una BD vacía para tests y entornos locales:
--   psql "$DATABASE_URL" -f migrations/000_baseline_schema.sql
-- Las migraciones posteriores (003+) y el arranque del backend son idempotentes.

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_push_tokens (
    id integer NOT NULL,
    token character varying(255) NOT NULL,
    device_name character varying(100),
    platform character varying(50) DEFAULT 'ios'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: admin_push_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_push_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_push_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_push_tokens_id_seq OWNED BY public.admin_push_tokens.id;


--
-- Name: cart_abandoned_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cart_abandoned_emails (
    id integer NOT NULL,
    user_email character varying(255) NOT NULL,
    cart_snapshot jsonb NOT NULL,
    cart_total_cents integer NOT NULL,
    first_added_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    emails_sent integer DEFAULT 0 NOT NULL,
    last_emailed_at timestamp with time zone,
    recovered_at timestamp with time zone,
    recovery_token uuid DEFAULT gen_random_uuid() NOT NULL,
    discount_cents integer DEFAULT 0 NOT NULL
);


--
-- Name: cart_abandoned_emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cart_abandoned_emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cart_abandoned_emails_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cart_abandoned_emails_id_seq OWNED BY public.cart_abandoned_emails.id;


--
-- Name: carts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.carts (
    id integer NOT NULL,
    user_id integer,
    session_token character varying(255) NOT NULL,
    items text NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    is_deleted integer DEFAULT 0
);


--
-- Name: carts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.carts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: carts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.carts_id_seq OWNED BY public.carts.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    parent_id integer,
    bihr_cat1 character varying(100),
    bihr_cat2 character varying(100),
    bihr_cat3 character varying(100),
    description text,
    image character varying(500),
    sort_order integer DEFAULT 0,
    status character varying(20) DEFAULT 'active'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupons (
    id integer NOT NULL,
    code character varying(50) NOT NULL,
    type character varying(20) NOT NULL,
    value integer NOT NULL,
    active integer DEFAULT 1,
    expires_at timestamp without time zone,
    max_uses integer DEFAULT 999999,
    times_used integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: coupons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupons_id_seq OWNED BY public.coupons.id;


--
-- Name: email_open_tracking; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_open_tracking (
    message_id text NOT NULL,
    recipient text NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_at timestamp with time zone,
    open_count integer DEFAULT 0 NOT NULL
);


--
-- Name: email_send_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_send_queue (
    id integer NOT NULL,
    event_id text NOT NULL,
    template text,
    to_addr text NOT NULL,
    subject text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_retry_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_send_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_send_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_send_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_send_queue_id_seq OWNED BY public.email_send_queue.id;


--
-- Name: forum_likes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forum_likes (
    id integer NOT NULL,
    user_id integer NOT NULL,
    content_type character varying(20) NOT NULL,
    content_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: forum_likes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.forum_likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forum_likes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.forum_likes_id_seq OWNED BY public.forum_likes.id;


--
-- Name: forum_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forum_posts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    category character varying(50) DEFAULT 'general'::character varying,
    likes integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    view_count integer DEFAULT 0,
    updated_at timestamp without time zone DEFAULT now(),
    is_pinned integer DEFAULT 0,
    is_closed integer DEFAULT 0
);


--
-- Name: forum_posts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.forum_posts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forum_posts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.forum_posts_id_seq OWNED BY public.forum_posts.id;


--
-- Name: forum_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forum_replies (
    id integer NOT NULL,
    post_id integer NOT NULL,
    user_id integer NOT NULL,
    content text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: forum_replies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.forum_replies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forum_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.forum_replies_id_seq OWNED BY public.forum_replies.id;


--
-- Name: garage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.garage (
    id integer NOT NULL,
    user_id integer NOT NULL,
    brand character varying(100) NOT NULL,
    model character varying(100) NOT NULL,
    year character varying(20) NOT NULL,
    is_primary integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: garage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.garage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: garage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.garage_id_seq OWNED BY public.garage.id;


--
-- Name: global_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.global_settings (
    key character varying(100) NOT NULL,
    value text
);


--
-- Name: image_regen_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_regen_state (
    id integer NOT NULL,
    status character varying(50) DEFAULT 'idle'::character varying,
    processed integer DEFAULT 0,
    success integer DEFAULT 0,
    failed integer DEFAULT 0,
    skipped integer DEFAULT 0,
    total integer DEFAULT 0,
    current_sku character varying(255) DEFAULT ''::character varying,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: image_regen_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_regen_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_regen_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_regen_state_id_seq OWNED BY public.image_regen_state.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    order_id integer NOT NULL,
    invoice_number character varying(50) NOT NULL,
    subtotal integer DEFAULT 0,
    tax_amount integer DEFAULT 0,
    shipping_cost integer DEFAULT 0,
    discount_amount integer DEFAULT 0,
    total integer NOT NULL,
    pdf_path text,
    issued_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id integer NOT NULL,
    order_id integer,
    product_id integer,
    quantity integer NOT NULL,
    price integer NOT NULL
);


--
-- Name: order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;


--
-- Name: order_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_notes (
    id integer NOT NULL,
    order_id integer NOT NULL,
    note text NOT NULL,
    is_customer_note boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    created_by character varying(255)
);


--
-- Name: order_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_notes_id_seq OWNED BY public.order_notes.id;


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    user_id integer,
    total integer NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    payment_id character varying(255),
    shipping_data text,
    created_at timestamp without time zone DEFAULT now(),
    subtotal integer DEFAULT 0,
    discount_amount integer DEFAULT 0,
    shipping_cost integer DEFAULT 0,
    promo_code character varying(50),
    bihr_ticket_id character varying(255),
    dropshipping_status character varying(50) DEFAULT 'not_sent'::character varying,
    tracking_number character varying(255),
    tracking_url character varying(500),
    cost_total integer DEFAULT 0,
    refunded_amount integer DEFAULT 0,
    stripe_charge_id character varying(100),
    shipping_label_url text,
    carrier character varying(50),
    paid_at timestamp without time zone,
    payment_method character varying(50),
    last_payment_error text
);


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;


--
-- Name: pricing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_rules (
    id integer NOT NULL,
    rule_type character varying(50) NOT NULL,
    target_id character varying(100),
    margin_percent integer NOT NULL,
    active integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: pricing_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pricing_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pricing_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pricing_rules_id_seq OWNED BY public.pricing_rules.id;


--
-- Name: processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.processed_events (
    id bigint NOT NULL,
    event_id character varying(64) NOT NULL,
    platform character varying(16) NOT NULL,
    event_name character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT processed_events_platform_check CHECK (((platform)::text = ANY (ARRAY[('meta'::character varying)::text, ('ga4'::character varying)::text])))
);


--
-- Name: processed_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.processed_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: processed_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.processed_events_id_seq OWNED BY public.processed_events.id;


--
-- Name: product_attribute_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_attribute_terms (
    id integer NOT NULL,
    attribute_id integer,
    name character varying(100) NOT NULL
);


--
-- Name: product_attribute_terms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_attribute_terms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_attribute_terms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_attribute_terms_id_seq OWNED BY public.product_attribute_terms.id;


--
-- Name: product_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_attributes (
    id integer NOT NULL,
    name character varying(100) NOT NULL
);


--
-- Name: product_attributes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_attributes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_attributes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_attributes_id_seq OWNED BY public.product_attributes.id;


--
-- Name: product_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_links (
    id integer NOT NULL,
    product_id integer NOT NULL,
    linked_product_id integer NOT NULL,
    link_type character varying(20) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: product_links_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_links_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_links_id_seq OWNED BY public.product_links.id;


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id integer NOT NULL,
    product_id integer NOT NULL,
    user_email character varying(255),
    username character varying(100),
    rating integer NOT NULL,
    title character varying(200),
    content text,
    verified_purchase boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: product_rating_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.product_rating_stats AS
 SELECT product_id,
    count(*) AS review_count,
    round(avg(rating), 1) AS avg_rating,
    count(*) FILTER (WHERE (rating = 5)) AS five_star,
    count(*) FILTER (WHERE (rating = 4)) AS four_star,
    count(*) FILTER (WHERE (rating = 3)) AS three_star,
    count(*) FILTER (WHERE (rating = 2)) AS two_star,
    count(*) FILTER (WHERE (rating = 1)) AS one_star
   FROM public.reviews
  GROUP BY product_id;


--
-- Name: product_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_reviews (
    id integer NOT NULL,
    product_id integer NOT NULL,
    user_id integer,
    order_id integer,
    rating integer NOT NULL,
    title character varying(255),
    content text,
    verified_purchase boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'approved'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT product_reviews_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('approved'::character varying)::text, ('rejected'::character varying)::text])))
);


--
-- Name: product_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_reviews_id_seq OWNED BY public.product_reviews.id;


--
-- Name: product_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_tags (
    product_id integer NOT NULL,
    tag_id integer NOT NULL
);


--
-- Name: product_variation_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variation_attributes (
    id integer NOT NULL,
    variation_id integer,
    attribute_id integer,
    term_id integer
);


--
-- Name: product_variation_attributes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_variation_attributes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_variation_attributes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_variation_attributes_id_seq OWNED BY public.product_variation_attributes.id;


--
-- Name: product_variations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_variations (
    id integer NOT NULL,
    parent_product_id integer NOT NULL,
    sku character varying(255),
    price integer NOT NULL,
    stock_status character varying(50) DEFAULT 'instock'::character varying,
    stock_quantity integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: product_variations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_variations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_variations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_variations_id_seq OWNED BY public.product_variations.id;


--
-- Name: product_vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_vehicles (
    id integer NOT NULL,
    product_id integer,
    model_id integer,
    start_year integer,
    end_year integer
);


--
-- Name: product_vehicles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_vehicles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_vehicles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_vehicles_id_seq OWNED BY public.product_vehicles.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id integer NOT NULL,
    provider_id character varying(100),
    sku character varying(100),
    name character varying(255) NOT NULL,
    description text,
    price integer NOT NULL,
    sale_price integer,
    stock integer DEFAULT 0,
    compatibility jsonb,
    category_id integer,
    status character varying(20) DEFAULT 'draft'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    attributes jsonb DEFAULT '{}'::jsonb,
    cost integer DEFAULT 0,
    brand character varying(255),
    barcode character varying(100),
    weight_g integer,
    length_mm integer,
    width_mm integer,
    height_mm integer,
    volume_cm3 integer,
    dropshipping boolean DEFAULT false,
    ondemand boolean DEFAULT false,
    delivery_plant character varying(255),
    commodity_code character varying(20),
    supplier_code character varying(100),
    old_part_number character varying(100),
    category2 character varying(100),
    category3 character varying(100),
    category2_id integer,
    category3_id integer,
    type character varying(50) DEFAULT 'simple'::character varying,
    stock_status character varying(20) DEFAULT 'in_stock'::character varying,
    low_stock_threshold integer DEFAULT 5,
    images jsonb DEFAULT '[]'::jsonb
);


--
-- Name: products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id integer NOT NULL,
    user_id integer,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    preferences jsonb DEFAULT '{"new_user": true, "new_order": true, "daily_summary": true, "abandoned_cart": true, "payment_failed": true, "dropshipping_status": true}'::jsonb
);


--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.push_subscriptions_id_seq OWNED BY public.push_subscriptions.id;


--
-- Name: reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reviews_id_seq OWNED BY public.reviews.id;


--
-- Name: seo_autolinks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_autolinks (
    id integer NOT NULL,
    keyword character varying(255) NOT NULL,
    url character varying(500) NOT NULL,
    active integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: seo_autolinks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.seo_autolinks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seo_autolinks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.seo_autolinks_id_seq OWNED BY public.seo_autolinks.id;


--
-- Name: shipping_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_methods (
    id integer NOT NULL,
    zone_id integer,
    name character varying(100) NOT NULL,
    cost integer DEFAULT 0 NOT NULL,
    active integer DEFAULT 1,
    free_shipping_threshold integer
);


--
-- Name: shipping_methods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shipping_methods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shipping_methods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shipping_methods_id_seq OWNED BY public.shipping_methods.id;


--
-- Name: shipping_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shipping_zones (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    regions jsonb
);


--
-- Name: shipping_zones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shipping_zones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shipping_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shipping_zones_id_seq OWNED BY public.shipping_zones.id;


--
-- Name: stock_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_notifications (
    id integer NOT NULL,
    product_id integer NOT NULL,
    email character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    notified boolean DEFAULT false
);


--
-- Name: stock_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stock_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stock_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stock_notifications_id_seq OWNED BY public.stock_notifications.id;


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    last_error text
);


--
-- Name: stripe_webhook_retry_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_retry_queue (
    id integer NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_retry_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stripe_webhook_retry_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stripe_webhook_retry_queue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stripe_webhook_retry_queue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stripe_webhook_retry_queue_id_seq OWNED BY public.stripe_webhook_retry_queue.id;


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: tax_classes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_classes (
    id integer NOT NULL,
    name character varying(100) NOT NULL
);


--
-- Name: tax_classes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tax_classes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tax_classes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tax_classes_id_seq OWNED BY public.tax_classes.id;


--
-- Name: tax_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_rates (
    id integer NOT NULL,
    class_id integer,
    country character varying(10) NOT NULL,
    state character varying(50),
    rate numeric(5,2) NOT NULL
);


--
-- Name: tax_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tax_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tax_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tax_rates_id_seq OWNED BY public.tax_rates.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    wp_id integer,
    username character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(255),
    last_name character varying(255),
    avatar_url text,
    rank_level integer DEFAULT 1,
    rank_xp integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    role character varying(20) DEFAULT 'customer'::character varying,
    password_hash character varying(255),
    billing text,
    garage text,
    cart text
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vehicle_brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_brands (
    id integer NOT NULL,
    name character varying(255) NOT NULL
);


--
-- Name: vehicle_brands_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_brands_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_brands_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_brands_id_seq OWNED BY public.vehicle_brands.id;


--
-- Name: vehicle_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_models (
    id integer NOT NULL,
    brand_id integer,
    name character varying(255) NOT NULL
);


--
-- Name: vehicle_models_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_models_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_models_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_models_id_seq OWNED BY public.vehicle_models.id;


--
-- Name: admin_push_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_push_tokens ALTER COLUMN id SET DEFAULT nextval('public.admin_push_tokens_id_seq'::regclass);


--
-- Name: cart_abandoned_emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_abandoned_emails ALTER COLUMN id SET DEFAULT nextval('public.cart_abandoned_emails_id_seq'::regclass);


--
-- Name: carts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts ALTER COLUMN id SET DEFAULT nextval('public.carts_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: coupons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons ALTER COLUMN id SET DEFAULT nextval('public.coupons_id_seq'::regclass);


--
-- Name: email_send_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_send_queue ALTER COLUMN id SET DEFAULT nextval('public.email_send_queue_id_seq'::regclass);


--
-- Name: forum_likes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_likes ALTER COLUMN id SET DEFAULT nextval('public.forum_likes_id_seq'::regclass);


--
-- Name: forum_posts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_posts ALTER COLUMN id SET DEFAULT nextval('public.forum_posts_id_seq'::regclass);


--
-- Name: forum_replies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_replies ALTER COLUMN id SET DEFAULT nextval('public.forum_replies_id_seq'::regclass);


--
-- Name: garage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.garage ALTER COLUMN id SET DEFAULT nextval('public.garage_id_seq'::regclass);


--
-- Name: image_regen_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_regen_state ALTER COLUMN id SET DEFAULT nextval('public.image_regen_state_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: order_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items ALTER COLUMN id SET DEFAULT nextval('public.order_items_id_seq'::regclass);


--
-- Name: order_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes ALTER COLUMN id SET DEFAULT nextval('public.order_notes_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);


--
-- Name: pricing_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules ALTER COLUMN id SET DEFAULT nextval('public.pricing_rules_id_seq'::regclass);


--
-- Name: processed_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_events ALTER COLUMN id SET DEFAULT nextval('public.processed_events_id_seq'::regclass);


--
-- Name: product_attribute_terms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_terms ALTER COLUMN id SET DEFAULT nextval('public.product_attribute_terms_id_seq'::regclass);


--
-- Name: product_attributes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attributes ALTER COLUMN id SET DEFAULT nextval('public.product_attributes_id_seq'::regclass);


--
-- Name: product_links id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_links ALTER COLUMN id SET DEFAULT nextval('public.product_links_id_seq'::regclass);


--
-- Name: product_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews ALTER COLUMN id SET DEFAULT nextval('public.product_reviews_id_seq'::regclass);


--
-- Name: product_variation_attributes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes ALTER COLUMN id SET DEFAULT nextval('public.product_variation_attributes_id_seq'::regclass);


--
-- Name: product_variations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variations ALTER COLUMN id SET DEFAULT nextval('public.product_variations_id_seq'::regclass);


--
-- Name: product_vehicles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_vehicles ALTER COLUMN id SET DEFAULT nextval('public.product_vehicles_id_seq'::regclass);


--
-- Name: products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);


--
-- Name: push_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.push_subscriptions_id_seq'::regclass);


--
-- Name: reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews ALTER COLUMN id SET DEFAULT nextval('public.reviews_id_seq'::regclass);


--
-- Name: seo_autolinks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_autolinks ALTER COLUMN id SET DEFAULT nextval('public.seo_autolinks_id_seq'::regclass);


--
-- Name: shipping_methods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_methods ALTER COLUMN id SET DEFAULT nextval('public.shipping_methods_id_seq'::regclass);


--
-- Name: shipping_zones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_zones ALTER COLUMN id SET DEFAULT nextval('public.shipping_zones_id_seq'::regclass);


--
-- Name: stock_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_notifications ALTER COLUMN id SET DEFAULT nextval('public.stock_notifications_id_seq'::regclass);


--
-- Name: stripe_webhook_retry_queue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_retry_queue ALTER COLUMN id SET DEFAULT nextval('public.stripe_webhook_retry_queue_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: tax_classes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_classes ALTER COLUMN id SET DEFAULT nextval('public.tax_classes_id_seq'::regclass);


--
-- Name: tax_rates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates ALTER COLUMN id SET DEFAULT nextval('public.tax_rates_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: vehicle_brands id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_brands ALTER COLUMN id SET DEFAULT nextval('public.vehicle_brands_id_seq'::regclass);


--
-- Name: vehicle_models id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_models ALTER COLUMN id SET DEFAULT nextval('public.vehicle_models_id_seq'::regclass);


--
-- Name: admin_push_tokens admin_push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_push_tokens
    ADD CONSTRAINT admin_push_tokens_pkey PRIMARY KEY (id);


--
-- Name: admin_push_tokens admin_push_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_push_tokens
    ADD CONSTRAINT admin_push_tokens_token_key UNIQUE (token);


--
-- Name: cart_abandoned_emails cart_abandoned_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_abandoned_emails
    ADD CONSTRAINT cart_abandoned_emails_pkey PRIMARY KEY (id);


--
-- Name: cart_abandoned_emails cart_abandoned_emails_recovery_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cart_abandoned_emails
    ADD CONSTRAINT cart_abandoned_emails_recovery_token_key UNIQUE (recovery_token);


--
-- Name: carts carts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_pkey PRIMARY KEY (id);


--
-- Name: carts carts_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.carts
    ADD CONSTRAINT carts_session_token_key UNIQUE (session_token);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: coupons coupons_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_code_key UNIQUE (code);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: email_open_tracking email_open_tracking_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_open_tracking
    ADD CONSTRAINT email_open_tracking_pkey PRIMARY KEY (message_id);


--
-- Name: email_send_queue email_send_queue_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_send_queue
    ADD CONSTRAINT email_send_queue_event_id_key UNIQUE (event_id);


--
-- Name: email_send_queue email_send_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_send_queue
    ADD CONSTRAINT email_send_queue_pkey PRIMARY KEY (id);


--
-- Name: forum_likes forum_likes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_likes
    ADD CONSTRAINT forum_likes_pkey PRIMARY KEY (id);


--
-- Name: forum_posts forum_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_posts
    ADD CONSTRAINT forum_posts_pkey PRIMARY KEY (id);


--
-- Name: forum_replies forum_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_replies
    ADD CONSTRAINT forum_replies_pkey PRIMARY KEY (id);


--
-- Name: garage garage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.garage
    ADD CONSTRAINT garage_pkey PRIMARY KEY (id);


--
-- Name: global_settings global_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.global_settings
    ADD CONSTRAINT global_settings_pkey PRIMARY KEY (key);


--
-- Name: image_regen_state image_regen_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_regen_state
    ADD CONSTRAINT image_regen_state_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_order_id_key UNIQUE (order_id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: order_notes order_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes
    ADD CONSTRAINT order_notes_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: pricing_rules pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: processed_events processed_events_event_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_events
    ADD CONSTRAINT processed_events_event_id_platform_key UNIQUE (event_id, platform);


--
-- Name: processed_events processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (id);


--
-- Name: product_attribute_terms product_attribute_terms_attribute_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_terms
    ADD CONSTRAINT product_attribute_terms_attribute_id_name_key UNIQUE (attribute_id, name);


--
-- Name: product_attribute_terms product_attribute_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_terms
    ADD CONSTRAINT product_attribute_terms_pkey PRIMARY KEY (id);


--
-- Name: product_attributes product_attributes_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attributes
    ADD CONSTRAINT product_attributes_name_key UNIQUE (name);


--
-- Name: product_attributes product_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attributes
    ADD CONSTRAINT product_attributes_pkey PRIMARY KEY (id);


--
-- Name: product_links product_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_links
    ADD CONSTRAINT product_links_pkey PRIMARY KEY (id);


--
-- Name: product_links product_links_product_id_linked_product_id_link_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_links
    ADD CONSTRAINT product_links_product_id_linked_product_id_link_type_key UNIQUE (product_id, linked_product_id, link_type);


--
-- Name: product_reviews product_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_pkey PRIMARY KEY (id);


--
-- Name: product_tags product_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_tags
    ADD CONSTRAINT product_tags_pkey PRIMARY KEY (product_id, tag_id);


--
-- Name: product_variation_attributes product_variation_attributes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes
    ADD CONSTRAINT product_variation_attributes_pkey PRIMARY KEY (id);


--
-- Name: product_variation_attributes product_variation_attributes_variation_id_attribute_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes
    ADD CONSTRAINT product_variation_attributes_variation_id_attribute_id_key UNIQUE (variation_id, attribute_id);


--
-- Name: product_variations product_variations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variations
    ADD CONSTRAINT product_variations_pkey PRIMARY KEY (id);


--
-- Name: product_variations product_variations_sku_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variations
    ADD CONSTRAINT product_variations_sku_key UNIQUE (sku);


--
-- Name: product_vehicles product_vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_vehicles
    ADD CONSTRAINT product_vehicles_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: products products_sku_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_sku_unique UNIQUE (sku);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: seo_autolinks seo_autolinks_keyword_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_autolinks
    ADD CONSTRAINT seo_autolinks_keyword_key UNIQUE (keyword);


--
-- Name: seo_autolinks seo_autolinks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_autolinks
    ADD CONSTRAINT seo_autolinks_pkey PRIMARY KEY (id);


--
-- Name: shipping_methods shipping_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_methods
    ADD CONSTRAINT shipping_methods_pkey PRIMARY KEY (id);


--
-- Name: shipping_zones shipping_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_zones
    ADD CONSTRAINT shipping_zones_pkey PRIMARY KEY (id);


--
-- Name: stock_notifications stock_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_notifications
    ADD CONSTRAINT stock_notifications_pkey PRIMARY KEY (id);


--
-- Name: stock_notifications stock_notifications_product_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_notifications
    ADD CONSTRAINT stock_notifications_product_id_email_key UNIQUE (product_id, email);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: stripe_webhook_retry_queue stripe_webhook_retry_queue_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_retry_queue
    ADD CONSTRAINT stripe_webhook_retry_queue_event_id_key UNIQUE (event_id);


--
-- Name: stripe_webhook_retry_queue stripe_webhook_retry_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_retry_queue
    ADD CONSTRAINT stripe_webhook_retry_queue_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_slug_key UNIQUE (slug);


--
-- Name: tax_classes tax_classes_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_classes
    ADD CONSTRAINT tax_classes_name_key UNIQUE (name);


--
-- Name: tax_classes tax_classes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_classes
    ADD CONSTRAINT tax_classes_pkey PRIMARY KEY (id);


--
-- Name: tax_rates tax_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: users users_wp_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_wp_id_unique UNIQUE (wp_id);


--
-- Name: vehicle_brands vehicle_brands_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_brands
    ADD CONSTRAINT vehicle_brands_name_key UNIQUE (name);


--
-- Name: vehicle_brands vehicle_brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_brands
    ADD CONSTRAINT vehicle_brands_pkey PRIMARY KEY (id);


--
-- Name: vehicle_models vehicle_models_brand_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_models
    ADD CONSTRAINT vehicle_models_brand_id_name_key UNIQUE (brand_id, name);


--
-- Name: vehicle_models vehicle_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_models
    ADD CONSTRAINT vehicle_models_pkey PRIMARY KEY (id);


--
-- Name: idx_cart_abandoned_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_abandoned_active ON public.cart_abandoned_emails USING btree (last_activity_at) WHERE (recovered_at IS NULL);


--
-- Name: idx_cart_abandoned_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_abandoned_email ON public.cart_abandoned_emails USING btree (user_email);


--
-- Name: idx_cart_abandoned_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cart_abandoned_token ON public.cart_abandoned_emails USING btree (recovery_token);


--
-- Name: idx_carts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_carts_user_id ON public.carts USING btree (user_id);


--
-- Name: idx_categories_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_parent_id ON public.categories USING btree (parent_id);


--
-- Name: idx_categories_parent_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_parent_id_id ON public.categories USING btree (parent_id, id);


--
-- Name: idx_email_open_tracking_opened_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_open_tracking_opened_at ON public.email_open_tracking USING btree (opened_at) WHERE (opened_at IS NOT NULL);


--
-- Name: idx_email_send_queue_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_send_queue_due ON public.email_send_queue USING btree (next_retry_at) WHERE (attempts < 10);


--
-- Name: idx_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);


--
-- Name: idx_order_items_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_product_id ON public.order_items USING btree (product_id);


--
-- Name: idx_orders_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_created_at ON public.orders USING btree (created_at DESC);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_orders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_user_id ON public.orders USING btree (user_id);


--
-- Name: idx_processed_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processed_events_created_at ON public.processed_events USING btree (created_at);


--
-- Name: idx_processed_events_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processed_events_event_id ON public.processed_events USING btree (event_id);


--
-- Name: idx_processed_events_platform_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_processed_events_platform_event ON public.processed_events USING btree (platform, event_name);


--
-- Name: idx_products_attributes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_attributes ON public.products USING gin (attributes);


--
-- Name: idx_products_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_brand ON public.products USING btree (brand);


--
-- Name: idx_products_category2_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category2_id ON public.products USING btree (category2_id);


--
-- Name: idx_products_category3_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category3_id ON public.products USING btree (category3_id);


--
-- Name: idx_products_category_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_category_id ON public.products USING btree (category_id);


--
-- Name: idx_products_compatibility_gin_native; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_compatibility_gin_native ON public.products USING gin (compatibility);


--
-- Name: idx_products_delivery_plant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_delivery_plant ON public.products USING btree (delivery_plant);


--
-- Name: idx_products_dropshipping; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_dropshipping ON public.products USING btree (dropshipping);


--
-- Name: idx_products_universal_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_universal_brand ON public.products USING btree (brand, id) WHERE (((compatibility IS NULL) OR (compatibility = '[]'::jsonb) OR ((compatibility)::text = '[]'::text)) AND (brand IS NOT NULL));


--
-- Name: idx_products_universal_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_universal_category ON public.products USING btree (category_id, id) WHERE ((compatibility IS NULL) OR (compatibility = '[]'::jsonb) OR ((compatibility)::text = '[]'::text));


--
-- Name: idx_products_universal_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_universal_id ON public.products USING btree (id) WHERE ((compatibility IS NULL) OR (compatibility = '[]'::jsonb) OR ((compatibility)::text = '[]'::text));


--
-- Name: idx_products_universal_instock; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_universal_instock ON public.products USING btree (stock, id) WHERE (((compatibility IS NULL) OR (compatibility = '[]'::jsonb) OR ((compatibility)::text = '[]'::text)) AND (stock > 0));


--
-- Name: idx_products_universal_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_universal_search ON public.products USING gin (to_tsvector('spanish'::regconfig, (((COALESCE(name, ''::character varying))::text || ' '::text) || COALESCE(description, ''::text)))) WHERE ((compatibility IS NULL) OR (compatibility = '[]'::jsonb) OR ((compatibility)::text = '[]'::text));


--
-- Name: idx_products_weight; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_weight ON public.products USING btree (weight_g);


--
-- Name: idx_reviews_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_created_at ON public.reviews USING btree (created_at DESC);


--
-- Name: idx_reviews_product_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_product_id ON public.reviews USING btree (product_id);


--
-- Name: idx_reviews_product_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_product_rating ON public.reviews USING btree (product_id, rating);


--
-- Name: idx_reviews_product_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_product_status_created ON public.product_reviews USING btree (product_id, status, created_at DESC);


--
-- Name: idx_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_status ON public.product_reviews USING btree (status);


--
-- Name: idx_reviews_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reviews_user_id ON public.product_reviews USING btree (user_id);


--
-- Name: idx_stripe_webhook_events_processed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_events_processed_at ON public.stripe_webhook_events USING btree (processed_at) WHERE (processed_at IS NULL);


--
-- Name: idx_stripe_webhook_retry_queue_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_retry_queue_due ON public.stripe_webhook_retry_queue USING btree (next_retry_at);


--
-- Name: product_reviews update_product_reviews_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_product_reviews_updated_at BEFORE UPDATE ON public.product_reviews FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: categories categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id);


--
-- Name: forum_likes forum_likes_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_likes
    ADD CONSTRAINT forum_likes_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: forum_posts forum_posts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_posts
    ADD CONSTRAINT forum_posts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: forum_replies forum_replies_post_id_forum_posts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_replies
    ADD CONSTRAINT forum_replies_post_id_forum_posts_id_fk FOREIGN KEY (post_id) REFERENCES public.forum_posts(id) ON DELETE CASCADE;


--
-- Name: forum_replies forum_replies_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forum_replies
    ADD CONSTRAINT forum_replies_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: garage garage_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.garage
    ADD CONSTRAINT garage_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_order_id_orders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_orders_id_fk FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_products_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_products_id_fk FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: order_notes order_notes_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_notes
    ADD CONSTRAINT order_notes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: orders orders_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: product_attribute_terms product_attribute_terms_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_attribute_terms
    ADD CONSTRAINT product_attribute_terms_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.product_attributes(id) ON DELETE CASCADE;


--
-- Name: product_links product_links_linked_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_links
    ADD CONSTRAINT product_links_linked_product_id_fkey FOREIGN KEY (linked_product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_links product_links_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_links
    ADD CONSTRAINT product_links_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_reviews product_reviews_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: product_reviews product_reviews_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_reviews product_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_reviews
    ADD CONSTRAINT product_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: product_tags product_tags_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_tags
    ADD CONSTRAINT product_tags_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_tags product_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_tags
    ADD CONSTRAINT product_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: product_variation_attributes product_variation_attributes_attribute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes
    ADD CONSTRAINT product_variation_attributes_attribute_id_fkey FOREIGN KEY (attribute_id) REFERENCES public.product_attributes(id) ON DELETE CASCADE;


--
-- Name: product_variation_attributes product_variation_attributes_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes
    ADD CONSTRAINT product_variation_attributes_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.product_attribute_terms(id) ON DELETE CASCADE;


--
-- Name: product_variation_attributes product_variation_attributes_variation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_variation_attributes
    ADD CONSTRAINT product_variation_attributes_variation_id_fkey FOREIGN KEY (variation_id) REFERENCES public.product_variations(id) ON DELETE CASCADE;


--
-- Name: product_vehicles product_vehicles_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_vehicles
    ADD CONSTRAINT product_vehicles_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.vehicle_models(id) ON DELETE CASCADE;


--
-- Name: product_vehicles product_vehicles_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_vehicles
    ADD CONSTRAINT product_vehicles_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_category2_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category2_id_fkey FOREIGN KEY (category2_id) REFERENCES public.categories(id);


--
-- Name: products products_category3_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category3_id_fkey FOREIGN KEY (category3_id) REFERENCES public.categories(id);


--
-- Name: reviews reviews_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: shipping_methods shipping_methods_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shipping_methods
    ADD CONSTRAINT shipping_methods_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.shipping_zones(id) ON DELETE CASCADE;


--
-- Name: tax_rates tax_rates_class_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_class_id_fkey FOREIGN KEY (class_id) REFERENCES public.tax_classes(id) ON DELETE CASCADE;


--
-- Name: vehicle_models vehicle_models_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_models
    ADD CONSTRAINT vehicle_models_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.vehicle_brands(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


