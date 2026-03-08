/**
 * openfox-cli tos-status
 *
 * Show TOS wallet address, configured RPC, and current on-chain balance if available.
 */

import { loadConfig } from "@openfox/openfox/config.js";
import { loadWalletPrivateKey } from "@openfox/openfox/identity/wallet.js";
import { deriveTOSAddressFromPrivateKey } from "@openfox/openfox/tos/address.js";
import { TOSRpcClient, formatTOSNetwork } from "@openfox/openfox/tos/client.js";

const config = loadConfig();
if (!config) {
  console.log("No openfox configuration found.");
  process.exit(1);
}

const privateKey = loadWalletPrivateKey();
if (!privateKey) {
  console.log("No openfox wallet found.");
  process.exit(1);
}

const tosAddress = deriveTOSAddressFromPrivateKey(privateKey);
const rpcUrl = config.tosRpcUrl || process.env.TOS_RPC_URL;

console.log(`
=== ${config.name} TOS Wallet ===
TOS Address:  ${tosAddress}
RPC URL:      ${rpcUrl || "not configured"}
`);

if (!rpcUrl) {
  process.exit(0);
}

try {
  const client = new TOSRpcClient({ rpcUrl });
  const [chainId, balanceWei, nonce] = await Promise.all([
    client.getChainId(),
    client.getBalance(tosAddress, "latest"),
    client.getTransactionCount(tosAddress, "pending"),
  ]);

  const balance = Number(balanceWei) / 1e18;

  console.log(`Network:      ${formatTOSNetwork(chainId)}`);
  console.log(`Balance:      ${balance.toFixed(6)} TOS`);
  console.log(`Pending nonce:${nonce.toString()}`);
} catch (error) {
  console.log(`TOS RPC check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
