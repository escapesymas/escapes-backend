import { describe, it, expect } from 'vitest';
import { baseUsername, pickUsername } from './username.js';

describe('nombre de usuario a partir del correo', () => {
  it('la parte anterior a la @, en minúsculas y sin símbolos raros', () => {
    expect(baseUsername('Juan.Perez+tienda@gmail.com')).toBe('juan.pereztienda');
    expect(baseUsername('ñandú@x.es')).toBe('and');
    expect(baseUsername('@x.es')).toBe('cliente');
    expect(baseUsername('a'.repeat(80) + '@x.es')).toHaveLength(30);
  });

  it('si está libre se usa tal cual', async () => {
    expect(await pickUsername('juan@gmail.com', undefined, async () => false)).toBe('juan');
  });

  it('si ya existe se le añade un número hasta encontrar uno libre', async () => {
    const taken = new Set(['juan', 'juan5000']);
    const seq = [4000 / 9000, 0.5]; // 1000 + 4000 = 5000 (ocupado) y después 5500
    const r = await pickUsername('juan@hotmail.com', undefined, async (n) => taken.has(n), () => seq.shift() ?? 0.9);
    expect(r).toBe('juan5500');
  });

  it('el usuario que escribe el cliente se respeta (sin comprobarlo aquí)', async () => {
    expect(await pickUsername('juan@gmail.com', '  Juanito  ', async () => true)).toBe('Juanito');
  });

  it('si todo está ocupado acaba con una marca de tiempo en vez de fallar', async () => {
    const r = await pickUsername('juan@gmail.com', '', async () => true);
    expect(r).toMatch(/^juan\d{13}$/);
  });
});
