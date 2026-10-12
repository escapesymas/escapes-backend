/**
 * Avisos en directo para el programa de escritorio de los asesores.
 *
 * El programa abre GET /api/agent/stream (server-sent events) y lo mantiene
 * abierto mientras está en la bandeja; cada aviso del asesor (notifyAgent) se
 * le envía al momento como `event: notice`. En Linux no hay un servicio de push
 * del sistema: esta conexión hace de push. Un solo proceso de backend, así que
 * basta con la lista en memoria.
 */
import type { Response } from 'express';

export interface StreamNotice { category: string; title: string; body?: string; url?: string }

const clients = new Map<number, Set<Response>>();
const admins = new Set<number>();

export function addStreamClient(userId: number, isAdmin: boolean, res: Response): () => void {
  const set = clients.get(userId) || new Set<Response>();
  set.add(res);
  clients.set(userId, set);
  if (isAdmin) admins.add(userId);
  return () => {
    set.delete(res);
    if (!set.size) { clients.delete(userId); admins.delete(userId); }
  };
}

export function writeEvent(res: Response, event: string, data: object) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function pushToUser(userId: number, notice: StreamNotice) {
  for (const res of clients.get(userId) || []) {
    try { writeEvent(res, 'notice', notice); } catch { /* conexión cerrada: la quita su propio cierre */ }
  }
}

/** Avisos del chat para los administradores que tengan el programa abierto. */
export function pushToAdmins(notice: StreamNotice) {
  for (const id of admins) pushToUser(id, notice);
}
