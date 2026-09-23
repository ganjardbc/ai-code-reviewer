import { Ajv } from 'ajv';
import type { AiReviewComment, ReviewResult, FileFix, FixResult } from '../../domain/interfaces/ai-provider.interface.js';
import { logger } from '../../infrastructure/logging/logger.js';

// Loose top-level schema: only checks that `comments` is an array of objects.
// Per-comment required field validation is done individually below.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  required: ['comments'],
  additionalProperties: true,
};

const COMMENT_SCHEMA = {
  type: 'object',
  properties: {
    filePath: { type: 'string' },
    lineNumber: { type: 'integer' },
    message: { type: 'string' },
    severity: { type: 'string', enum: ['INFO', 'WARNING', 'CRITICAL'] },
  },
  required: ['filePath', 'lineNumber', 'message', 'severity'],
  additionalProperties: true,
};

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixes: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  required: ['fixes'],
  additionalProperties: true,
};

const FIX_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    filePath: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['filePath', 'content'],
  additionalProperties: true,
};

const ajv = new Ajv({ allErrors: true });
const validateReview = ajv.compile(REVIEW_SCHEMA);
const validateComment = ajv.compile(COMMENT_SCHEMA);
const validateFix = ajv.compile(FIX_SCHEMA);
const validateFixItem = ajv.compile(FIX_ITEM_SCHEMA);

function stripMarkdown(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
}

function extractJson(text: string, anchorKey = 'comments'): string {
  // Anchor on the top-level key so stray braces in leaked reasoning/code
  // (e.g. "initialValues: {") before the real JSON don't get picked as the start.
  const anchorIdx = text.indexOf(`"${anchorKey}"`);
  const searchFrom = anchorIdx !== -1 ? anchorIdx : text.length;
  const start = text.lastIndexOf('{', searchFrom);
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function repairJson(str: string): string {
  // 1. Remove trailing commas before closing braces/brackets
  const cleaned = str.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');

  // 2. Trace and escape unescaped control chars (like newlines) and unescaped quotes inside strings
  let result = '';
  let inString = false;
  let escape = false;
  let currentString = '';

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (inString) {
      if (escape) {
        currentString += char;
        escape = false;
      } else if (char === '\\') {
        currentString += char;
        escape = true;
      } else if (char === '"') {
        // Check if this is the closing quote of a JSON key or value
        let nextNonWs = '';
        for (let j = i + 1; j < cleaned.length; j++) {
          if (!/\s/.test(cleaned[j]!)) {
            nextNonWs = cleaned[j]!;
            break;
          }
        }

        const isClosing = nextNonWs === '' || nextNonWs === ':' || nextNonWs === ',' || nextNonWs === '}' || nextNonWs === ']';

        if (isClosing) {
          result += '"' + currentString + '"';
          inString = false;
          currentString = '';
        } else {
          // Unescaped quote inside a string block
          currentString += '\\"';
        }
      } else if (char === '\n' || char === '\r') {
        // Escape literal newlines
        currentString += '\\n';
      } else {
        currentString += char;
      }
    } else {
      if (char === '"') {
        inString = true;
        currentString = '';
      } else {
        result += char;
      }
    }
  }

  if (inString) {
    result += '"' + currentString + '"';
  }

  // 3. Balance braces and brackets for truncated responses
  const stack: string[] = [];
  let inStringBlock = false;
  let esc = false;

  for (let i = 0; i < result.length; i++) {
    const c = result[i];
    if (inStringBlock) {
      if (esc) {
        esc = false;
      } else if (c === '\\') {
        esc = true;
      } else if (c === '"') {
        inStringBlock = false;
      }
    } else {
      if (c === '"') {
        inStringBlock = true;
      } else if (c === '{') {
        stack.push('}');
      } else if (c === '}') {
        const lastIdx = stack.lastIndexOf('}');
        if (lastIdx !== -1) {
          stack.splice(lastIdx, 1);
        }
      } else if (c === '[') {
        stack.push(']');
      } else if (c === ']') {
        const lastIdx = stack.lastIndexOf(']');
        if (lastIdx !== -1) {
          stack.splice(lastIdx, 1);
        }
      }
    }
  }

  if (inStringBlock) {
    result += '"';
  }
  while (stack.length > 0) {
    result += stack.pop();
  }

  return result;
}

