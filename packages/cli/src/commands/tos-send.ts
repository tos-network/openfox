/**
 * automaton-cli tos-send <to-address> <amount> [--wait]
 *
 * Send a native TOS transfer using the automaton's wallet.
 * Amount is interpreted as whole TOS with up to 18 decimals.
 */

import { loadConfig } from "@conway/automaton/config.js";
import { loadWalletPrivateKey } from "@conway/automaton/identity/wallet.js";
import { normalizeTOSAddress } from "@conway/automaton/tos/address.js";
import { parseTOSAmount, sendTOSNativeTransfer } from "@conway/automaton/tos/client.js";

const args = process.argv.slice(3);
const toAddress = args[0];
const amount = args[1];
const waitForReceipt = args.includes("--wait");
const rpcFlagIndex = args.indexOf("--rpc");
const rpcFromFlag = rpcFlagIndex >= 0 ? args[rpcFlagIndex + 1] : undefined;

if (!toAddress || !amount) {
  console.log("Usage: automaton-cli tos-send <to-address> <amount> [--wait] [--rpc http://127.0.0.1:8545]");
  console.log("Example:");
  console.log("  automaton-cli tos-send 0xabc... 1.25 --wait");
  process.exit(1);
}

const config = loadConfig();
if (!config) {
  console.log("No automaton configuration found.");
  process.exit(1);
}

const privateKey = loadWalletPrivateKey();
if (!privateKey) {
  console.log("No automaton wallet found.");
  process.exit(1);
}

const rpcUrl = rpcFromFlag || config.tosRpcUrl || process.env.TOS_RPC_URL;
if (!rpcUrl) {
  console.log("No TOS RPC URL configured. Set TOS_RPC_URL or add tosRpcUrl to automaton config.");
  process.exit(1);
}

try {
  const normalizedTo = normalizeTOSAddress(toAddress);
  const amountWei = parseTOSAmount(amount);
  const { signed, txHash, receipt } = await sendTOSNativeTransfer({
    rpcUrl,
    privateKey,
    to: normalizedTo,
    amountWei,
    waitForReceipt,
  });

  console.log(`
TOS transfer submitted.
To:         ${normalizedTo}
Amount:     ${amount} TOS
Nonce:      ${signed.nonce.toString()}
Gas:        ${signed.gas.toString()}
Tx hash:    ${txHash}
Raw tx:     ${signed.rawTransaction}
${receipt ? `Receipt:    ${JSON.stringify(receipt, null, 2)}` : ""}
`);
} catch (error) {
  console.log(`TOS transfer failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
