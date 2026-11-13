// Application entry point. The bundle in dist/ is built from this file.
import { CORE_VERSION } from './core/index.js';

export function bootstrap() {
  return { coreVersion: CORE_VERSION };
}
