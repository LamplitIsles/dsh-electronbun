import { BunProvisioner, BunRuntimeResolver, type BunProvisioningResult, type BunResolution } from "./bun-runtime";
import { WIN_GET_BUN_PACKAGE_ID } from "./manifest";
import type { BunRuntimeGateway } from "./startup-controller";

/** Production gateway used by the Cottontail host. */
export class WindowsBunRuntimeGateway implements BunRuntimeGateway {
  readonly resolver: BunRuntimeResolver;
  readonly provisioner: BunProvisioner;

  constructor(options: ConstructorParameters<typeof BunRuntimeResolver>[0] = {}) {
    this.resolver = new BunRuntimeResolver(options);
    this.provisioner = new BunProvisioner({
      resolver: this.resolver,
      runner: options.runner,
    });
  }

  resolve(expectedVersion: string): Promise<BunResolution> {
    return this.resolver.resolve(expectedVersion);
  }

  install(expectedVersion: string): Promise<BunProvisioningResult> {
    return this.provisioner.install({ bun: { version: expectedVersion, packageId: WIN_GET_BUN_PACKAGE_ID } });
  }
}
