import { buildApp } from './app.js';
import { CONFIG } from './config.js';
const app = await buildApp();
try {
  await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
  console.log(`veridical server on :${CONFIG.port}`);
} catch (err) {
  console.error(err); process.exit(1);
}
