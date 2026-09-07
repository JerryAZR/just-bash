/**
 * Network-environment probe for tests that exercise real DNS/network paths.
 */

import { lookup } from "node:dns";

let dnsReachable: Promise<boolean> | undefined;

/**
 * Whether real DNS resolution works in this environment.
 *
 * Sandboxed and offline machines either refuse DNS lookups or (worse) never
 * answer them; the timeout bounds the probe so a black-holed resolver turns
 * into an honest runtime skip instead of a test-timeout failure. Probed once
 * and cached per process.
 */
export function isDnsReachable(timeoutMs = 2000): Promise<boolean> {
  dnsReachable ??= new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    // Do not keep the process alive just for the probe.
    timer.unref();
    lookup("example.com", (err, address) => {
      clearTimeout(timer);
      resolve(!err && Boolean(address));
    });
  });
  return dnsReachable;
}
