import { describe, it, expect } from 'vitest';
import { addDays, daysBetween, listDays, madridToday, resolvePeriod } from './overview-period.js';

// 18 de noviembre de 2026, mediodía en Madrid.
const NOW = new Date('2026-11-18T11:00:00Z');

describe('días de Madrid', () => {
  it('a las 23:30 UTC ya es el día siguiente en Madrid', () => {
    expect(madridToday(new Date('2026-11-18T23:30:00Z'))).toBe('2026-11-19');
    expect(madridToday(new Date('2026-07-01T21:59:00Z'))).toBe('2026-07-01');
    expect(madridToday(new Date('2026-07-01T22:00:00Z'))).toBe('2026-07-02');
  });

  it('suma días y cuenta días cruzando meses y años', () => {
    expect(addDays('2026-11-18', -6)).toBe('2026-11-12');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(daysBetween('2026-11-01', '2026-11-18')).toBe(18);
    expect(daysBetween('2026-11-18', '2026-11-18')).toBe(1);
    expect(listDays('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});

describe('periodos del informe', () => {
  it('hoy y ayer se comparan con el día anterior', () => {
    const t = resolvePeriod({ preset: 'today' }, NOW);
    expect([t.from, t.to, t.prevFrom, t.prevTo, t.days]).toEqual(['2026-11-18', '2026-11-18', '2026-11-17', '2026-11-17', 1]);
    const y = resolvePeriod({ preset: 'yesterday' }, NOW);
    expect([y.from, y.to, y.prevFrom, y.prevTo]).toEqual(['2026-11-17', '2026-11-17', '2026-11-16', '2026-11-16']);
  });

  it('últimos 7 y 30 días incluyen hoy y se comparan con los de justo antes', () => {
    const w = resolvePeriod({ preset: '7d' }, NOW);
    expect([w.from, w.to, w.prevFrom, w.prevTo, w.days]).toEqual(['2026-11-12', '2026-11-18', '2026-11-05', '2026-11-11', 7]);
    const m = resolvePeriod({ preset: '30d' }, NOW);
    expect([m.from, m.to, m.prevFrom, m.prevTo, m.days]).toEqual(['2026-10-20', '2026-11-18', '2026-09-20', '2026-10-19', 30]);
  });

  it('el mes en curso se compara con los mismos días del mes anterior', () => {
    const p = resolvePeriod({ preset: 'month' }, NOW);
    expect([p.from, p.to, p.prevFrom, p.prevTo]).toEqual(['2026-11-01', '2026-11-18', '2026-10-01', '2026-10-18']);
    expect(p.label).toContain('noviembre de 2026');
  });

  it('el día 31 no se sale del mes anterior más corto', () => {
    const p = resolvePeriod({ preset: 'month' }, new Date('2026-05-31T10:00:00Z'));
    expect([p.from, p.to, p.prevFrom, p.prevTo]).toEqual(['2026-05-01', '2026-05-31', '2026-04-01', '2026-04-30']);
  });

  it('el mes anterior entero se compara con el anterior a ese', () => {
    const p = resolvePeriod({ preset: 'prev_month' }, NOW);
    expect([p.from, p.to, p.prevFrom, p.prevTo, p.days]).toEqual(['2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30', 31]);
    const jan = resolvePeriod({ preset: 'prev_month' }, new Date('2027-01-10T10:00:00Z'));
    expect([jan.from, jan.to, jan.prevFrom, jan.prevTo]).toEqual(['2026-12-01', '2026-12-31', '2026-11-01', '2026-11-30']);
  });

  it('el año en curso se compara con los mismos días del año anterior', () => {
    const p = resolvePeriod({ preset: 'year' }, NOW);
    expect([p.from, p.to, p.prevFrom, p.prevTo]).toEqual(['2026-01-01', '2026-11-18', '2025-01-01', '2025-11-18']);
    const leap = resolvePeriod({ preset: 'year' }, new Date('2028-02-29T10:00:00Z'));
    expect(leap.prevTo).toBe('2027-02-28');
  });

  it('el personalizado respeta las fechas y compara con un periodo igual de largo justo antes', () => {
    const p = resolvePeriod({ preset: 'custom', from: '2026-11-01', to: '2026-11-10' }, NOW);
    expect([p.from, p.to, p.prevFrom, p.prevTo, p.days]).toEqual(['2026-11-01', '2026-11-10', '2026-10-22', '2026-10-31', 10]);
  });

  it('el personalizado incorrecto se corrige en lugar de fallar', () => {
    // fecha futura → hoy; al revés → un solo día; inventada → últimos 30 días; demasiado largo → recortado
    expect(resolvePeriod({ preset: 'custom', from: '2026-11-10', to: '2027-05-01' }, NOW).to).toBe('2026-11-18');
    const rev = resolvePeriod({ preset: 'custom', from: '2026-11-15', to: '2026-11-10' }, NOW);
    expect([rev.from, rev.to]).toEqual(['2026-11-10', '2026-11-10']);
    const bad = resolvePeriod({ preset: 'custom', from: '2026-02-31', to: 'hoy' }, NOW);
    expect([bad.from, bad.to, bad.days]).toEqual(['2026-10-20', '2026-11-18', 30]);
    expect(resolvePeriod({ preset: 'custom', from: '2020-01-01', to: '2026-11-18' }, NOW).days).toBe(400);
  });

  it('un preset desconocido o con inyección usa los últimos 30 días', () => {
    expect(resolvePeriod({ preset: "x'; DROP TABLE orders;--" }, NOW).preset).toBe('30d');
    expect(resolvePeriod({}, NOW).preset).toBe('30d');
  });
});
