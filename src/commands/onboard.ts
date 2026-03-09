import { loadConfig } from "../config.js";
import { walletExists } from "../identity/wallet.js";
import { installManagedService } from "../service/daemon.js";
import { runSetupWizard } from "../setup/wizard.js";

export interface OnboardOptions {
  installDaemon?: boolean;
  forceSetup?: boolean;
}

export async function runOnboard(
  options: OnboardOptions = {},
): Promise<{
  configured: boolean;
  daemonInstalled: boolean;
}> {
  let config = loadConfig();
  if (options.forceSetup || !config || !walletExists()) {
    config = await runSetupWizard();
  }

  if (!config) {
    throw new Error("OpenFox onboarding failed to produce a config.");
  }

  let daemonInstalled = false;
  if (options.installDaemon) {
    installManagedService({ force: false, start: true });
    daemonInstalled = true;
  }

  return {
    configured: true,
    daemonInstalled,
  };
}
