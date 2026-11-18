import { describe, it, expect } from 'vitest';
import { messageKind, situationNote, isPolicyQuestion } from './intent.js';

describe('tipo de mensaje', () => {
  it('detecta quejas y enfados sin buscar productos', () => {
    expect(messageKind('Esto es una estafa, os voy a denunciar')).toBe('complaint');
    expect(messageKind('Vergüenza de servicio, nadie me contesta')).toBe('complaint');
    expect(messageKind('Quiero poner una reclamación')).toBe('complaint');
    expect(messageKind('estoy harto de esperar mi pedido')).toBe('complaint');
    expect(messageKind('me habéis engañado con el precio')).toBe('complaint');
  });

  it('no confunde consultas normales con quejas («robo», «mal» sueltos)', () => {
    expect(messageKind('¿Tenéis antirrobo para disco?')).toBe('other');
    expect(messageKind('Protección contra el robo para mi PCX')).toBe('other');
    expect(messageKind('El pedido llegó en mal estado, ¿qué hago?')).toBe('other');
    expect(messageKind('pastillas de freno para una MT-09')).toBe('other');
  });

  it('reconoce agradecimientos y saludos', () => {
    expect(messageKind('gracias')).toBe('thanks');
    expect(messageKind('Muchas gracias, perfecto')).toBe('thanks');
    expect(messageKind('ok')).toBe('thanks');
    expect(messageKind('Hola')).toBe('greeting');
    expect(messageKind('buenas tardes!')).toBe('greeting');
  });

  it('un agradecimiento largo con una pregunta no es un agradecimiento', () => {
    expect(messageKind('gracias, y ¿tenéis también el kit de cadena para la Honda CB 500 F del 2016 en negro?')).toBe('other');
  });

  it('vacío = consulta normal', () => {
    expect(messageKind('')).toBe('other');
    expect(messageKind('   ')).toBe('other');
  });
});

describe('nota de situación para el asistente', () => {
  it('la queja pide empatía, no buscar productos y ofrecer un asesor', () => {
    const n = situationNote('complaint');
    expect(n).toMatch(/ENFADADO|QUEJA/);
    expect(n).toMatch(/asesor/);
    expect(n).toMatch(/No busques/);
  });

  it('una consulta normal no añade nada', () => {
    expect(situationNote('other')).toBe('');
  });
});

describe('preguntas de condiciones de la tienda', () => {
  it('reconoce envíos, pagos, devoluciones, factura y cuenta (con o sin tildes)', () => {
    for (const q of [
      'cuánto tarda en llegar un pedido a Canarias', 'puedo devolver un casco si no me gusta?', 'hacéis factura con CIF para mi taller?',
      'tenéis tienda física? puedo recoger el pedido?', 'puedo pagar con paypal?', 'hay algún cupón de descuento para primera compra?',
      'cuanto cuesta el envio', 'cómo cambio mi contraseña', 'dónde está mi pedido',
    ]) expect(isPolicyQuestion(q), q).toBe(true);
  });

  it('una búsqueda de producto normal no lo es', () => {
    for (const q of ['pastillas de freno para una MT-09', 'kit de cadena Honda CB 500 F', 'escape Akrapovic', 'casco integral talla M'])
      expect(isPolicyQuestion(q), q).toBe(false);
  });
});
