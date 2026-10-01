-- Datos mínimos para scripts/smoke-security.ts (solo entornos de test/local).
INSERT INTO users (id, wp_id, username, email, role, password_hash) VALUES
  (900001, 77001, 'test_a', 'a@test.local', 'customer', 'x'),
  (900002, 77002, 'test_b', 'b@test.local', 'customer', 'x'),
  (900003, NULL, 'test_admin', 'admin@test.local', 'admin', 'x')
ON CONFLICT DO NOTHING;
INSERT INTO orders (id, user_id, total, status, shipping_data, subtotal) VALUES
  (900101, 900001, 5000, 'pending', '{"email":"a@test.local","phone":"600000000"}', 5000)
ON CONFLICT DO NOTHING;
INSERT INTO garage (user_id, brand, model, year) VALUES (900001, 'Honda', 'CBR', 2020);
