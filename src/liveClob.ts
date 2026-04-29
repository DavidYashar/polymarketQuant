import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import type { ApiKeyCreds, Chain } from "@polymarket/clob-client/dist/types";

export type ClobAuth = ApiKeyCreds;

function looksLikeCreds(x: any): x is ApiKeyCreds {
  return Boolean(
    x &&
      typeof x === "object" &&
      typeof x.key === "string" &&
      typeof x.secret === "string" &&
      typeof x.passphrase === "string"
  );
}

export async function initClobClient(opts: {
  host: string;
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  auth?: Partial<ClobAuth>;
}): Promise<{ client: any; auth: ClobAuth }> {
  const signer = new Wallet(opts.privateKey);
  const chainId = opts.chainId as unknown as Chain;

  const providedKey = opts.auth?.key;
  const providedSecret = opts.auth?.secret;
  const providedPassphrase = opts.auth?.passphrase;

  if (providedKey && providedSecret && providedPassphrase) {
    const creds: ApiKeyCreds = {
      key: providedKey,
      secret: providedSecret,
      passphrase: providedPassphrase,
    };
    const authed: any = new (ClobClient as any)(
      opts.host,
      chainId,
      signer,
      creds,
      opts.signatureType,
      opts.funderAddress
    );
    return { client: authed, auth: creds };
  }

  const l1: any = new (ClobClient as any)(
    opts.host,
    chainId,
    signer,
    undefined,
    opts.signatureType,
    opts.funderAddress
  );

  let derived: ApiKeyCreds | null = null;

  const tryDerive = async () => {
    const r = await l1.deriveApiKey();
    if (looksLikeCreds(r)) derived = r;
  };

  const tryCreate = async () => {
    const r = await l1.createApiKey();
    if (looksLikeCreds(r)) derived = r;
  };

  try {
    await tryDerive();
  } catch {
    // ignore
  }

  if (!derived) {
    try {
      await tryCreate();
    } catch {
      // ignore
    }
  }

  if (!derived) {
    try {
      await tryDerive();
    } catch {
      // ignore
    }
  }

  if (!derived) {
    throw new Error(
      "Failed to derive/create POLY API credentials. Set POLY_API_KEY/POLY_API_SECRET/POLY_API_PASSPHRASE and retry."
    );
  }

  const authed: any = new (ClobClient as any)(
    opts.host,
    chainId,
    signer,
    derived,
    opts.signatureType,
    opts.funderAddress
  );

  return { client: authed, auth: derived };
}
