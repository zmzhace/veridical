import { resolve } from 'node:path';

export const CONFIG = {
  tracesDir: process.env.VERIDICAL_TRACES_DIR
    ? resolve(process.env.VERIDICAL_TRACES_DIR)
    : resolve(process.cwd(), '.traces'),
  specsDir: process.env.VERIDICAL_SPECS_DIR
    ? resolve(process.env.VERIDICAL_SPECS_DIR)
    : resolve(process.cwd(), '.specs'),
  port: Number(process.env.VERIDICAL_PORT ?? 8787),
  host: process.env.VERIDICAL_HOST ?? '127.0.0.1',
};
