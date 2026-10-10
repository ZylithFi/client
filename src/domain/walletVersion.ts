export const WALLET_KEY_SCHEDULE_VERSION = 2 as const;

export class WalletMigrationRequiredError extends Error {
  constructor() {
    super("Wallet migration required. Existing wallet records were preserved.");
    this.name = "WalletMigrationRequiredError";
  }
}

export function requireWalletKeyScheduleVersion(value: unknown): asserts value is Record<string, unknown> & { key_schedule_version: 2 } {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, "key_schedule_version")
    || Object.keys(value).some((key) => key !== "key_schedule_version" && key.replace(/[^a-z]/gi, "").toLowerCase() === "keyscheduleversion")
    || (value as Record<string, unknown>).key_schedule_version !== WALLET_KEY_SCHEDULE_VERSION) {
    throw new WalletMigrationRequiredError();
  }
}

/** rejects duplicate decoded keys before json parsing can discard an earlier version. */
export function parseWalletJson(source: string, integerFields: readonly string[] = []): unknown {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new WalletMigrationRequiredError();
  }
  const stack: Array<{ keys: Set<string>; expectsKey: boolean } | null> = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]/g)) {
    const token = match[0];
    if (token === "{") stack.push({ keys: new Set(), expectsKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else {
      const object = stack.at(-1);
      if (!object) continue;
      if (token === ",") object.expectsKey = true;
      else if (token.startsWith('"') && object.expectsKey) {
        const key = JSON.parse(token) as string;
        if (object.keys.has(key)) throw new WalletMigrationRequiredError();
        if (key === "key_schedule_version" && !/^\s*:\s*2\s*[,}]/.test(source.slice(match.index + token.length))) {
          throw new WalletMigrationRequiredError();
        }
        if (integerFields.includes(key) && !/^\s*:\s*(?:0|[1-9][0-9]*)\s*[,}]/.test(source.slice(match.index + token.length))) {
          throw new WalletMigrationRequiredError();
        }
        object.keys.add(key);
        object.expectsKey = false;
      }
    }
  }
  return value;
}

export function walletVersionAad() {
  return new TextEncoder().encode("zylith/wallet-key-schedule/v2");
}
