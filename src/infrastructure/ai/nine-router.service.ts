import axios, { type AxiosInstance, isAxiosError } from 'axios';
import type { IAiProvider, ReviewResult, FixResult } from '../../domain/interfaces/ai-provider.interface.js';
import type { IOutputParser } from '../../application/services/parser.service.js';
import type { IFixOutputParser } from '../../application/services/parser.service.js';
import { config } from '../../config/index.js';
import { AiProviderError } from '../../domain/errors/app-errors.js';
import { logger } from '../logging/logger.js';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  response_format: { type: 'json_object' };
  max_tokens: number;
}

interface ChatChoice {
  message: { content: string };
  finish_reason: string;
}

interface ChatResponse {
  choices: ChatChoice[];
}

export class NineRouterService implements IAiProvider {
  private readonly client: AxiosInstance;
  private readonly parser: IOutputParser & IFixOutputParser;

  constructor(parser: IOutputParser & IFixOutputParser) {
    this.parser = parser;
    this.client = axios.create({
      baseURL: config.NINE_ROUTER_BASE_URL,
      timeout: 120_000,
      headers: {
        'Authorization': `Bearer ${config.NINE_ROUTER_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async review(prompt: string): Promise<ReviewResult> {
    const delimiter = '\n\n--- GIT DIFF ---\n';
    const messages: ChatMessage[] = [];
    const delimiterIdx = prompt.indexOf(delimiter);

    if (delimiterIdx !== -1) {
      const systemContent = prompt.substring(0, delimiterIdx).trim();
      const userContent = prompt.substring(delimiterIdx + delimiter.length).trim();
      messages.push(
        { role: 'system', content: systemContent },
        { role: 'user', content: `--- GIT DIFF ---\n${userContent}` }
      );
    } else {
      messages.push({ role: 'user', content: prompt });
    }

    const raw = await this.sendChat(messages, 8192, 'review');
    return this.parser.parse(raw);
  }

  async fix(prompt: string): Promise<FixResult> {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
    const raw = await this.sendChat(messages, 16384, 'fix');
    return this.parser.parseFix(raw);
  }

  private async sendChat(messages: ChatMessage[], maxTokens: number, label: string): Promise<string> {
    const payload: ChatRequest = {
      model: config.NINE_ROUTER_MODEL,
      messages,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
    };

    logger.info(`Sending ${label} request to 9Router`);

    try {
      const response = await this.client.post<ChatResponse>('/chat/completions', payload);
      const choice = response.data.choices[0];
      const raw = choice?.message.content ?? '';

      logger.debug('Received AI response', undefined, { length: raw.length, finishReason: choice?.finish_reason });

      if (choice?.finish_reason === 'length') {
        logger.warn('AI response truncated by max_tokens before completion', undefined, { length: raw.length });
        // A truncated fix carries a partial file body; writing it would
        // silently delete the rest of the file on the PR branch.
        if (label === 'fix') {
          throw new AiProviderError('AI fix response truncated by max_tokens; refusing to apply partial file content');
        }
      }

      return raw;
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (isAxiosError(err)) {
        const status = err.response?.status ?? 0;
        const body = JSON.stringify(err.response?.data ?? {});

        if (status === 429) {
          throw new AiProviderError(`9Router rate limit exceeded: ${body}`);
        }
        if (status === 401 || status === 403) {
          throw new AiProviderError(`9Router authentication failed: ${body}`, { permanent: true });
        }
        if (status >= 500 || status === 0) {
          throw new AiProviderError(`9Router gateway error (${status}): ${body}`);
        }

        throw new AiProviderError(`9Router request failed (${status}): ${body}`);
      }

      throw new AiProviderError(`AI provider unexpected error: ${String(err)}`);
    }
  }
}


