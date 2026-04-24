export function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

export function accumulateText(current: string, newText: string): string {
  return current + newText;
}

export function parseCodexOutput(buffer: string): string {
  return stripAnsi(buffer);
}

export function buildContextHeader(branchName: string, modelName: string): string {
  return `🌿 \`${branchName}\` · 🤖 \`${modelName}\``;
}


export function formatOutput(buffer: string, maxLength: number = 1900): string {
  const parsed = parseCodexOutput(buffer);
  
  if (!parsed.trim()) {
    return '⏳ Processing...';
  }

  if (parsed.length <= maxLength) {
    return parsed;
  }
  
  return '...(truncated)...\n\n' + parsed.slice(-maxLength);
}

export interface FormattedResult {
  /** Message chunks to send (first chunk goes in the main edited message, rest as follow-up sends) */
  chunks: string[];
}

const MESSAGE_MAX_LENGTH = 1900;

/**
 * Split text into chunks that fit within Discord's message limit.
 * Splits on paragraph boundaries (double newline) when possible.
 */
function splitIntoChunks(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary (double newline)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      // Fallback: split at single newline
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      // Last resort: hard split at maxLength
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n+/, '');
  }

  return chunks;
}

export function formatOutputForMobile(buffer: string): FormattedResult {
  const parsed = parseCodexOutput(buffer);
  
  if (!parsed.trim()) {
    return { chunks: ['⏳ Processing...'] };
  }

  const chunks = splitIntoChunks(parsed, MESSAGE_MAX_LENGTH);
  return { chunks };
}
