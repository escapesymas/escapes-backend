import { describe, it, expect } from 'vitest';
import { createEmailSentNotifier, isInternalRecipient, INDIVIDUAL_LIMIT, WINDOW_MS } from './email-notify.js';

function setup() {
  const sent: Array<[string, string]> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let t = 1_000_000;
  const notifier = createEmailSentNotifier({
    notify: (title, body) => { sent.push([title, body]); },
    now: () => t,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  return { notifier, sent, timers, advance: (ms: number) => { t += ms; } };
}

describe('isInternalRecipient', () => {
  it('reconoce nuestros dominios, con nombre, listas y subdominios', () => {
    expect(isInternalRecipient('info@escapesymas.com')).toBe(true);
    expect(isInternalRecipient('"Escapes" <web@escapesymas.com>')).toBe(true);
    expect(isInternalRecipient('a@escapesymas.com, b@backendescapes.com')).toBe(true);
    expect(isInternalRecipient('x@mail.escapesymas.com')).toBe(true);
  });
  it('un destinatario de fuera hace que no sea interno', () => {
    expect(isInternalRecipient('cliente@hotmail.com')).toBe(false);
    expect(isInternalRecipient('info@escapesymas.com, cliente@gmail.com')).toBe(false);
    expect(isInternalRecipient('x@notescapesymas.com')).toBe(false);
  });
  it('sin dirección válida se trata como interno (no se avisa de nada raro)', () => {
    expect(isInternalRecipient('')).toBe(true);
  });
});

describe('createEmailSentNotifier', () => {
  it('avisa de un correo a un cliente con asunto y destinatario', () => {
    const { notifier, sent } = setup();
    notifier({ to: 'cliente@hotmail.com', subject: 'Confirma tu email', template: 'verify-email' });
    expect(sent).toEqual([['✉️ Correo enviado', '«Confirma tu email» a cliente@hotmail.com']]);
  });

  it('no avisa de correos internos', () => {
    const { notifier, sent } = setup();
    notifier({ to: 'info@escapesymas.com', subject: 'Informe semanal' });
    expect(sent).toHaveLength(0);
  });

  it('tras el límite cuenta los envíos y manda un solo resumen al cerrar la ventana', () => {
    const { notifier, sent, timers, advance } = setup();
    for (let i = 0; i < INDIVIDUAL_LIMIT + 4; i++) notifier({ to: `c${i}@gmail.com`, subject: `Piezas nuevas ${i}`, template: 'moto-alert' });
    expect(sent).toHaveLength(INDIVIDUAL_LIMIT);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(WINDOW_MS);
    advance(WINDOW_MS);
    timers[0].fn();
    expect(sent).toHaveLength(INDIVIDUAL_LIMIT + 1);
    expect(sent[INDIVIDUAL_LIMIT][1]).toBe('4 correos más de «moto-alert» en los últimos 10 minutos');
  });

  it('cada plantilla tiene su propio contador', () => {
    const { notifier, sent } = setup();
    for (let i = 0; i < INDIVIDUAL_LIMIT; i++) notifier({ to: `a${i}@gmail.com`, subject: 'A', template: 'uno' });
    notifier({ to: 'b@gmail.com', subject: 'B', template: 'dos' });
    expect(sent).toHaveLength(INDIVIDUAL_LIMIT + 1);
  });

  it('pasada la ventana vuelve a avisar uno a uno', () => {
    const { notifier, sent, advance } = setup();
    for (let i = 0; i < INDIVIDUAL_LIMIT + 1; i++) notifier({ to: `a${i}@gmail.com`, subject: 'A', template: 'uno' });
    advance(WINDOW_MS + 1);
    notifier({ to: 'nuevo@gmail.com', subject: 'Otra vez', template: 'uno' });
    expect(sent[sent.length - 1][1]).toBe('«Otra vez» a nuevo@gmail.com');
  });

  it('un fallo al avisar no rompe nada', () => {
    const boom = createEmailSentNotifier({ notify: () => { throw new Error('push caído'); } });
    expect(() => boom({ to: 'cliente@gmail.com', subject: 'X' })).not.toThrow();
    const rej = createEmailSentNotifier({ notify: () => Promise.reject(new Error('push caído')) });
    expect(() => rej({ to: 'cliente@gmail.com', subject: 'X' })).not.toThrow();
  });

  it('recorta asuntos muy largos', () => {
    const { notifier, sent } = setup();
    notifier({ to: 'cliente@gmail.com', subject: 'x'.repeat(300) });
    expect(sent[0][1].length).toBeLessThan(220);
  });
});
