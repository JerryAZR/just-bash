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
 * into an honest runtime skip instead of a test-timeout failure. A POSITIVE
 * result is cached for the process (reachability does not disappear); a
 * negative result is NOT cached — a transient DNS blip must not silently
 * skip every dependent test for the whole run.
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
  }).then((reachable) => {
    if (!reachable) dnsReachable = undefined; // re-probe next caller
    return reachable;
  });
  return dnsReachable;
}
