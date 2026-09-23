import '../mocks/env.js';
import { describe, it, expect } from 'vitest';
import { ParserService } from '../../src/application/services/parser.service.js';

const parser = new ParserService();

const VALID_COMMENT = {
  filePath: 'src/auth.ts',
  lineNumber: 10,
  message: 'Potential SQL injection',
  severity: 'CRITICAL',
};

describe('ParserService.parse', () => {
  it('parses valid JSON response', () => {
    const raw = JSON.stringify({ comments: [VALID_COMMENT] });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject(VALID_COMMENT);
  });

  it('returns empty comments for empty string', () => {
    expect(parser.parse('').comments).toHaveLength(0);
  });

  it('returns empty comments for whitespace only', () => {
    expect(parser.parse('   ').comments).toHaveLength(0);
  });

  it('strips markdown code block wrapper', () => {
    const raw = '```json\n' + JSON.stringify({ comments: [VALID_COMMENT] }) + '\n```';
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(1);
  });

  it('strips markdown code block without json tag', () => {
    const raw = '```\n' + JSON.stringify({ comments: [VALID_COMMENT] }) + '\n```';
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(1);
  });

  it('extracts JSON embedded in prose', () => {
    const raw = `Here is my analysis: ${JSON.stringify({ comments: [VALID_COMMENT] })} End.`;
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(1);
  });

  it('returns empty for completely invalid input', () => {
    const result = parser.parse('not json at all !!!');
    expect(result.comments).toHaveLength(0);
  });

  it('drops comments missing required filePath', () => {
    const raw = JSON.stringify({ comments: [{ lineNumber: 1, message: 'x', severity: 'INFO' }] });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(0);
  });

  it('drops comments missing lineNumber', () => {
    const raw = JSON.stringify({ comments: [{ filePath: 'x.ts', message: 'x', severity: 'INFO' }] });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(0);
  });

  it('drops comments with invalid severity', () => {
    const raw = JSON.stringify({ comments: [{ ...VALID_COMMENT, severity: 'BLOCKER' }] });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(0);
  });

  it('keeps valid comments and drops invalid ones from same array', () => {
    const raw = JSON.stringify({
      comments: [
        VALID_COMMENT,
        { filePath: 'x.ts' },
        { ...VALID_COMMENT, filePath: 'src/other.ts', lineNumber: 20, severity: 'WARNING' },
      ],
    });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(2);
  });

  it('handles response with zero comments', () => {
    const raw = JSON.stringify({ comments: [] });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(0);
  });

  it('accepts all valid severity levels', () => {
    for (const severity of ['INFO', 'WARNING', 'CRITICAL']) {
      const raw = JSON.stringify({ comments: [{ ...VALID_COMMENT, severity }] });
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
    }
  });

  it('normalizes leading slashes and dot-slashes in filePath', () => {
    const raw = JSON.stringify({
      comments: [
        { ...VALID_COMMENT, filePath: '/src/auth.ts' },
        { ...VALID_COMMENT, filePath: './src/db.ts' },
      ],
    });
    const result = parser.parse(raw);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]?.filePath).toBe('src/auth.ts');
    expect(result.comments[1]?.filePath).toBe('src/db.ts');
  });

  describe('JSON repair fallback', () => {
    it('repairs JSON with unescaped double quotes inside values', () => {
      const raw = '{"comments": [{"filePath": "src/app.ts", "lineNumber": 10, "message": "Avoid "var" declarations and use "const"", "severity": "WARNING"}]}';
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.message).toBe('Avoid "var" declarations and use "const"');
    });

    it('repairs JSON with literal newlines inside string values', () => {
      const raw = '{"comments": [\n  {\n    "filePath": "src/app.ts",\n    "lineNumber": 10,\n    "message": "Line 1\nLine 2",\n    "severity": "WARNING"\n  }\n]}';
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.message).toBe('Line 1\nLine 2');
    });

    it('repairs JSON with trailing commas', () => {
      const raw = '{"comments": [{"filePath": "src/app.ts", "lineNumber": 10, "message": "test", "severity": "WARNING",},],}';
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.message).toBe('test');
    });

    it('repairs truncated JSON by balancing braces/brackets', () => {
      const raw = '{"comments": [{"filePath": "src/app.ts", "lineNumber": 10, "message": "test", "severity": "WARNING"';
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.message).toBe('test');
    });

    it('repairs the specific user reported error case', () => {
      // Simulate the exact kind of raw output we had in the error report
      const raw = '{"comments": [{"filePath": "src/components/VideoForm.vue", "lineNumber": 42, "message": "[488px] !rounded-lg !overflow-hidden mt-4"\n+          />\n+        </ClientOnly>\n         :error-message="formErrors.thumbnail"\n       >\nWait, where did `</UiFormGroup>` and `<UiFormGroup label="Video ", "severity": "CRITICAL"}]}';
      const result = parser.parse(raw);
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.filePath).toBe('src/components/VideoForm.vue');
      expect(result.comments[0]?.lineNumber).toBe(42);
      expect(result.comments[0]?.severity).toBe('CRITICAL');
      expect(result.comments[0]?.message).toContain('Wait, where did `</UiFormGroup>` and `<UiFormGroup label="Video ');
    });
  });
});

