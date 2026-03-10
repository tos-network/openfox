import type { PrivateKeyAccount } from "tosdk";
import { x402Fetch } from "../runtime/x402.js";
import type { Address } from "tosdk";

export interface RemoteSignerQuoteInput {
  providerBaseUrl: string;
  requesterAddress: Address;
  target: Address;
  valueWei?: string;
  data?: `0x${string}`;
  gas?: string;
  reason?: string;
}

export interface RemoteSignerSubmitInput extends RemoteSignerQuoteInput {
  quoteId: string;
  requestNonce: string;
  requestExpiresAt: number;
}

function buildBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function fetchSignerQuote(
  input: RemoteSignerQuoteInput,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${buildBaseUrl(input.providerBaseUrl)}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requester: {
        identity: {
          kind: "tos",
          value: input.requesterAddress,
        },
      },
      target: input.target,
      value_wei: input.valueWei ?? "0",
      ...(input.data ? { data: input.data } : {}),
      ...(input.gas ? { gas: input.gas } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`signer quote failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function submitSignerExecution(params: {
  providerBaseUrl: string;
  account: PrivateKeyAccount;
  rpcUrl: string;
  requesterAddress: Address;
  quoteId: string;
  target: Address;
  valueWei?: string;
  data?: `0x${string}`;
  gas?: string;
  requestNonce: string;
  requestExpiresAt: number;
  reason?: string;
}): Promise<{
  status?: number;
  body: Record<string, unknown>;
}> {
  const response = await x402Fetch(
    `${buildBaseUrl(params.providerBaseUrl)}/submit`,
    params.account,
    "POST",
    JSON.stringify({
      quote_id: params.quoteId,
      requester: {
        identity: {
          kind: "tos",
          value: params.requesterAddress,
        },
      },
      request_nonce: params.requestNonce,
      request_expires_at: params.requestExpiresAt,
      target: params.target,
      value_wei: params.valueWei ?? "0",
      ...(params.data ? { data: params.data } : {}),
      ...(params.gas ? { gas: params.gas } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    }),
    { "x-openfox-rpc-url": params.rpcUrl },
  );
  return {
    status: response.status,
    body: (response.response ?? {}) as Record<string, unknown>,
  };
}

export async function fetchSignerExecutionStatus(
  providerBaseUrl: string,
  executionId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${buildBaseUrl(providerBaseUrl)}/status/${encodeURIComponent(executionId)}`,
  );
  if (!response.ok) {
    throw new Error(`signer status failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchSignerExecutionReceipt(
  providerBaseUrl: string,
  executionId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${buildBaseUrl(providerBaseUrl)}/receipt/${encodeURIComponent(executionId)}`,
  );
  if (!response.ok) {
    throw new Error(`signer receipt failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
