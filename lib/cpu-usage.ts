/**
 * Uso REAL de CPU del servidor para Ajustes › Sistema.
 *
 * Antes el panel enseñaba `loadavg[0] / núcleos`, pero la carga media cuenta también los procesos en cola y los que esperan al disco:
 * marcaba 87 % con la CPU real al ~27 %. Aquí se mide el tiempo que los núcleos pasan sin hacer nada entre dos instantes
 * (lo mismo que hacen `top` o `sar`). Dentro del contenedor `os.cpus()` lee `/proc/stat` del servidor entero, no el del contenedor.
 *
 * Un muestreo en segundo plano (cada 5 s, sin retener el proceso) guarda un minuto de instantáneas: el valor que se enseña es la
 * media de ese último minuto, estable aunque el panel pregunte cada 15 s y sin picos de un segundo que asusten.
 */
import os from 'os';

export interface CpuSnapshot { idle: number; total: number; at: number }

/** Suma los tiempos de todos los núcleos. `os.cpus()` no cuenta iowait/steal, que aquí no interesan. */
export function takeSnapshot(cpus: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }> = os.cpus(), at = Date.now()): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, at };
}

/** % de CPU ocupada entre dos instantáneas (0-100, entero) o `null` si no hay tiempo transcurrido entre ellas. */
export function cpuPercentBetween(a: CpuSnapshot, b: CpuSnapshot): number | null {
  const total = b.total - a.total;
  const idle = b.idle - a.idle;
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

export interface CpuMonitorOptions {
  /** De dónde se lee el estado (se inyecta en las pruebas). */
  read?: () => CpuSnapshot;
  /** Cada cuánto se toma una muestra. */
  intervalMs?: number;
  /** Cuánto histórico se promedia. */
  windowMs?: number;
}

export function createCpuMonitor(opts: CpuMonitorOptions = {}) {
  const read = opts.read ?? (() => takeSnapshot());
  const intervalMs = opts.intervalMs ?? 5_000;
  const windowMs = opts.windowMs ?? 60_000;
  let samples: CpuSnapshot[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  const sample = () => {
    const s = read();
    samples.push(s);
    // Se conserva una muestra más allá de la ventana para que la comparación cubra la ventana entera.
    const limit = s.at - windowMs;
    let cut = 0;
    while (cut + 1 < samples.length && samples[cut + 1].at <= limit) cut++;
    if (cut > 0) samples = samples.slice(cut);
  };

  return {
    /** Toma una muestra ya (útil al arrancar y en las pruebas). */
    sample,
    /** Empieza el muestreo periódico; el temporizador no mantiene vivo el proceso. */
    start() {
      if (timer) return;
      sample();
      timer = setInterval(sample, intervalMs);
      (timer as any)?.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Uso medio de CPU (%) del último minuto, o `null` si aún no hay dos muestras distintas. */
    current(): number | null {
      if (samples.length < 2) return null;
      return cpuPercentBetween(samples[0], samples[samples.length - 1]);
    },
  };
}

/** Instancia única del servidor; se arranca con `cpuMonitor.start()` al levantar la API. */
export const cpuMonitor = createCpuMonitor();
