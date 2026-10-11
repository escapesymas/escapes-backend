/**
 * Protección de datos de los asesores del chat: información sobre el
 * tratamiento de sus datos (art. 13 RGPD) y compromiso de confidencialidad
 * sobre los datos de clientes a los que acceden (art. 5 LOPDGDD, arts. 29 y
 * 32.4 RGPD).
 *
 * - El asesor lo acepta al entrar en su panel; queda registrado con la versión,
 *   la huella (SHA-256) del texto, la fecha, la IP y el navegador.
 * - Se le envía una copia por email (y otra a info@ para el archivo).
 * - Como en el aviso legal de la web, el responsable figura con el nombre
 *   comercial y el email de contacto (sin razón social ni NIF por ahora).
 * - Cambiar el texto = subir AGENT_LEGAL_VERSION: se vuelve a pedir a todos.
 */
import crypto from 'crypto';
import { pool } from '../db.js';
import { sendTemplatedEmail } from './email.js';

export const AGENT_LEGAL_VERSION = '2026-10-11';
const CONTACT = 'info@escapesymas.com';

/** Texto completo (secciones con párrafos o listas). */
export function agentLegalDocument() {
  const title = 'Protección de datos y compromiso de confidencialidad para asesores';
  const sections: { heading: string; paragraphs?: string[]; items?: string[] }[] = [
    {
      heading: '1. Quién trata tus datos',
      paragraphs: [
        'Responsable: Escapes y Más, titular de la tienda escapesymas.com.',
        `Contacto para cualquier cuestión sobre protección de datos: ${CONTACT}.`,
      ],
    },
    {
      heading: '2. Qué datos tuyos tratamos',
      items: [
        'Identificación y contacto: nombre, apellidos, email y, si nos los das, teléfono.',
        'Acceso al panel: contraseña (guardada cifrada), métodos de verificación en dos pasos, sesiones, direcciones IP y registros de conexión.',
        'Actividad como asesor: conversaciones que atiendes, pedidos que preparas, descuentos aplicados, valoraciones de los clientes y tiempos de respuesta.',
        'Datos económicos: comisiones generadas y pagadas, y los datos bancarios y fiscales necesarios para pagártelas.',
      ],
    },
    {
      heading: '3. Para qué y con qué base legal',
      items: [
        'Gestionar tu colaboración como asesor, darte acceso al panel, asignarte conversaciones y enviarte avisos (ejecución de la relación de colaboración, art. 6.1.b RGPD).',
        'Calcular, liquidar y pagar tus comisiones y cumplir las obligaciones fiscales y contables (art. 6.1.b y 6.1.c RGPD).',
        'Proteger el panel y los datos de los clientes: verificación en dos pasos, registros de acceso y detección de usos indebidos (interés legítimo, art. 6.1.f RGPD).',
        'Medir la calidad de la atención (estadísticas de chats, conversiones y valoraciones) para gestionar la colaboración (interés legítimo, art. 6.1.f RGPD).',
      ],
    },
    {
      heading: '4. A quién se comunican',
      paragraphs: [
        'No cedemos tus datos a terceros salvo obligación legal (por ejemplo, la Agencia Tributaria) o cuando sea necesario para pagarte (tu banco o la entidad de pago).',
        'Los tratan, por cuenta nuestra y con contrato, los proveedores tecnológicos necesarios para el servicio: alojamiento del servidor, envío de correos, notificaciones push del navegador o del móvil y herramientas de asistencia del chat.',
      ],
    },
    {
      heading: '5. Cuánto tiempo los conservamos',
      paragraphs: [
        'Mientras dure la colaboración. Después, bloqueados durante los plazos legales (fiscales y de prescripción de responsabilidades) y, pasados estos, se suprimen. Los registros de acceso se conservan el tiempo necesario para la seguridad del panel.',
      ],
    },
    {
      heading: '6. Tus derechos',
      paragraphs: [
        `Puedes pedir el acceso, la rectificación, la supresión, la oposición, la limitación y la portabilidad de tus datos escribiendo a ${CONTACT}. Si consideras que no se han respetado, puedes reclamar ante la Agencia Española de Protección de Datos (www.aepd.es).`,
      ],
    },
    {
      heading: '7. Compromiso de confidencialidad sobre los datos de los clientes',
      paragraphs: [
        'Como asesor accedes, por cuenta de Escapes y Más, a datos personales de clientes: nombre, email, teléfono, dirección, pedidos, carrito, conversaciones y fotos. Al aceptar este documento te comprometes a:',
      ],
      items: [
        'Usar esos datos únicamente para atender a los clientes en el chat y preparar sus pedidos, siguiendo las instrucciones de Escapes y Más, y nunca para fines propios o de terceros.',
        'Guardar secreto sobre ellos (deber de confidencialidad del art. 5 de la Ley Orgánica 3/2018), también cuando termine la colaboración.',
        'No copiarlos, descargarlos, fotografiarlos, exportarlos ni guardarlos fuera del panel, y no contactar con los clientes por otros medios (teléfono, WhatsApp, redes sociales o email personal).',
        'Proteger tu acceso: no compartir tu cuenta ni tu contraseña, mantener activa la verificación en dos pasos, bloquear tu móvil y ordenador y cerrar la sesión en dispositivos que no sean tuyos.',
        `Avisar en un máximo de 24 horas a ${CONTACT} de cualquier incidente: pérdida o robo del móvil, acceso de otra persona a tu cuenta, mensajes o datos enviados a quien no correspondía, etc.`,
        'Al terminar la colaboración, dejar de usar el panel (se retirará tu acceso) y no conservar ningún dato de clientes.',
      ],
    },
    {
      heading: '8. Incumplimiento',
      paragraphs: [
        'Incumplir este compromiso puede suponer el fin inmediato de la colaboración y las responsabilidades legales que correspondan.',
      ],
    },
  ];
  const text = [title, `Versión ${AGENT_LEGAL_VERSION}`, ...sections.map((s) => [
    s.heading,
    ...(s.paragraphs || []),
    ...(s.items || []).map((i) => `- ${i}`),
  ].join('\n'))].join('\n\n');
  return { version: AGENT_LEGAL_VERSION, title, sections, text, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

export async function lastAcceptance(userId: number) {
  const { rows: [r] } = await pool.query(
    `SELECT version, accepted_at, emailed_at FROM agent_legal_acceptances WHERE user_id = $1 ORDER BY accepted_at DESC LIMIT 1`, [userId]);
  return r || null;
}

/**
 * Copia por email del documento (al asesor y a info@ para el archivo), con los
 * datos de la aceptación si la hay. Devuelve si se envió al asesor.
 */
export async function emailAgentLegal(user: { id: number; email: string; name: string }, acceptance?: { accepted_at: string | Date; ip?: string | null; version: string } | null): Promise<boolean> {
  const doc = agentLegalDocument();
  const record = acceptance
    ? `Aceptado por ${user.name} (${user.email}) el ${new Date(acceptance.accepted_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} (hora peninsular)` +
      `${acceptance.ip ? ` desde la IP ${acceptance.ip}` : ''}, versión ${acceptance.version}.\nHuella del texto (SHA-256): ${doc.hash}`
    : `Pendiente de aceptar: se te pedirá al entrar en el panel de asesores.`;
  const body = `Hola ${user.name},\n\nTe enviamos una copia de la información sobre protección de datos y del compromiso de confidencialidad de los asesores de Escapes y Más. Guárdala.\n\n${record}\n\n────────────\n\n${doc.text}`;
  const subject = `Protección de datos y confidencialidad (asesores) · versión ${doc.version}`;
  const sent = await sendTemplatedEmail('generic', user.email, { subject, body });
  await sendTemplatedEmail('generic', CONTACT, { subject: `[Archivo] ${subject} · ${user.email}`, body }).catch(() => null);
  return sent.status === 'sent';
}
