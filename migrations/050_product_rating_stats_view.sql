-- 050_product_rating_stats_view.sql
-- Corrige la vista product_rating_stats para que agregue las reseñas reales de la tabla product_reviews.

CREATE OR REPLACE VIEW public.product_rating_stats AS
SELECT product_id,
    count(*) AS review_count,
    round(avg(rating), 1) AS avg_rating,
    count(*) FILTER (WHERE (rating = 5)) AS five_star,
    count(*) FILTER (WHERE (rating = 4)) AS four_star,
    count(*) FILTER (WHERE (rating = 3)) AS three_star,
    count(*) FILTER (WHERE (rating = 2)) AS two_star,
    count(*) FILTER (WHERE (rating = 1)) AS one_star
FROM public.product_reviews
WHERE status = 'approved' OR status IS NULL
GROUP BY product_id;
