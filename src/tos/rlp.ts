import type { TOSAddress, HexString } from "./address.js";
import { tosAddressBytes } from "./address.js";

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

export function hexToBytes(value: HexString): Uint8Array {
  const hex = strip0x(value);
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${value}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error(`Negative bigint not supported in RLP: ${value}`);
  }
  if (value === 0n) {
    return new Uint8Array();
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return hexToBytes(`0x${hex}`);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLength(len: number): Uint8Array {
  if (len === 0) {
    return new Uint8Array([0]);
  }
  const bytes: number[] = [];
  let current = len;
  while (current > 0) {
    bytes.unshift(current & 0xff);
    current >>= 8;
  }
  return Uint8Array.from(bytes);
}

export function encodeRlpBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0] < 0x80) {
    return value;
  }
  if (value.length <= 55) {
    return concatBytes([Uint8Array.from([0x80 + value.length]), value]);
  }
  const lenBytes = encodeLength(value.length);
  return concatBytes([Uint8Array.from([0xb7 + lenBytes.length]), lenBytes, value]);
}

export function encodeRlpList(values: Uint8Array[]): Uint8Array {
  const payload = concatBytes(values);
  if (payload.length <= 55) {
    return concatBytes([Uint8Array.from([0xc0 + payload.length]), payload]);
  }
  const lenBytes = encodeLength(payload.length);
  return concatBytes([Uint8Array.from([0xf7 + lenBytes.length]), lenBytes, payload]);
}

export function encodeRlpAddress(address?: TOSAddress | null): Uint8Array {
  if (!address) {
    return encodeRlpBytes(new Uint8Array());
  }
  return encodeRlpBytes(tosAddressBytes(address));
}

export function encodeRlpUint(value: bigint | number): Uint8Array {
  const bigintValue = typeof value === "number" ? BigInt(value) : value;
  return encodeRlpBytes(bigintToMinimalBytes(bigintValue));
}

export function encodeRlpHex(value?: HexString): Uint8Array {
  return encodeRlpBytes(value ? hexToBytes(value) : new Uint8Array());
}

export function encodeRlpString(value: string): Uint8Array {
  return encodeRlpBytes(new TextEncoder().encode(value));
}
