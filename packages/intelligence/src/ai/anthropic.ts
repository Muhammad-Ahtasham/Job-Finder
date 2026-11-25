import { fetchJson, type FetchLike } from '@jobfinder/discovery';
import type { AiProvider, AiRequest } from './provider';

export interface AnthropicAiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Anthropic Messages API with a forced tool call: the model can only answer by filling the
 * task's JSON schema. The answer is still treated as untrusted (see runStructured).
 */
export class AnthropicAiProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly model: string;

  constructor(private readonly options: AnthropicAiProviderOptions) {
    this.model = options.model;
  }

  async complete(request: AiRequest): Promise<unknown> {
    const response = (await fetchJson(
      `${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: request.maxTokens,
          system: request.system,
          tools: [
            {
              name: 'report',
              description: `Report the result of the ${request.task} task.`,
              input_schema: request.jsonSchema,
            },
          ],
          tool_choice: { type: 'tool', name: 'report' },
          messages: [{ role: 'user', content: request.user }],
        }),
        timeoutMs: this.options.timeoutMs ?? 30_000,
        maxBytes: 512 * 1024,
        fetchImpl: this.options.fetchImpl,
      },
    )) as { content?: { type: string; input?: unknown }[] };
    const call = response.content?.find((block) => block.type === 'tool_use');
    if (!call) throw new Error('model did not call the tool');
    return call.input;
  }
}
