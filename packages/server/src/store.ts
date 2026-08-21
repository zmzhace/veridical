import { JsonlTraceStore } from '@veridical/store';
import { JsonlSpecRegistry } from '@veridical/spec';
import { CONFIG } from './config.js';

export const store = new JsonlTraceStore(CONFIG.tracesDir);
export const specRegistry = new JsonlSpecRegistry(CONFIG.specsDir);

export function getStore() { return store; }
export function getSpecRegistry() { return specRegistry; }
