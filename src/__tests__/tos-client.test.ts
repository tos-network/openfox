import { describe, expect, it } from "vitest";
import { deriveTOSAddressFromPrivateKey, normalizeTOSAddress } from "../tos/address.js";
import { signTOSNativeTransfer } from "../tos/client.js";

const TEST_PRIVATE_KEY =
  "0x45a915e4d060149eb4365960e6a7a45f334393093061116b197e3240065ff2d8" as const;

describe("TOS address", () => {
  it("derives 32-byte TOS address from secp256k1 private key", () => {
    expect(deriveTOSAddressFromPrivateKey(TEST_PRIVATE_KEY)).toBe(
      "0xfa7a3e1ddd55862136c8b192a94f5374fce5edbc8e2a8697c15331677e6ebf0b",
    );
  });

  it("normalizes short hex addresses by left-padding to 32 bytes", () => {
    expect(normalizeTOSAddress("0x1234")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000001234",
    );
  });
});

describe("TOS signer tx", () => {
  it("matches the TOS golden vector for secp256k1", async () => {
    const signed = await signTOSNativeTransfer(TEST_PRIVATE_KEY, {
      chainId: 1337n,
      nonce: 42n,
      gas: 50_000n,
      to: "0x1111111111111111111111111111111111111111111111111111111111111111",
      value: 12_345n,
      data: "0x11223344aabb",
    });

    expect(signed.from).toBe(
      "0xfa7a3e1ddd55862136c8b192a94f5374fce5edbc8e2a8697c15331677e6ebf0b",
    );
    expect(signed.signHash).toBe(
      "0xe68ae0c80358ac0697df00251101167aea3c3d8019d72930f1c6a9314dc5ecb0",
    );
    expect(signed.rawTransaction).toBe(
      "0x00f8a18205392a82c350a011111111111111111111111111111111111111111111111111111111111111118230398611223344aabbc0a0fa7a3e1ddd55862136c8b192a94f5374fce5edbc8e2a8697c15331677e6ebf0b89736563703235366b3180a0b73152870204b00af67d5425a440e605d202090aa52ded6c52b38be889368edfa0736160d5066f1d853c7597fac8ba9c8670877041e77a5b420ca19d384c3ebd71",
    );
    expect(signed.transactionHash).toBe(
      "0x0e558f3142dd1941c13358fc738b9462db391ea5bc27ab4bbdd7f188e0da99c3",
    );
  });
});
