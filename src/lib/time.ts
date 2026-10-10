/** Request-time clock for server components that already read the request (cookies), so they are dynamic. */
export function requestNow(): number {
  return Date.now();
}
