import { describe, expect, it } from 'vitest';
import {
  accumulateText,
  buildContextHeader,
  formatOutput,
  formatOutputForMobile,
  stripAnsi,
} from '../utils/messageFormatter.js';

describe('messageFormatter', () => {
  describe('stripAnsi', () => {
    it('removes ANSI escape codes', () => {
      const input = '\x1B[31mHello\x1B[0m \x1B[1mWorld\x1B[0m';
      expect(stripAnsi(input)).toBe('Hello World');
    });
  });

  describe('accumulateText', () => {
    it('appends new text to current text', () => {
      expect(accumulateText('Hello', ' World')).toBe('Hello World');
    });
  });

  describe('buildContextHeader', () => {
    it('formats branch name and model name', () => {
      const result = buildContextHeader('feature/dark-mode', 'gpt-5.5');
      expect(result).toBe('🌿 `feature/dark-mode` · 🤖 `gpt-5.5`');
    });
  });

  describe('formatOutput', () => {
    it('returns processing text for empty output', () => {
      expect(formatOutput('')).toBe('⏳ Processing...');
    });

    it('preserves Codex streamed plain text', () => {
      expect(formatOutput('Line1\nLine2\nLine3')).toBe('Line1\nLine2\nLine3');
    });

    it('truncates long output from the end', () => {
      const result = formatOutput('a'.repeat(20), 5);
      expect(result).toBe('...(truncated)...\n\naaaaa');
    });
  });

  describe('formatOutputForMobile', () => {
    it('splits long output into Discord-sized chunks', () => {
      const result = formatOutputForMobile(`first\n\n${'a'.repeat(2000)}`);
      expect(result.chunks.length).toBeGreaterThan(1);
    });
  });
});
