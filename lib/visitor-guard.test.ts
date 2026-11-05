import { describe, it, expect } from 'vitest';
import { createVisitorGuard, cleanText, cleanNumber, MAX_NEW_SESSIONS_PER_IP, MAX_NOTICES_PER_IP } from './visitor-guard.js';

describe('freno de avisos de visitantes', () => {
  it('limita las sesiones nuevas por IP y hora, y las demás IP no se ven afectadas', () => {
    const g = createVisitorGuard();
    const t = 1_000_000;
    for (let i = 0; i < MAX_NEW_SESSIONS_PER_IP; i++) expect(g.allowNewSession('1.1.1.1', t + i)).toBe(true);
    expect(g.allowNewSession('1.1.1.1', t + 100)).toBe(false);
    expect(g.allowNewSession('2.2.2.2', t + 100)).toBe(true);
  });

  it('limita los avisos al equipo por IP y se recupera pasada la hora', () => {
    const g = createVisitorGuard();
    const t = 5_000_000;
    for (let i = 0; i < MAX_NOTICES_PER_IP; i++) expect(g.allowNotice('3.3.3.3', t)).toBe(true);
    expect(g.allowNotice('3.3.3.3', t + 1000)).toBe(false);
    expect(g.allowNotice('3.3.3.3', t + 61 * 60 * 1000)).toBe(true);
  });

  it('una IP vacía comparte cubo: no sirve para saltarse el límite', () => {
    const g = createVisitorGuard();
    for (let i = 0; i < MAX_NEW_SESSIONS_PER_IP; i++) g.allowNewSession('', 10);
    expect(g.allowNewSession('', 11)).toBe(false);
  });

  it('olvida las IP sin actividad', () => {
    const g = createVisitorGuard();
    for (let i = 0; i < MAX_NEW_SESSIONS_PER_IP; i++) g.allowNewSession('4.4.4.4', 0);
    g.sweep(2 * 60 * 60 * 1000);
    expect(g.allowNewSession('4.4.4.4', 2 * 60 * 60 * 1000)).toBe(true);
  });
});

describe('limpieza de lo que llega del navegador', () => {
  it('texto: una línea, sin control, con largo máximo; lo que no es texto da vacío', () => {
    expect(cleanText('  Hola\n\tmundo \u0007 ', 50)).toBe('Hola mundo');
    expect(cleanText('x'.repeat(500), 20)).toHaveLength(20);
    expect(cleanText({ a: 1 }, 20)).toBe('');
    expect(cleanText(undefined, 20)).toBe('');
  });

  it('números: solo finitos, no negativos y con tope', () => {
    expect(cleanNumber(12.345)).toBe(12.35);
    expect(cleanNumber('99')).toBe(99);
    expect(cleanNumber(-5)).toBeUndefined();
    expect(cleanNumber(1e12)).toBeUndefined();
    expect(cleanNumber(NaN)).toBeUndefined();
    expect(cleanNumber('abc')).toBeUndefined();
  });
});
