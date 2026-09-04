/* Cross-origin isolation fallback for static hosts that cannot set headers.
 * Cloudflare Pages uses web/_headers directly. GitHub Pages uses this service
 * worker, which adds the same headers and reloads once after taking control.
 */
(function () {
    'use strict';

    if (typeof window !== 'undefined') {
        if (window.crossOriginIsolated || !('serviceWorker' in navigator)) return;

        var reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (reloading) return;
            reloading = true;
            window.location.reload();
        });
        navigator.serviceWorker.register('coi-serviceworker.js', {
            scope: './',
            updateViaCache: 'none',
        }).catch(function (error) {
            console.error('[dusk] Cross-origin isolation worker failed:', error);
        });
        return;
    }

    self.addEventListener('install', function () { self.skipWaiting(); });
    self.addEventListener('activate', function (event) {
        event.waitUntil(self.clients.claim());
    });
    self.addEventListener('fetch', function (event) {
        var request = event.request;
        if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

        event.respondWith(fetch(request).then(function (response) {
            if (response.status === 0) return response;
            var headers = new Headers(response.headers);
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            headers.set('Cross-Origin-Resource-Policy', 'same-origin');
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: headers,
            });
        }));
    });
})();