// Fix responses are never repaired: repairJson closes unterminated strings,
// which turns a max_tokens-truncated file body into a "valid" fix that would
// be written, committed and pushed with the rest of the file missing.
function parseStrict(raw: string): unknown {
  const cleaned = stripMarkdown(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(extractJson(cleaned, 'fixes'));
    } catch {
      throw new Error(`Unable to parse AI response as JSON: ${cleaned.slice(0, 200)}`);
    }
  }
}

function parseRaw(raw: string): unknown {
  const cleaned = stripMarkdown(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    // try to repair the cleaned string first
    try {
      const repaired = repairJson(cleaned);
      return JSON.parse(repaired);
    } catch {
      // fallback: extract JSON boundaries
      const extracted = extractJson(cleaned);
      try {
        return JSON.parse(extracted);
      } catch {
        // try to repair the extracted boundaries as a last resort
        try {
          const repairedExtracted = repairJson(extracted);
          return JSON.parse(repairedExtracted);
        } catch {
          throw new Error(`Unable to parse AI response as JSON: ${cleaned.slice(0, 200)}`);
        }
      }
    }
  }
}

export interface IOutputParser {
  parse(rawText: string): ReviewResult;
}

export interface IFixOutputParser {
  parseFix(rawText: string): FixResult;
}

export class ParserService implements IOutputParser, IFixOutputParser {
  parseFix(rawText: string): FixResult {
    if (!rawText.trim()) {
      logger.warn('AI returned empty fix response');
      return { fixes: [] };
    }

    let parsed: unknown;
    try {
      parsed = parseStrict(rawText);
    } catch (err) {
      logger.error('Failed to parse AI fix response', err instanceof Error ? err : new Error(String(err)));
      return { fixes: [] };
    }

    if (!validateFix(parsed)) {
      logger.warn('AI fix response failed schema validation', undefined, { errors: validateFix.errors });
      return { fixes: [] };
    }

    const raw = parsed as { fixes: unknown[] };
    const valid: FileFix[] = [];
    let dropped = 0;

    for (const item of raw.fixes) {
      if (validateFixItem(item)) {
        const fix = item as unknown as FileFix;
        let normalizedPath = fix.filePath.trim();
        if (normalizedPath.startsWith('/')) {
          normalizedPath = normalizedPath.substring(1);
        } else if (normalizedPath.startsWith('./')) {
          normalizedPath = normalizedPath.substring(2);
        }
        fix.filePath = normalizedPath;
        valid.push(fix);
      } else {
        dropped++;
      }
    }

    if (dropped > 0) {
      logger.warn(`Dropped ${dropped} invalid fix(es) from AI response`);
    }

    logger.info('AI fix response parsed', undefined, { total: raw.fixes.length, valid: valid.length, dropped });

    return { fixes: valid };
  }

  parse(rawText: string): ReviewResult {
    if (!rawText.trim()) {
      logger.warn('AI returned empty response');
      return { comments: [] };
    }

    let parsed: unknown;
    try {
      parsed = parseRaw(rawText);
    } catch (err) {
      logger.error('Failed to parse AI response', err instanceof Error ? err : new Error(String(err)));
      return { comments: [] };
    }

    if (!validateReview(parsed)) {
      logger.warn('AI response failed schema validation', undefined, {
        errors: validateReview.errors,
      });
      return { comments: [] };
    }

    const raw = parsed as { comments: unknown[] };
    const valid: AiReviewComment[] = [];
    let dropped = 0;

    for (const item of raw.comments) {
      if (validateComment(item)) {
        const comment = item as unknown as AiReviewComment;
        let normalizedPath = comment.filePath.trim();
        if (normalizedPath.startsWith('/')) {
          normalizedPath = normalizedPath.substring(1);
        } else if (normalizedPath.startsWith('./')) {
          normalizedPath = normalizedPath.substring(2);
        }
        comment.filePath = normalizedPath;
        valid.push(comment);
      } else {
        dropped++;
      }
    }

    if (dropped > 0) {
      logger.warn(`Dropped ${dropped} invalid comment(s) from AI response`);
    }

    logger.info('AI response parsed', undefined, { total: raw.comments.length, valid: valid.length, dropped });

    return { comments: valid };
  }
}

export const parserService = new ParserService();