describe('ParserService.parseFix', () => {
  it('rejects a truncated fix instead of repairing it into a partial file', () => {
    const raw = '{"fixes":[{"filePath":"src/a.ts","content":"line1\\nfunction foo() {\\n  retu';
    expect(parser.parseFix(raw).fixes).toHaveLength(0);
  });

  it('still accepts a complete fix wrapped in leading prose', () => {
    const raw = 'Here you go: {"fixes":[{"filePath":"src/a.ts","content":"ok\\n"}]}';
    expect(parser.parseFix(raw).fixes).toEqual([{ filePath: 'src/a.ts', content: 'ok\n' }]);
  });

  it('parses valid fix JSON response', () => {
    const raw = JSON.stringify({ fixes: [{ filePath: 'src/auth.ts', content: 'export const x = 1;' }] });
    const result = parser.parseFix(raw);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]).toMatchObject({ filePath: 'src/auth.ts', content: 'export const x = 1;' });
  });

  it('returns empty fixes for empty string', () => {
    expect(parser.parseFix('').fixes).toHaveLength(0);
  });

  it('returns empty fixes for completely invalid input', () => {
    expect(parser.parseFix('not json at all !!!').fixes).toHaveLength(0);
  });

  it('drops fixes missing content', () => {
    const raw = JSON.stringify({ fixes: [{ filePath: 'src/auth.ts' }] });
    const result = parser.parseFix(raw);
    expect(result.fixes).toHaveLength(0);
  });

  it('drops fixes missing filePath', () => {
    const raw = JSON.stringify({ fixes: [{ content: 'x' }] });
    const result = parser.parseFix(raw);
    expect(result.fixes).toHaveLength(0);
  });

  it('normalizes leading slashes and dot-slashes in filePath', () => {
    const raw = JSON.stringify({
      fixes: [
        { filePath: '/src/auth.ts', content: 'a' },
        { filePath: './src/db.ts', content: 'b' },
      ],
    });
    const result = parser.parseFix(raw);
    expect(result.fixes[0]?.filePath).toBe('src/auth.ts');
    expect(result.fixes[1]?.filePath).toBe('src/db.ts');
  });

  it('strips markdown code block wrapper', () => {
    const raw = '```json\n' + JSON.stringify({ fixes: [{ filePath: 'a.ts', content: 'x' }] }) + '\n```';
    const result = parser.parseFix(raw);
    expect(result.fixes).toHaveLength(1);
  });

  it('handles response with zero fixes', () => {
    const raw = JSON.stringify({ fixes: [] });
    const result = parser.parseFix(raw);
    expect(result.fixes).toHaveLength(0);
  });
});
