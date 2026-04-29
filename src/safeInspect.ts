import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (name === "POLYGON_RPC_URL") return "https://polygon-rpc.com";
  throw new Error(`Missing required env var: ${name}`);
}

function isNonEmptyCode(code: string): boolean {
  const c = (code || "").toLowerCase();
  return c !== "0x" && c !== "0x0" && c.length > 2;
}

const SAFE_PROBE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function nonce() view returns (uint256)",
  "function getGuard() view returns (address)",
  "function VERSION() view returns (string)",
];

async function main(): Promise<void> {
  const privateKey = mustGetEnv("PRIVATE_KEY");
  const funderAddress = mustGetEnv("POLY_FUNDER_ADDRESS");
  const rpcUrl = mustGetEnv("POLYGON_RPC_URL");

  const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, { name: "matic", chainId: 137 });
  const wallet = new ethers.Wallet(privateKey, provider);

  const net = await provider.getNetwork();
  const code = await provider.getCode(funderAddress);

  console.log("--- Safe inspect ---");
  console.log(`RPC: ${rpcUrl}`);
  console.log(`ChainId: ${net.chainId}`);
  console.log(`POLY_FUNDER_ADDRESS: ${funderAddress}`);
  console.log(`HasBytecode: ${isNonEmptyCode(code)}`);
  console.log(`EOA(from PRIVATE_KEY): ${wallet.address}`);

  const safe = new ethers.Contract(funderAddress, SAFE_PROBE_ABI, provider);

  try {
    const [threshold, owners, nonce] = await Promise.all([
      safe.getThreshold() as Promise<ethers.BigNumber>,
      safe.getOwners() as Promise<string[]>,
      safe.nonce() as Promise<ethers.BigNumber>,
    ]);

    console.log(`Threshold: ${threshold.toString()}`);
    console.log(`Nonce: ${nonce.toString()}`);
    console.log(`Owners(${owners.length}):`);
    for (const o of owners) {
      const mark = o.toLowerCase() === wallet.address.toLowerCase() ? " <= PRIVATE_KEY" : "";
      console.log(`  - ${o}${mark}`);
    }
  } catch (e: any) {
    console.log(`Probe failed: ${e?.message ?? e}`);
  }

  try {
    const guard = (await safe.getGuard()) as string;
    console.log(`Guard: ${guard}`);
  } catch {
    console.log("Guard: (method not available)");
  }

  try {
    const v = (await safe.VERSION()) as string;
    console.log(`Version: ${v}`);
  } catch {
    console.log("Version: (method not available)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
