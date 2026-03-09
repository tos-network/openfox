import { loadConfig } from "../config.js";
import { walletExists } from "../identity/wallet.js";
import { installManagedService } from "../service/daemon.js";
import { runSetupWizard } from "../setup/wizard.js";
import {
  fundWalletFromLocalDevnet,
  fundWalletFromTestnet,
} from "../wallet/operator.js";

export interface OnboardOptions {
  installDaemon?: boolean;
  forceSetup?: boolean;
  fundLocal?: boolean;
  fundTestnet?: boolean;
  waitForFundingReceipt?: boolean;
  faucetUrl?: string;
  fundingReason?: string;
}

export async function runOnboard(
  options: OnboardOptions = {},
): Promise<{
  configured: boolean;
  daemonInstalled: boolean;
  fundingPerformed: boolean;
}> {
  let config = loadConfig();
  if (options.forceSetup || !config || !walletExists()) {
    config = await runSetupWizard();
  }

  if (!config) {
    throw new Error("OpenFox onboarding failed to produce a config.");
  }

  let daemonInstalled = false;
  let fundingPerformed = false;
  if (options.fundLocal) {
    await fundWalletFromLocalDevnet({
      config,
      waitForReceipt: options.waitForFundingReceipt,
    });
    fundingPerformed = true;
  } else if (options.fundTestnet) {
    await fundWalletFromTestnet({
      config,
      faucetUrl: options.faucetUrl,
      reason: options.fundingReason,
      waitForReceipt: options.waitForFundingReceipt,
    });
    fundingPerformed = true;
  }

  if (options.installDaemon) {
    installManagedService({ force: false, start: true });
    daemonInstalled = true;
  }

  return {
    configured: true,
    daemonInstalled,
    fundingPerformed,
  };
}
