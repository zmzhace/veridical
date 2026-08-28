import type { LLMProvider } from '@veridical/llm';
import { SecureProvider } from './production/runner.js';

// Server-only credentials. Public metadata never contains a key or endpoint URL.
export function localModelConfig() {
  const key = process.env.VERIDICAL_PROVIDER_KEY;
  const baseUrl = process.env.VERIDICAL_LLM_BASE_URL;
  const model = process.env.VERIDICAL_LLM_MODEL;
  if (!key || !baseUrl || !model) return undefined;
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('invalid_local_model_endpoint');
  const thinking = process.env.VERIDICAL_LLM_ENABLE_THINKING;
  if (thinking !== undefined && thinking !== 'true' && thinking !== 'false')
    throw new Error('invalid_local_model_thinking');
  const maxOutputTokens = Number(process.env.VERIDICAL_LLM_MAX_OUTPUT_TOKENS ?? 1024);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4096)
    throw new Error('invalid_local_model_token_limit');
  return {
    key,
    baseUrl,
    model,
    maxOutputTokens,
    enableThinking: thinking === undefined ? undefined : thinking === 'true',
  };
}

export function localModelMetadata() {
  try {
    const config = localModelConfig();
    return config
      ? { configured: true, model: config.model, provider: 'openai-compatible' }
      : { configured: false };
  } catch {
    return { configured: false, error: '服务端模型配置无效，请检查 .env.local' };
  }
}

export function createLocalModel(): { model: string; provider: LLMProvider } {
  const config = localModelConfig();
  if (!config) throw new Error('请先在服务端 .env.local 配置模型，然后重启研究服务');
  const provider = new SecureProvider(config.baseUrl, config.key, config.model, {
    enableThinking: config.enableThinking,
  });
  return {
    model: config.model,
    provider: {
      complete: (req) => provider.complete({ ...req, maxOutputTokens: config.maxOutputTokens }),
    },
  };
}
