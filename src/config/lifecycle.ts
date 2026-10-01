/**
 * Whether this instance is draining.
 *
 * Shutdown flips this before it stops accepting connections, so the readiness
 * probe starts failing while the process is still serving. A load balancer then
 * takes the instance out of rotation and the requests already in flight finish
 * on a working process instead of being cut off mid-response.
 */
let shuttingDown = false;

export const beginShutdown = (): boolean => {
  if (shuttingDown) return false;
  shuttingDown = true;
  return true;
};

export const isShuttingDown = (): boolean => shuttingDown;
