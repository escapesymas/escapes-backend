import { describe, it, expect } from 'vitest';
import { snapshotFromProcStat, snapshotFromOsCpus, takeSnapshot, cpuPercentBetween, createCpuMonitor, type CpuSnapshot } from './cpu-usage.js';

const snap = (idle: number, total: number, at: number): CpuSnapshot => ({ idle, total, at });

describe('snapshotFromProcStat', () => {
  const text = 'cpu  100 10 50 700 80 5 15 40 0 0\ncpu0 50 5 25 350 40 2 7 20 0 0\nintr 123\n';
  it('lee la línea global y cuenta el iowait como tiempo parado', () => {
    const s = snapshotFromProcStat(text, 9)!;
    expect(s.idle).toBe(700 + 80);
    expect(s.total).toBe(100 + 10 + 50 + 700 + 80 + 5 + 15 + 40);
    expect(s.at).toBe(9);
  });
  it('con iowait no infla el uso (el caso que medía 5 puntos de más con os.cpus)', () => {
    // 35 de trabajo, 54 parado, 11 esperando disco -> 35 %, no 40 %.
    const a = snapshotFromProcStat('cpu  0 0 0 0 0 0 0 0', 0)!;
    const b = snapshotFromProcStat('cpu  25 0 8 54 11 0 2 0', 1)!;
    expect(cpuPercentBetween(a, b)).toBe(35);
  });
  it('acepta kernels antiguos con pocas columnas', () => {
    expect(snapshotFromProcStat('cpu  10 0 10 80', 0)).toEqual({ idle: 80, total: 100, at: 0 });
  });
  it('devuelve null si no es lo esperado', () => {
    expect(snapshotFromProcStat('', 0)).toBeNull();
    expect(snapshotFromProcStat('cpu0 1 2 3 4', 0)).toBeNull();
    expect(snapshotFromProcStat('cpu  a b c d', 0)).toBeNull();
  });
});

describe('snapshotFromOsCpus', () => {
  it('suma los tiempos de todos los núcleos', () => {
    const s = snapshotFromOsCpus([
      { times: { user: 10, nice: 1, sys: 5, idle: 80, irq: 4 } },
      { times: { user: 20, nice: 0, sys: 10, idle: 70, irq: 0 } },
    ], 123);
    expect(s).toEqual({ idle: 150, total: 200, at: 123 });
  });
});

describe('takeSnapshot', () => {
  it('lee el estado real de esta máquina', () => {
    const s = takeSnapshot(5);
    expect(s.total).toBeGreaterThan(0);
    expect(s.idle).toBeLessThanOrEqual(s.total);
    expect(s.at).toBe(5);
  });
});

describe('cpuPercentBetween', () => {
  it('mide la parte del tiempo que los núcleos no estuvieron parados', () => {
    expect(cpuPercentBetween(snap(0, 0, 0), snap(75, 100, 1))).toBe(25);
    expect(cpuPercentBetween(snap(100, 200, 0), snap(100, 300, 1))).toBe(100);
    expect(cpuPercentBetween(snap(100, 200, 0), snap(200, 300, 1))).toBe(0);
  });
  it('sin tiempo transcurrido no hay medida', () => {
    expect(cpuPercentBetween(snap(5, 10, 0), snap(5, 10, 1))).toBeNull();
    expect(cpuPercentBetween(snap(5, 10, 0), snap(5, 9, 1))).toBeNull();
  });
  it('se mantiene dentro de 0-100 aunque los contadores bailen', () => {
    expect(cpuPercentBetween(snap(0, 0, 0), snap(-10, 100, 1))).toBe(100);
    expect(cpuPercentBetween(snap(0, 0, 0), snap(150, 100, 1))).toBe(0);
  });
});

describe('createCpuMonitor', () => {
  function setup(windowMs = 60_000) {
    let idle = 0;
    let total = 0;
    let at = 0;
    const monitor = createCpuMonitor({ read: () => snap(idle, total, at), windowMs });
    /** Avanza `sec` segundos con la CPU ocupada al `busy` %. */
    const run = (sec: number, busy: number) => {
      for (let i = 0; i < sec; i += 5) {
        at += 5000; total += 500; idle += Math.round(500 * (1 - busy / 100));
        monitor.sample();
      }
    };
    return { monitor, run, start: () => monitor.sample() };
  }

  it('sin dos muestras no devuelve nada', () => {
    const { monitor, start } = setup();
    expect(monitor.current()).toBeNull();
    start();
    expect(monitor.current()).toBeNull();
  });

  it('da la media del último minuto', () => {
    const { monitor, run, start } = setup();
    start();
    run(60, 30);
    expect(monitor.current()).toBe(30);
  });

  it('olvida lo anterior a la ventana', () => {
    const { monitor, run, start } = setup();
    start();
    run(120, 90); // un pico viejo
    run(60, 10); // el último minuto está tranquilo
    expect(monitor.current()).toBe(10);
  });

  it('no acumula muestras sin fin', () => {
    const { monitor, run, start } = setup();
    start();
    run(3600, 20);
    expect(monitor.current()).toBe(20);
  });
});
