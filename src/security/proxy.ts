/**
 * Enterprise Proxy & TLS Compliance Resolver.
 *
 * Resolves corporate HTTP/HTTPS forward proxies, custom CA trust bundles, and
 * bypass domains for compliance with enterprise egress security policies
 * (Zscaler, Netskope, BlueCoat, corporate SSL inspection).
 */

export interface ProxyConfiguration {
  readonly proxyUrl: string | null;
  readonly strictSsl: boolean;
  readonly noProxy: readonly string[];
  readonly customCaPath: string | null;
}

export class EnterpriseProxyResolver {
  /**
   * Resolves proxy settings from environment variables and explicit overrides.
   */
  resolve(options?: {
    vscodeProxy?: string | undefined;
    strictSsl?: boolean | undefined;
  }): ProxyConfiguration {
    const envProxy =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      process.env.ALL_PROXY ??
      null;

    const proxyUrl = options?.vscodeProxy || envProxy || null;
    const strictSsl = options?.strictSsl ?? process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

    const noProxyRaw = process.env.NO_PROXY ?? process.env.no_proxy ?? 'localhost,127.0.0.1,::1';
    const noProxy = noProxyRaw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const customCaPath = process.env.NODE_EXTRA_CA_CERTS ?? null;

    return {
      proxyUrl,
      strictSsl,
      noProxy,
      customCaPath,
    };
  }

  /**
   * Evaluates if a given URL should bypass the corporate proxy based on NO_PROXY rules.
   */
  shouldBypassProxy(url: string, noProxyRules: readonly string[]): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      for (const rule of noProxyRules) {
        if (rule === '*') return true;
        if (rule.startsWith('.')) {
          if (hostname.endsWith(rule) || hostname === rule.slice(1)) return true;
        } else if (hostname === rule || hostname.endsWith(`.${rule}`)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}

export const proxyResolver = new EnterpriseProxyResolver();
