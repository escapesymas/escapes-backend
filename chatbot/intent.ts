/**
 * Qué tipo de mensaje es (sin IA): el asistente solo busca en el catálogo cuando el cliente pide algo de la tienda.
 *
 * Antes cualquier mensaje se trataba como una búsqueda de producto: «esto es una estafa, os voy a denunciar» salía como
 * «NO SE ENCONTRARON PRODUCTOS PARA "esto estafa os voy denunciar"» y el modelo contestaba hablando de referencias que
 * no existen; un «gracias» enseñaba el resumen del catálogo.
 */

export type MessageKind = 'complaint' | 'thanks' | 'greeting' | 'other';

// Enfado o queja: no se busca nada, se empatiza y se ofrece un asesor. Sin «robo» ni «mal» sueltos: «antirrobo»,
// «protección contra el robo» o «mal estado» son consultas normales.
const COMPLAINT_RE = new RegExp('\\b(' + [
  'estafa', 'estafadores', 'estafadora', 'fraude', 'timo', 'timadores', 'denunci\\w+', 'reclamaci[oó]n(es)?', 'reclamar', 'queja', 'quejas',
  'verg[uü]enza', 'indignante', 'inaceptable', 'p[eé]simo', 'p[eé]sima', 'horrible', 'desastre', 'enga[ñn]\\w+', 'harto', 'harta',
  'cabread\\w+', 'furios[oa]', 'mal servicio', 'servicio (nefasto|p[eé]simo|horrible)', 'devu[eé]lvanme', 'devolvedme', 'me han timado',
  'no (me )?(contest|respond)\\w+', 'nadie (me )?(contesta|responde)', 'sois unos', 'nunca (me )?llega',
].join('|') + ')\\b', 'i');

const THANKS_RE = /^\s*(muchas |mil )?gracias\b|^\s*(vale|ok|okey|perfecto|genial|estupendo|de acuerdo|entendido|listo|guay)[\s!.]*(gracias)?[\s!.]*$|^\s*(adi[oó]s|hasta luego|hasta pronto|nada m[aá]s|eso es todo|ya est[aá])\b/i;

const GREETING_RE = /^\s*(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|ey|qu[eé] tal|saludos)[\s!.,¡?]*$/i;

export function messageKind(text: string): MessageKind {
  const t = String(text || '').trim();
  if (!t) return 'other';
  if (COMPLAINT_RE.test(t)) return 'complaint';
  if (GREETING_RE.test(t)) return 'greeting';
  if (THANKS_RE.test(t) && t.length <= 60) return 'thanks';
  return 'other';
}

// Preguntas sobre las condiciones de la tienda (envíos, pagos, devoluciones, factura, cuenta…): se responden con los datos de la
// tienda. Solo se usa cuando la búsqueda de productos no encuentra nada: así no se ofrece un asesor ni se dice «no tenemos el producto».
const POLICY_RE = new RegExp('\\b(' + [
  'envio\\w*', 'entrega\\w*', 'entregar\\w*', 'tarda\\w*', 'plazo\\w*', 'llegar', 'llega', 'devol\\w+', 'reembols\\w+', 'factura\\w*', 'nif', 'cif',
  'garantia\\w*', 'pagar', 'pago', 'pagos', 'paypal', 'bizum', 'klarna', 'tarjeta', 'transferencia', 'contrareembolso', 'cupon\\w*',
  'descuento\\w*', 'tienda fisica', 'recoger', 'recogida', 'telefono', 'horario', 'cancelar', 'seguimiento', 'rastrear', 'iva', 'aduana\\w*',
  'canarias', 'ceuta', 'melilla', 'registrarme', 'registro', 'cuenta', 'contrasena', 'garaje', 'pedido\\w*', 'compra\\w*', 'comprar', 'stripe',
].join('|') + ')\\b', 'i');

export function isPolicyQuestion(text: string): boolean {
  const t = String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return POLICY_RE.test(t);
}

/** Instrucción para el asistente según el tipo de mensaje (vacía si es una consulta normal). */
export function situationNote(kind: MessageKind): string {
  switch (kind) {
    case 'complaint':
      return 'EL CLIENTE ESTÁ ENFADADO O PONE UNA QUEJA. Empatiza en una frase sincera y pide disculpas por el problema, sin ponerte a la defensiva ni discutir. ' +
        'No busques ni ofrezcas productos. Pregúntale qué ha pasado (número de pedido si lo tiene) y ofrécele hablar con un asesor para resolverlo.';
    case 'thanks':
      return 'El cliente se despide o da las gracias: responde con una frase amable y breve, sin ofrecer productos.';
    case 'greeting':
      return 'El cliente saluda: salúdale con naturalidad y pregúntale en qué puedes ayudarle (una pieza para su moto, un pedido, envíos o devoluciones). Sin ofrecer productos.';
    default:
      return '';
  }
}

/** Instrucción cuando la pregunta es de condiciones de la tienda y no hay productos que enseñar. */
export const POLICY_NOTE = 'La consulta es sobre las condiciones o el servicio de la tienda (envíos, pagos, devoluciones, garantía, facturas, cuenta…): ' +
  'respóndela con DATOS DE LA TIENDA, sin hablar de productos. Si el dato no está en DATOS DE LA TIENDA, dilo con sinceridad y remite a info@escapesymas.com.';
