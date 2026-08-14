// Import tracing — every epic, every parent-feature lookup, every field value — is what
// you want when a Jira custom field comes back in an unexpected shape, and a flooded
// console the rest of the time. Errors and warnings are never routed through here.
//
// Two ways to switch it on:
//   REACT_APP_DEBUG=1 npm start          baked in at build time, for a dev session
//   localStorage.debug = '1'             in the browser console, then reload — works
//                                        against an already-built bundle, including the
//                                        one the container serves
function enabled() {
  if (/^(1|true|yes|on)$/i.test(process.env.REACT_APP_DEBUG || '')) return true;
  try {
    return /^(1|true|yes|on)$/i.test(window.localStorage.getItem('debug') || '');
  } catch (err) {
    return false; // storage can be blocked; that just means no debug output
  }
}

export function debug(...args) {
  if (enabled()) console.log(...args);
}

export default debug;
