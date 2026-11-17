// Stand-in for sodium-universal in React Native: WDK's EVM module only uses sodium_memzero (wiping key bytes).
// The native sodium build is for Node and Bare; this does the same job in plain JavaScript.
export function sodium_memzero(buffer) {
  if (buffer && typeof buffer.fill === 'function') buffer.fill(0);
}
export default { sodium_memzero };
