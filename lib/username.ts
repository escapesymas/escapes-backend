/**
 * Nombre de usuario de una cuenta nueva. El formulario del chat solo pide nombre, correo y contraseña: el usuario se saca de la
 * parte del correo anterior a la «@», y como en la base de datos es único («users_username_unique»), si ya existe se le añade un
 * número. Nunca falla por un nombre repetido (antes el alta daba un error de base de datos que además delataba el usuario).
 */

/** Parte del correo antes de la «@», solo con letras, números y . _ - (máximo 30 caracteres); «cliente» si no queda nada. */
export function baseUsername(email: string): string {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return local.slice(0, 30) || 'cliente';
}

export async function pickUsername(email: string, provided: unknown, isTaken: (name: string) => Promise<boolean>, random: () => number = Math.random): Promise<string> {
  const given = typeof provided === 'string' ? provided.trim() : '';
  if (given) return given.slice(0, 60); // el que escribe el cliente se respeta tal cual (si choca, lo dice el alta)
  const base = baseUsername(email);
  if (!(await isTaken(base))) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}${Math.floor(1000 + random() * 9000)}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}${Date.now()}`;
}
