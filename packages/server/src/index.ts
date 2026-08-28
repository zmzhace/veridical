import { buildApp } from './app.js';
import { CONFIG } from './config.js';
import { buildProductionApp } from './production/app.js';
import { loadProductionConfig } from './production/config.js';
async function main() {
  process.umask(0o077);
  const mode = process.env.VERIDICAL_MODE ?? 'production';
  if (mode !== 'development' && mode !== 'production')
    throw new Error(`invalid VERIDICAL_MODE: ${mode}; expected development or production`);
  const development = mode === 'development';
  const settings = development ? undefined : loadProductionConfig();
  const app = development ? await buildApp() : (await buildProductionApp(settings!)).app;
  const address = await app.listen({ port: settings?.config.port ?? CONFIG.port, host: settings?.config.host ?? CONFIG.host });
  console.log(`veridical server on ${address}`);
  const stop = () => { void app.close().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
