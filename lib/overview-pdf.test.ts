import { describe, it, expect } from 'vitest';
import { buildOverviewPdf, winAnsi } from './overview-pdf.js';
import { makeReport } from './overview-fixture.js';

const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

describe('PDF del informe', () => {
  it('genera un PDF válido de varias páginas', async () => {
    const pdf = await buildOverviewPdf(makeReport());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5_000);
    expect(pages(pdf)).toBeGreaterThanOrEqual(3);
  });

  it('con el análisis de la IA añade una página más', async () => {
    const base = await buildOverviewPdf(makeReport());
    const ai = '## Resumen ejecutivo\n\nLas ventas suben un **12,0 %**.\n\n## Recomendaciones\n\n1. Revisar el pago.\n2. Enviar recordatorios.\n- Punto suelto';
    const withAi = await buildOverviewPdf(makeReport(), ai);
    expect(pages(withAi)).toBeGreaterThan(pages(base));
  });

  it('sin estadísticas web (Umami caído) el PDF sale igualmente', async () => {
    const pdf = await buildOverviewPdf(makeReport({ visits: false }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('un texto enorme de la IA no rompe el PDF', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `${i + 1}. Frase de prueba número ${i} con **negrita** y acentos: ñandú, camión, niño.`).join('\n');
    const pdf = await buildOverviewPdf(makeReport(), long);
    expect(pages(pdf)).toBeGreaterThan(8);
  });
});

describe('texto que sí existe en las fuentes de PDF', () => {
  it('deja los acentos y el euro, cambia el menos y quita lo que no tiene glifo', () => {
    expect(winAnsi('Camión: 1.234,50 € — ñandú')).toBe('Camión: 1.234,50 € — ñandú');
    expect(winAnsi('−12,5 % → mejor')).toBe('-12,5 % -> mejor');
    expect(winAnsi('Hola 😀 mundo 你好')).toBe('Hola  mundo ');
  });
});
