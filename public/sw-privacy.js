/* Remove the retired API cache when the updated worker activates. Static
 * assets keep their offline support; API responses must only use HTTP policy.
 * Workbox cleanupOutdatedCaches only cleans its own precache, not this cache. */
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('gm-public-api-v1'))
})
