import {
  canonicalizeStorageAnchorSummary,
  hashStorageAnchorSummary,
  toHex,
  type Address,
  type Hex,
  type StorageAnchorSummary,
} from "tosdk";
import { sendTOSNativeTransfer } from "../tos/client.js";
import type {
  OpenFoxDatabase,
  StorageAnchorConfig,
  StorageAnchorRecord,
  StorageLeaseRecord,
} from "../types.js";

export interface StorageAnchorPublisher {
  publish(input: {
    lease: StorageLeaseRecord;
    publisherAddress: Address;
    subjectId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageAnchorRecord>;
}

export function buildStorageAnchorRecord(input: {
  lease: StorageLeaseRecord;
  publisherAddress: Address;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}): StorageAnchorRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const summary: StorageAnchorSummary = {
    version: 1,
    anchorId: `storage:${input.lease.leaseId}`,
    leaseId: input.lease.leaseId,
    cid: input.lease.cid,
    bundleHash: input.lease.bundleHash,
    providerAddress: input.lease.providerAddress,
    requesterAddress: input.lease.requesterAddress,
    leaseRoot: input.lease.receiptHash,
    expiresAt: input.lease.receipt.expiresAt,
    createdAt,
    metadata: input.metadata,
  };
  return {
    anchorId: summary.anchorId,
    leaseId: input.lease.leaseId,
    summary,
    summaryHash: hashStorageAnchorSummary(summary),
    anchorTxHash: null,
    anchorReceipt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function createNativeStorageAnchorPublisher(params: {
  db: OpenFoxDatabase;
  rpcUrl: string;
  privateKey: `0x${string}`;
  config: StorageAnchorConfig;
  publisherAddress: Address;
  now?: () => Date;
}): StorageAnchorPublisher {
  const now = params.now ?? (() => new Date());
  return {
    async publish(input) {
      const nextRecord = buildStorageAnchorRecord({
        lease: input.lease,
        publisherAddress: input.publisherAddress,
        createdAt: now().toISOString(),
        metadata: input.metadata,
      });
      const existing = params.db.getStorageAnchorByLeaseId(input.lease.leaseId);
      if (existing && existing.summaryHash === nextRecord.summaryHash && existing.anchorTxHash) {
        return existing;
      }
      const transfer = await sendTOSNativeTransfer({
        rpcUrl: params.rpcUrl,
        privateKey: params.privateKey,
        to: params.config.sinkAddress || params.publisherAddress,
        amountWei: 0n,
        gas: BigInt(params.config.gas),
        data: toHex(canonicalizeStorageAnchorSummary(nextRecord.summary)),
        waitForReceipt: params.config.waitForReceipt,
        receiptTimeoutMs: params.config.receiptTimeoutMs,
      });
      const published: StorageAnchorRecord = {
        ...nextRecord,
        anchorTxHash: transfer.txHash as Hex,
        anchorReceipt: transfer.receipt ?? null,
        updatedAt: now().toISOString(),
      };
      params.db.upsertStorageAnchor(published);
      return published;
    },
  };
}
