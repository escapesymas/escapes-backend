/**
 * Se importa el PRIMERO en `index.ts` (justo después de cargar el .env) para que, en el entorno de pruebas, la comprobación de
 * seguridad y el cierre de `fetch` ocurran antes de que ningún otro módulo se inicialice. En producción no hace nada.
 */
import { enforceStagingSafety } from './app-env.js';

enforceStagingSafety();
