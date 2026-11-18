import { describe, it, expect } from 'vitest';
import { cityLabel, deltaOf, fmtDay, fmtValue } from './overview-format.js';

describe('formato de cifras en español', () => {
  it('euros, enteros, porcentajes y decimales, con separador de miles también en 4 cifras', () => {
    expect(fmtValue(1811.94, 'eur')).toBe('1.811,94 €');
    expect(fmtValue(0.81, 'eur')).toBe('0,81 €');
    expect(fmtValue(1173, 'int')).toBe('1.173');
    expect(fmtValue(62.034, 'pct')).toBe('62,0 %');
    expect(fmtValue(0.09, 'pct')).toBe('0,09 %');
    expect(fmtValue(0, 'pct')).toBe('0,0 %');
    expect(fmtValue(2.74, 'dec')).toBe('2,7');
  });

  it('día corto y ciudad con país si no es España', () => {
    expect(fmtDay('2026-11-05')).toBe('5/11');
    expect(cityLabel('Madrid', 'ES')).toBe('Madrid');
    expect(cityLabel('Desconocida', 'US')).toBe('Desconocida (US)');
  });
});

describe('variación respecto al periodo anterior', () => {
  const k = (value: number, prev: number | null, unit: any = 'int', good: any = 'up') => ({ value, prev, unit, good });

  it('sin periodo anterior (foto del momento) no hay variación', () => {
    expect(deltaOf(k(5, null)).dir).toBe('none');
  });

  it('porcentaje normal, subida buena y bajada mala', () => {
    expect(deltaOf(k(150, 100))).toEqual({ text: '+50,0 %', dir: 'up', sentiment: 'good' });
    expect(deltaOf(k(50, 100))).toEqual({ text: '−50,0 %', dir: 'down', sentiment: 'bad' });
  });

  it('en lo que es bueno que baje (rebote, 404) la bajada es buena', () => {
    expect(deltaOf(k(7, 10, 'int', 'down'))).toMatchObject({ dir: 'down', sentiment: 'good' });
    expect(deltaOf(k(12, 10, 'int', 'down'))).toMatchObject({ dir: 'up', sentiment: 'bad' });
  });

  it('desde cero no se inventa un porcentaje: «nuevo»', () => {
    expect(deltaOf(k(3, 0))).toMatchObject({ text: 'nuevo', dir: 'new', sentiment: 'good' });
    expect(deltaOf(k(0, 0))).toMatchObject({ text: '=', dir: 'flat' });
  });

  it('los porcentajes (tasas) se comparan en puntos', () => {
    expect(deltaOf(k(62.1, 92.1, 'pct', 'down'))).toEqual({ text: '−30,0 pp', dir: 'down', sentiment: 'good' });
  });

  it('un cambio neutro no es ni bueno ni malo', () => {
    expect(deltaOf(k(10, 5, 'int', null)).sentiment).toBe('neutral');
  });

  it('variaciones enormes llevan separador de miles', () => {
    expect(deltaOf(k(832, 12)).text).toBe('+6.833 %');
  });
});
