/**
 * Protocolo IndexNow para notificación instantánea de URLs a motores de búsqueda
 * participantes (Microsoft Bing, Yandex, Seznam.cz, Naver).
 *
 * Especificación: https://www.indexnow.org/documentation
 */

export const INDEXNOW_KEY = 'e9a4f682d3c1482098d5781a5a04e4c2';
export const INDEXNOW_HOST = 'escapesymas.com';
export const INDEXNOW_KEY_LOCATION = `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`;
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/IndexNow';

export interface IndexNowResult {
  ok: boolean;
  submittedCount: number;
  statusCode?: number;
  error?: string;
}

/**
 * Notifica a los motores de búsqueda de IndexNow sobre URLs creadas o actualizadas.
 * Los motores comparten las notificaciones entre sí automáticamente.
 */
export async function submitIndexNowUrls(urls: string[]): Promise<IndexNowResult> {
  if (!urls || urls.length === 0) {
    return { ok: true, submittedCount: 0 };
  }

  // Normaliza y deduplica URLs garantizando dominio escapesymas.com y protocolo https://
  const cleanList = Array.from(
    new Set(
      urls
        .map((u) => String(u || '').trim())
        .filter(Boolean)
        .map((u) => {
          try {
            if (u.startsWith('http://') || u.startsWith('https://')) {
              const parsed = new URL(u);
              if (parsed.hostname !== INDEXNOW_HOST && parsed.hostname !== `www.${INDEXNOW_HOST}`) {
                return null;
              }
              return `https://${INDEXNOW_HOST}${parsed.pathname}${parsed.search}`;
            }
            const cleanPath = u.startsWith('/') ? u : `/${u}`;
            return `https://${INDEXNOW_HOST}${cleanPath}`;
          } catch {
            return null;
          }
        })
        .filter((u): u is string => Boolean(u))
    )
  );

  if (cleanList.length === 0) {
    return { ok: true, submittedCount: 0 };
  }

  // La API de IndexNow acepta lotes de hasta 10.000 URLs por petición
  const batch = cleanList.slice(0, 10_000);

  const payload = {
    host: INDEXNOW_HOST,
    key: INDEXNOW_KEY,
    keyLocation: INDEXNOW_KEY_LOCATION,
    urlList: batch,
  };

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    // 200 OK: URLs enviadas satisfactoriamente
    // 202 Accepted: Petición recibida en cola
    if (res.status === 200 || res.status === 202) {
      return { ok: true, submittedCount: batch.length, statusCode: res.status };
    }

    const responseText = await res.text().catch(() => '');
    return {
      ok: false,
      submittedCount: 0,
      statusCode: res.status,
      error: `IndexNow HTTP ${res.status}: ${responseText || res.statusText}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      submittedCount: 0,
      error: err?.message || String(err),
    };
  }
}
