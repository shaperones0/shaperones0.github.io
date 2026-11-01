// Classic script, loaded first in <head>. Takes control of the page with coi-sw.js,
// then reloads once so the document itself is served with the isolation headers.
(() => {
  const PARAM = "coi-reload";
  const swUrl = new URL("coi-sw.js", document.currentScript.src).href;

  const url = new URL(location.href);
  // The parameter doubles as the loop guard. sessionStorage can't: COOP swaps the browser
  // process between loads, and a stale value then looks like a reload that already happened.
  const alreadyReloaded = url.searchParams.has(PARAM);
  if (alreadyReloaded) {
    url.searchParams.delete(PARAM);
    history.replaceState(history.state, "", url);
  }

  let settle;
  // Resolves once the page can start; stays pending while a reload is on its way.
  window.coiReady = new Promise((resolve) => (settle = resolve));
  const finish = (status) => {
    window.coiStatus = status;
    settle();
  };

  if (window.crossOriginIsolated) {
    finish("isolated");
    return;
  }
  if (!window.isSecureContext || !navigator.serviceWorker) {
    finish("no-service-worker");
    return;
  }
  // Already reloaded once and still not isolated: stop here rather than loop.
  if (alreadyReloaded) {
    finish("failed");
    return;
  }

  window.coiStatus = "reloading";
  // A blocked service worker may never become ready, and that must not hang the page.
  setTimeout(() => finish("failed"), 10000);
  navigator.serviceWorker
    .register(swUrl)
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      // Not location.reload(): after a hard refresh it would bypass the service worker again.
      // The extra parameter forces a real load even when the URL has a #hash.
      const target = new URL(location.href);
      target.searchParams.set(PARAM, "1");
      location.replace(target);
    })
    .catch((error) => {
      console.error(error);
      finish("failed");
    });
})();
