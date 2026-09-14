// ddp3d shared cart client
// Included on every page. Talks to the Worker at /api/cart (same-origin,
// first-party cookie). Exposes window.ddp3dCart for product pages to call
// when a customer adds a Standard/instant-checkout item.

(function () {
  var API_BASE = '/api/cart';

  function updateBadge(items) {
    var badge = document.getElementById('cart-badge');
    if (!badge) return;
    var count = (items || []).reduce(function (sum, item) { return sum + item.quantity; }, 0);
    badge.textContent = count > 0 ? String(count) : '';
    badge.setAttribute('data-count', String(count));
  }

  function refreshBadge() {
    fetch(API_BASE, { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) { updateBadge(data.items); })
      .catch(function () { /* badge just stays as-is if this fails */ });
  }

  function addToCart(payload) {
    return fetch(API_BASE + '/items', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (err) { throw new Error(err.error || 'Could not add to cart'); });
        return res.json();
      })
      .then(function (data) {
        updateBadge(data.items);
        return data.items;
      });
  }

  window.ddp3dCart = { addToCart: addToCart, refreshBadge: refreshBadge };

  document.addEventListener('DOMContentLoaded', refreshBadge);
})();
