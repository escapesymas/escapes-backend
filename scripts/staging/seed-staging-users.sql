-- Cuentas del entorno de pruebas. Lo lanza refresh-staging-db.sh con las variables admin_pw y cliente_pw ya definidas
-- (\set …), así que ninguna contraseña está escrita aquí.
-- Los correos acaban en .invalid (RFC 2606): aunque fallara todo lo demás, no existe ningún buzón al que pudieran llegar.
-- El administrador tendrá que activar su verificación en dos pasos (TOTP) en el primer inicio de sesión del panel de pruebas.
INSERT INTO users (username, email, first_name, last_name, role, password_hash, email_verified, email_verified_at)
VALUES
  ('pruebas-admin',   'admin@pruebas.invalid',   'Admin',   'Pruebas', 'admin',    crypt(:'admin_pw',   gen_salt('bf', 10)), true, now()),
  ('pruebas-cliente', 'cliente@pruebas.invalid', 'Cliente', 'Pruebas', 'customer', crypt(:'cliente_pw', gen_salt('bf', 10)), true, now())
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash, email_verified = true, role = EXCLUDED.role;
