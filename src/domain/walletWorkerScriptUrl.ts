interface TrustedScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface TrustedTypesFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): TrustedScriptUrlPolicy;
}

type GlobalWithTrustedTypes = typeof globalThis & {
  trustedTypes?: TrustedTypesFactory;
};

let walletWorkerPolicy: TrustedScriptUrlPolicy | null = null;
let walletWorkerSourceUrl: string | null = null;

function requireSameOriginHttpUrl(input: string): string {
  const candidate = new URL(input, globalThis.location.href);
  if (
    candidate.origin !== globalThis.location.origin
    || (candidate.protocol !== "https:" && candidate.protocol !== "http:")
    || candidate.username !== ""
    || candidate.password !== ""
  ) {
    throw new TypeError("Wallet worker URL must be a same-origin HTTP(S) URL");
  }
  return candidate.href;
}

/**
 * Produces the sole script URL accepted by the wallet's Trusted Types policy.
 *
 * The policy is deliberately private to this module and only accepts the
 * statically bundled, same-origin worker URL supplied by the caller. The
 * return type is `unknown` because TypeScript's DOM library does not expose
 * TrustedScriptURL, while the browser's Worker constructor accepts it when
 * `require-trusted-types-for 'script'` is active.
 */
export function walletWorkerScriptUrl(source: URL): unknown {
  const sourceUrl = requireSameOriginHttpUrl(source.href);
  const trustedTypes = (globalThis as GlobalWithTrustedTypes).trustedTypes;
  if (!trustedTypes) return new URL(sourceUrl);

  if (walletWorkerSourceUrl !== null && walletWorkerSourceUrl !== sourceUrl) {
    throw new TypeError("Wallet worker URL does not match the pinned asset");
  }
  walletWorkerSourceUrl ??= sourceUrl;
  walletWorkerPolicy ??= trustedTypes.createPolicy("zylith-wallet-worker", {
    createScriptURL(input) {
      const candidate = requireSameOriginHttpUrl(input);
      if (candidate !== walletWorkerSourceUrl) {
        throw new TypeError("Wallet worker URL does not match the pinned asset");
      }
      return candidate;
    },
  });
  return walletWorkerPolicy.createScriptURL(sourceUrl);
}
