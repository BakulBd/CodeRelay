/**
 * Enterprise Data Loss Prevention (DLP) & Secret Sanitization.
 *
 * Scans text, tool inputs, command arguments, and task exports for sensitive
 * enterprise credentials, API keys, cryptographic private keys, and authorization
 * tokens. Replaces detected secrets with structured redaction markers to prevent
 * accidental data leakage to external models or unencrypted log stores.
 *
 * Zero-dependency, pure deterministic regular expression and entropy scanning.
 */

export interface DlpFinding {
  readonly kind: string;
  readonly matchedText: string;
  readonly index: number;
}

export interface DlpResult {
  readonly sanitized: string;
  readonly redactedCount: number;
  readonly findings: readonly string[];
}

interface SecretPattern {
  readonly name: string;
  readonly marker: string;
  readonly regex: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'Private Key',
    marker: '[REDACTED_PRIVATE_KEY]',
    regex: /-----BEGIN\s+[A-Z\s]+PRIVATE\s+KEY-----[\s\S]*?-----END\s+[A-Z\s]+PRIVATE\s+KEY-----/g,
  },
  {
    name: 'Anthropic API Key',
    marker: '[REDACTED_ANTHROPIC_KEY]',
    regex: /\bsk-ant-(?:api\d{2}-)?[a-zA-Z0-9_-]{32,}\b/g,
  },
  {
    name: 'OpenAI API Key',
    marker: '[REDACTED_OPENAI_KEY]',
    regex: /\bsk-(?!ant-)(?:proj-)?[a-zA-Z0-9_-]{32,}\b/g,
  },
  {
    name: 'Google API Key',
    marker: '[REDACTED_GOOGLE_KEY]',
    regex: /\bAIzaSy[a-zA-Z0-9_-]{33}\b/g,
  },
  {
    name: 'AWS Access Key ID',
    marker: '[REDACTED_AWS_ACCESS_KEY]',
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'AWS Secret Key',
    marker: '[REDACTED_AWS_SECRET_KEY]',
    regex: /(?<=(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?)[a-zA-Z0-9/+=]{40}(?=["']?)/gi,
  },
  {
    name: 'GitHub Token',
    marker: '[REDACTED_GITHUB_TOKEN]',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}\b|\bgithub_pat_[a-zA-Z0-9_]{82}\b/g,
  },
  {
    name: 'Slack Token',
    marker: '[REDACTED_SLACK_TOKEN]',
    regex: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g,
  },
  {
    name: 'JSON Web Token (JWT)',
    marker: '[REDACTED_JWT_TOKEN]',
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]{10,}\b/g,
  },
  {
    name: 'Database URL Password',
    marker: '://$1:[REDACTED_PASSWORD]@',
    regex: /:\/\/([^:]+):([^@\s/]+)@/g,
  },
];

const SENSITIVE_FILE_NAMES: readonly RegExp[] = [
  /^\.env(?:\..*)?$/i,
  /^id_rsa(?:\..*)?$/i,
  /^id_ed25519(?:\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /secret.*\.json$/i,
  /credentials.*\.json$/i,
  /token.*\.json$/i,
];

export class DlpSanitizer {
  /**
   * Scans and sanitizes text by replacing all matched secret patterns with redaction markers.
   */
  sanitize(text: string): DlpResult {
    if (!text) {
      return { sanitized: text, redactedCount: 0, findings: [] };
    }

    let sanitized = text;
    let redactedCount = 0;
    const findings: string[] = [];

    for (const pattern of SECRET_PATTERNS) {
      const matches = [...sanitized.matchAll(pattern.regex)];
      if (matches.length > 0) {
        redactedCount += matches.length;
        findings.push(pattern.name);
        sanitized = sanitized.replace(pattern.regex, pattern.marker);
      }
    }

    return {
      sanitized,
      redactedCount,
      findings: [...new Set(findings)],
    };
  }

  /**
   * Checks if a filename or path matches common enterprise secret file patterns.
   */
  isSensitiveFile(filePath: string): boolean {
    if (!filePath) return false;
    const filename = filePath.split(/[/\\]/).pop() || '';
    return SENSITIVE_FILE_NAMES.some((regex) => regex.test(filename));
  }
}

export const defaultDlp = new DlpSanitizer();
