/**
 * Privacy Routing & Sensitive File Filter.
 *
 * Ensures that sensitive project artifacts (.env, credentials, private keys) are never
 * transmitted to external AI endpoints, and enforces user privacy policies (e.g. Local Only).
 */

export type PrivacyMode = 'cloud_and_local' | 'cloud_only' | 'local_only' | 'no_retention';

const SENSITIVE_PATTERNS = [
  /(?:^|[\\/])\.env(?:\..+)?$/i,
  /(?:^|[\\/]).*id_rsa(?:\.pub)?$/i,
  /(?:^|[\\/]).*\.pem$/i,
  /(?:^|[\\/]).*\.key$/i,
  /(?:^|[\\/])credentials\.json$/i,
  /(?:^|[\\/])secrets\..+$/i,
];

export function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function filterSensitiveFiles(filePaths: readonly string[]): {
  readonly safeFiles: readonly string[];
  readonly blockedFiles: readonly string[];
} {
  const safeFiles: string[] = [];
  const blockedFiles: string[] = [];

  for (const file of filePaths) {
    if (isSensitivePath(file)) {
      blockedFiles.push(file);
    } else {
      safeFiles.push(file);
    }
  }

  return { safeFiles, blockedFiles };
}

export function allowsCloudProvider(mode: PrivacyMode): boolean {
  return mode !== 'local_only';
}
