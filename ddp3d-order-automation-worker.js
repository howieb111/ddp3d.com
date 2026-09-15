// ddp3d order automation — Cloudflare Worker
// Two jobs live in this one Worker:
//
// 1. FormSubmit webhook handler (unchanged) — receives the _webhook POST for
//    the Stripping Basket request form and the Hymnal Rack inquiry form, and
//    creates the corresponding Stripe object(s). Never sends or finalizes
//    anything — invoices are left in draft, and existing customers are
//    matched by email rather than duplicated. These requests arrive at this
//    Worker's own workers.dev URL, unaffected by the Route added below.
//
// 2. Cart API (new) — mounted at ddp3d.com/api/cart* via a Worker Route, now
//    that DNS is on Cloudflare. Handles ONLY Tier 3 "Standard" products
//    (fixed price, no design review) — everything else (custom, off-the-shelf
//    custom-fit) stays on its own quote-form page and never enters this cart.
//    Session is a cart ID in an HttpOnly cookie, first-party since the API
//    and the site share a domain. Cart state lives in D1 (binding: CART_DB).
//    Checkout creates a Stripe Checkout Session and returns its URL — payment
//    happens immediately, nothing here waits on manual review.

const STRIPE_API = 'https://api.stripe.com/v1';

// Live-account price IDs created for this automation (see ddp3d Stripe account).
const BASKET_PRICES = {
  Flats: 'price_1UEvVICCK2YpqVF5ot6HSler',
  Wader: 'price_1UEvVJCCK2YpqVF554klmqAV',
  Surf: 'price_1UEvVLCCK2YpqVF5lFtFpEww',
};
const LEG_STRAP_PRICE = 'price_1UEvVMCCK2YpqVF5I0eJ4bQM';
const SHOULDER_STRAP_PRICE = 'price_1UEvVNCCK2YpqVF5wMz84xjh';

// Tier 3 "Standard" products — cart/instant-checkout eligible. Price is the
// only thing that's fixed; mount style, rail thickness, and (for the pencil
// & card holder) height style are all free style choices at this same price.
const CART_PRODUCTS = {
  'standard-card-holder': { name: 'Standard Card Holder', unitAmount: 800 },
  'standard-pencil-card-holder': { name: 'Standard Pencil & Card Holder', unitAmount: 900 },
  'standard-brochure-holder': { name: 'Standard Brochure Holder', unitAmount: 900 },
};

// Card size presets for the Pencil & Card Holder — flat price regardless of
// which is picked; this only affects the slot geometry we cut.
const CARD_SIZES = {
  '3x5': '3x5" index card',
  '4x6': '4x6" index card',
};
// Combined cap on pen + pencil + golf-pencil slots for the Pencil & Card
// Holder — always exactly 1 card slot on top of whatever's picked here.
const MAX_INSTRUMENT_SLOTS = 4;

// Material + color options for all three Standard products — flat price
// regardless of pick. Hex values are Bambu Lab's published filament colors,
// confirmed live from their store as of Sept 2026 (PETG Basic was recently
// reformulated/relaunched, so this list may need rechecking periodically).
const MATERIALS = {
  'pla-basic': {
    name: 'Satin (PLA Basic)',
    colors: {
      'Jade White': '#FFFFFF', 'Beige': '#F7E6DE', 'Gold': '#E4BD68', 'Silver': '#A6A9AA',
      'Gray': '#8E9089', 'Bronze': '#847D48', 'Brown': '#9D432C', 'Red': '#C12E1F',
      'Magenta': '#EC008C', 'Pink': '#F55A74', 'Orange': '#FF6A13', 'Yellow': '#F4EE2A',
      'Bambu Green': '#00AE42', 'Mistletoe Green': '#3F8E43', 'Cyan': '#0086D6', 'Blue': '#0A2989',
      'Purple': '#5E43B7', 'Blue Gray': '#5B6579', 'Light Gray': '#D1D3D5', 'Dark Gray': '#545454',
      'Black': '#000000',
    },
  },
  'petg-basic': {
    name: 'Gloss (PETG Basic)',
    colors: {
      'Red': '#D6001C', 'Orange': '#FF671F', 'Yellow': '#FCE300', 'Reflex Blue': '#001489',
      'Navy Blue': '#0086D6', 'Misty Blue': '#688197', 'Green': '#009639', 'Pine Green': '#034638',
      'Dark Brown': '#4F2C1D', 'Dark Beige': '#DBC8B6', 'Black': '#000000', 'Gray': '#7F7E83',
      'White': '#FFFFFF',
    },
  },
};
const CART_COOKIE_NAME = 'ddp3d_cart';
const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

const SHIPPO_API = 'https://api.goshippo.com';

const SHIP_FROM = {
  name: 'ddp3d',
  street1: '6 Oak Street',
  city: 'Lexington',
  state: 'MA',
  zip: '02421',
  country: 'US',
};

// ESTIMATE — placeholder physical data. Replace once real prototypes exist
// to weigh and measure. unitFootprint = how many abstract "packing units"
// one item takes up (used to decide box size); weightLb = shipping weight
// of a single unit, in pounds. Boxes are listed smallest to largest — a
// cart is packed into the smallest box whose capacity covers the total
// units; if the order exceeds the largest box's capacity, it's split
// across multiple boxes of the largest size.
const SHIPPING_CONFIG = {
  boxes: [
    { name: 'Small', length: 9, width: 6, height: 3, capacityUnits: 4 },
    { name: 'Medium', length: 12, width: 9, height: 6, capacityUnits: 12 },
    { name: 'Large', length: 16, width: 12, height: 10, capacityUnits: 30 },
  ],
  products: {
    'standard-card-holder': { unitFootprint: 1, weightLb: 0.3 },
    'standard-pencil-card-holder': { unitFootprint: 1, weightLb: 0.35 },
    'standard-brochure-holder': { unitFootprint: 1, weightLb: 0.35 },
  },
};

// Decides box size(s) for a cart's contents based on SHIPPING_CONFIG above,
// and returns a Shippo-ready parcels array.
function packBoxes(items) {
  let totalUnits = 0;
  let totalWeight = 0;
  items.forEach((item) => {
    const info = SHIPPING_CONFIG.products[item.productKey] || { unitFootprint: 1, weightLb: 0.3 };
    totalUnits += info.unitFootprint * item.quantity;
    totalWeight += info.weightLb * item.quantity;
  });
  if (totalUnits <= 0) totalUnits = 1;
  if (totalWeight <= 0) totalWeight = 0.1;

  const boxes = SHIPPING_CONFIG.boxes;
  const fitBox = boxes.find((b) => totalUnits <= b.capacityUnits);

  let parcels = [];
  if (fitBox) {
    parcels = [{ box: fitBox, weight: totalWeight }];
  } else {
    const largest = boxes[boxes.length - 1];
    const boxCount = Math.ceil(totalUnits / largest.capacityUnits);
    const weightEach = totalWeight / boxCount;
    for (let i = 0; i < boxCount; i++) {
      parcels.push({ box: largest, weight: weightEach });
    }
  }

  return parcels.map((p) => ({
    length: String(p.box.length),
    width: String(p.box.width),
    height: String(p.box.height),
    distance_unit: 'in',
    weight: String(Math.max(0.1, p.weight).toFixed(2)),
    mass_unit: 'lb',
  }));
}

// FormSubmit normalizes field names for real browser (multipart) submissions
// by replacing spaces with underscores (e.g. "Basket 1 size" arrives as
// "Basket_1_size"), but does NOT do this for hand-built JSON test payloads.
// Try the exact name first, then the underscored version, so both work.
function field(data, name) {
  if (data[name] !== undefined) return data[name];
  const underscored = name.replace(/ /g, '_');
  if (data[underscored] !== undefined) return data[underscored];
  return undefined;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/cart')) {
      try {
        return await handleCartRequest(request, url, env);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    const contentType = request.headers.get('content-type') || '';
    let data = {};
    let rawForDebug = '';

    try {
      if (contentType.includes('application/json')) {
        const parsed = await request.json();
        let formData = parsed.form_data;
        // FormSubmit sends form_data as a JSON-encoded STRING, not a nested
        // object (despite what their docs example shows) — decode it.
        if (typeof formData === 'string') {
          try {
            formData = JSON.parse(formData);
          } catch (e) {
            formData = null;
          }
        }
        data = formData || parsed;
        rawForDebug = JSON.stringify(parsed);
      } else if (
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/x-www-form-urlencoded')
      ) {
        const fd = await request.formData();
        for (const [key, value] of fd.entries()) {
          if (typeof value === 'string') data[key] = value;
        }
        rawForDebug = JSON.stringify(data);
      } else {
        rawForDebug = await request.text();
        try {
          const parsed = JSON.parse(rawForDebug);
          data = parsed.form_data || parsed;
        } catch (e) {
          data = Object.fromEntries(new URLSearchParams(rawForDebug).entries());
        }
      }
    } catch (err) {
      await logDebug(`PARSE ERROR: ${err.message}`, env);
      return new Response('OK', { status: 200 });
    }

    const form = field(data, 'Form') || '';

    try {
      if (form === 'Stripping Basket Request') {
        await handleBasket(data, env);
      } else if (form === 'Hymnal Rack Inquiry') {
        await handleHymnal(data, env);
      } else {
        await logDebug(`UNRECOGNIZED FORM. content-type=${contentType} payload=${rawForDebug}`, env);
      }
    } catch (err) {
      await logDebug(`HANDLER ERROR: ${err.message} | payload=${rawForDebug}`, env);
    }

    return new Response('OK', { status: 200 });
  },
};

// ---------------------------------------------------------------------------
// Cart API
// ---------------------------------------------------------------------------

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
  });
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function cartCookieHeader(cartId) {
  return `${CART_COOKIE_NAME}=${cartId}; Path=/; Max-Age=${CART_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function shippoHeaders(env) {
  return {
    Authorization: `ShippoToken ${env.SHIPPO_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function shippoPost(path, params, env) {
  const res = await fetch(`${SHIPPO_API}${path}`, {
    method: 'POST',
    headers: shippoHeaders(env),
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Shippo ${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function getCartRow(cartId, env) {
  return env.CART_DB.prepare('SELECT * FROM carts WHERE id = ?').bind(cartId).first();
}

// A stored shipping quote is tied to a specific set of cart contents (it
// drove the box-packing decision) — any time items change, the old quote
// no longer reflects reality, so clear it and make the customer re-quote.
async function clearShippingQuote(cartId, env) {
  await env.CART_DB.prepare(
    `UPDATE carts SET shipping_rates_json = NULL, shipping_selected_rate_id = NULL,
     shipping_amount_cents = NULL, shipping_label = NULL, shipping_quoted_at = NULL WHERE id = ?`
  ).bind(cartId).run();
}

// Ensures a cart row exists for this visitor, creating one (and a
// Set-Cookie header to send back) if there isn't one yet.
async function getOrCreateCartId(request, env) {
  const cookies = parseCookies(request);
  const existing = cookies[CART_COOKIE_NAME];
  if (existing) {
    const row = await env.CART_DB.prepare('SELECT id FROM carts WHERE id = ?').bind(existing).first();
    if (row) return { cartId: existing, isNew: false };
  }
  const cartId = crypto.randomUUID();
  const now = Date.now();
  await env.CART_DB.prepare('INSERT INTO carts (id, created_at, updated_at) VALUES (?, ?, ?)')
    .bind(cartId, now, now)
    .run();
  return { cartId, isNew: true };
}

async function getCartItems(cartId, env) {
  const { results } = await env.CART_DB.prepare(
    `SELECT id, product_key, mount_style, rail_thickness, height_style, quantity,
     card_size, cutout, pen_count, pencil_count, golf_pencil_count, material, color
     FROM cart_items WHERE cart_id = ? ORDER BY added_at ASC`
  )
    .bind(cartId)
    .all();
  return (results || []).map((row) => {
    const product = CART_PRODUCTS[row.product_key] || { name: row.product_key, unitAmount: 0 };
    return {
      id: row.id,
      productKey: row.product_key,
      name: product.name,
      mountStyle: row.mount_style,
      railThickness: row.rail_thickness,
      heightStyle: row.height_style,
      quantity: row.quantity,
      unitAmount: product.unitAmount,
      cardSize: row.card_size,
      cutout: row.cutout,
      penCount: row.pen_count,
      pencilCount: row.pencil_count,
      golfPencilCount: row.golf_pencil_count,
      material: row.material,
      color: row.color,
    };
  });
}

function lineItemLabel(item) {
  const parts = [item.name];
  if (item.mountStyle === 'hanging') {
    parts.push(`Hanging (${item.railThickness || 'rail size not set'})`);
  } else {
    parts.push('Tabletop');
  }
  if (item.heightStyle) {
    parts.push(item.heightStyle === 'varying' ? 'Varying height' : 'Uniform height');
  }
  if (item.cardSize) {
    parts.push(CARD_SIZES[item.cardSize] || item.cardSize);
  }
  if (item.cutout === 'yes') {
    parts.push('Card cutout');
  }
  if (item.material) {
    const materialInfo = MATERIALS[item.material];
    parts.push((materialInfo ? materialInfo.name : item.material) + (item.color ? ' — ' + item.color : ''));
  }
  const slotBits = [];
  if (item.penCount) slotBits.push(`${item.penCount} pen`);
  if (item.pencilCount) slotBits.push(`${item.pencilCount} pencil`);
  if (item.golfPencilCount) slotBits.push(`${item.golfPencilCount} golf pencil`);
  if (slotBits.length) {
    parts.push(slotBits.join(', '));
  } else if (item.productKey === 'standard-pencil-card-holder') {
    parts.push('Card only, no pen/pencil slots');
  }
  return parts.join(' — ');
}

async function handleCartRequest(request, url, env) {
  const { cartId, isNew } = await getOrCreateCartId(request, env);
  const setCookie = isNew ? { 'Set-Cookie': cartCookieHeader(cartId) } : {};

  // GET /api/cart — current cart contents
  if (request.method === 'GET' && url.pathname === '/api/cart') {
    const items = await getCartItems(cartId, env);
    return jsonResponse({ items }, 200, setCookie);
  }

  // POST /api/cart/items — add an item
  if (request.method === 'POST' && url.pathname === '/api/cart/items') {
    const body = await request.json();
    const product = CART_PRODUCTS[body.productKey];
    if (!product) return jsonResponse({ error: `Unknown product: ${body.productKey}` }, 400, setCookie);
    if (body.mountStyle !== 'hanging' && body.mountStyle !== 'tabletop') {
      return jsonResponse({ error: 'mountStyle must be "hanging" or "tabletop"' }, 400, setCookie);
    }
    if (body.mountStyle === 'hanging' && body.railThickness !== '1/2"' && body.railThickness !== '3/4"') {
      return jsonResponse({ error: 'railThickness must be 1/2" or 3/4" for a hanging mount' }, 400, setCookie);
    }

    // Material + color — offered on all three Standard products.
    if (!MATERIALS[body.material]) {
      return jsonResponse({ error: 'material must be "pla-basic" or "petg-basic"' }, 400, setCookie);
    }
    if (!MATERIALS[body.material].colors[body.color]) {
      return jsonResponse({ error: `color must be one of the ${MATERIALS[body.material].name} colors` }, 400, setCookie);
    }
    const material = body.material;
    const color = body.color;

    // Pencil & Card Holder-only options: card size, cutout, and pen/pencil/
    // golf-pencil slot counts. Not offered on the other two products.
    let cardSize = null;
    let cutout = null;
    let penCount = null;
    let pencilCount = null;
    let golfPencilCount = null;
    if (body.productKey === 'standard-pencil-card-holder') {
      if (!CARD_SIZES[body.cardSize]) {
        return jsonResponse({ error: 'cardSize must be "3x5" or "4x6"' }, 400, setCookie);
      }
      cardSize = body.cardSize;
      cutout = body.cutout === 'yes' ? 'yes' : 'no';
      penCount = Math.max(0, parseInt(body.penCount, 10) || 0);
      pencilCount = Math.max(0, parseInt(body.pencilCount, 10) || 0);
      golfPencilCount = Math.max(0, parseInt(body.golfPencilCount, 10) || 0);
      if (penCount + pencilCount + golfPencilCount > MAX_INSTRUMENT_SLOTS) {
        return jsonResponse(
          { error: `Pen + pencil + golf pencil slots can't exceed ${MAX_INSTRUMENT_SLOTS} total.` },
          400,
          setCookie
        );
      }
    }

    const quantity = Math.max(1, parseInt(body.quantity, 10) || 1);
    const now = Date.now();
    await env.CART_DB.prepare(
      `INSERT INTO cart_items (cart_id, product_key, mount_style, rail_thickness, height_style, quantity, added_at,
       card_size, cutout, pen_count, pencil_count, golf_pencil_count, material, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        cartId,
        body.productKey,
        body.mountStyle,
        body.mountStyle === 'hanging' ? body.railThickness : null,
        body.heightStyle || null,
        quantity,
        now,
        cardSize,
        cutout,
        penCount,
        pencilCount,
        golfPencilCount,
        material,
        color
      )
      .run();
    await env.CART_DB.prepare('UPDATE carts SET updated_at = ? WHERE id = ?').bind(now, cartId).run();
    await clearShippingQuote(cartId, env);
    const items = await getCartItems(cartId, env);
    return jsonResponse({ items }, 200, setCookie);
  }

  // PATCH /api/cart/items/:id — update quantity
  const itemMatch = url.pathname.match(/^\/api\/cart\/items\/(\d+)$/);
  if (request.method === 'PATCH' && itemMatch) {
    const body = await request.json();
    const quantity = Math.max(1, parseInt(body.quantity, 10) || 1);
    await env.CART_DB.prepare('UPDATE cart_items SET quantity = ? WHERE id = ? AND cart_id = ?')
      .bind(quantity, itemMatch[1], cartId)
      .run();
    await clearShippingQuote(cartId, env);
    const items = await getCartItems(cartId, env);
    return jsonResponse({ items }, 200, setCookie);
  }

  // DELETE /api/cart/items/:id — remove an item
  if (request.method === 'DELETE' && itemMatch) {
    await env.CART_DB.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').bind(itemMatch[1], cartId).run();
    await clearShippingQuote(cartId, env);
    const items = await getCartItems(cartId, env);
    return jsonResponse({ items }, 200, setCookie);
  }

  // POST /api/cart/shipping-quote — get live Shippo rates for this cart's
  // contents, packed into box(es) per SHIPPING_CONFIG above.
  if (request.method === 'POST' && url.pathname === '/api/cart/shipping-quote') {
    const body = await request.json();
    const street = (body.street || '').trim();
    const city = (body.city || '').trim();
    const state = (body.state || '').trim();
    const zip = (body.zip || '').trim();
    if (!street || !city || !state || !zip) {
      return jsonResponse({ error: 'Enter street, city, state, and ZIP.' }, 400, setCookie);
    }

    const items = await getCartItems(cartId, env);
    if (items.length === 0) return jsonResponse({ error: 'Cart is empty' }, 400, setCookie);

    const parcels = packBoxes(items);
    const shipment = await shippoPost(
      '/shipments',
      {
        address_from: SHIP_FROM,
        address_to: { street1: street, city, state, zip, country: 'US' },
        parcels,
        async: false,
      },
      env
    );

    const rates = (shipment.rates || [])
      .filter((r) => r.amount)
      .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))
      .slice(0, 5)
      .map((r) => ({
        id: r.object_id,
        provider: r.provider,
        service: (r.servicelevel && (r.servicelevel.name || r.servicelevel.token)) || '',
        days: r.estimated_days || null,
        amount: r.amount,
      }));

    if (rates.length === 0) {
      return jsonResponse({ error: 'No shipping rates came back for that address — double-check it and try again.' }, 400, setCookie);
    }

    const now = Date.now();
    await env.CART_DB.prepare(
      `UPDATE carts SET shipping_rates_json = ?, shipping_selected_rate_id = NULL,
       shipping_amount_cents = NULL, shipping_label = NULL, shipping_quoted_at = ? WHERE id = ?`
    )
      .bind(JSON.stringify(rates), now, cartId)
      .run();

    return jsonResponse({ rates }, 200, setCookie);
  }

  // POST /api/cart/select-shipping — lock in one of the previously quoted
  // rates. Re-validated against the stored quote so a client can't just
  // supply an arbitrary shipping amount.
  if (request.method === 'POST' && url.pathname === '/api/cart/select-shipping') {
    const body = await request.json();
    const cartRow = await getCartRow(cartId, env);
    const rates = cartRow && cartRow.shipping_rates_json ? JSON.parse(cartRow.shipping_rates_json) : [];
    const rate = rates.find((r) => r.id === body.rateId);
    if (!rate) {
      return jsonResponse({ error: 'That rate has expired — please get shipping rates again.' }, 400, setCookie);
    }

    const amountCents = Math.round(parseFloat(rate.amount) * 100);
    const label = `${rate.provider} ${rate.service}`.trim();
    await env.CART_DB.prepare(
      'UPDATE carts SET shipping_amount_cents = ?, shipping_label = ?, shipping_selected_rate_id = ? WHERE id = ?'
    )
      .bind(amountCents, label, rate.id, cartId)
      .run();

    return jsonResponse({ shippingAmount: amountCents, shippingLabel: label }, 200, setCookie);
  }

  // POST /api/cart/checkout — create a Stripe Checkout Session, return its URL
  if (request.method === 'POST' && url.pathname === '/api/cart/checkout') {
    const items = await getCartItems(cartId, env);
    if (items.length === 0) return jsonResponse({ error: 'Cart is empty' }, 400, setCookie);

    const cartRow = await getCartRow(cartId, env);
    if (!cartRow || cartRow.shipping_amount_cents === null || cartRow.shipping_amount_cents === undefined) {
      return jsonResponse({ error: 'Please select a shipping option before checking out.' }, 400, setCookie);
    }

    const params = {
      mode: 'payment',
      success_url: 'https://ddp3d.com/cart-success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://ddp3d.com/cart.html',
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: cartRow.shipping_amount_cents, currency: 'usd' },
            display_name: cartRow.shipping_label || 'Shipping',
          },
        },
      ],
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: {
          message: 'I agree to the [Returns & Shipping policy](https://ddp3d.com/returns.html)',
        },
      },
      metadata: { cart_id: cartId },
      line_items: items.map((item, i) => ({
        quantity: item.quantity,
        price_data: {
          currency: 'usd',
          unit_amount: item.unitAmount,
          product_data: { name: lineItemLabel(item) },
        },
      })),
    };
    const session = await stripePost('/checkout/sessions', params, env);

    // Clear the cart now that checkout has been created — Stripe owns the
    // rest of the flow from here (payment, then webhook/manual fulfillment).
    await env.CART_DB.prepare('DELETE FROM cart_items WHERE cart_id = ?').bind(cartId).run();
    await clearShippingQuote(cartId, env);

    return jsonResponse({ url: session.url }, 200, setCookie);
  }

  return jsonResponse({ error: 'Not found' }, 404, setCookie);
}

// ---------------------------------------------------------------------------
// Existing FormSubmit webhook handling (unchanged)
// ---------------------------------------------------------------------------

async function handleBasket(data, env) {
  const shippingAddress = field(data, 'Shipping address') || '';
  const notes = field(data, 'Notes') || '';

  const customer = await findOrCreateCustomer(data, env, {
    shipping: {
      name: field(data, 'Name') || '',
      address: { line1: shippingAddress || 'Not provided' },
    },
  });

  // The form supports multiple basket lines per submission (e.g. 1 Flats +
  // 1 Surf in one order) via indexed fields: "Basket 1 size", "Basket 2
  // size", etc. Loop until an index has no size field at all.
  const lineSummaries = [];
  let anyLineFound = false;

  for (let n = 1; n <= 20; n++) {
    const sizeRaw = field(data, `Basket ${n} size`);
    if (sizeRaw === undefined) break;
    anyLineFound = true;
    if (!sizeRaw) continue; // line present but left blank — skip it

    const sizeName = sizeRaw.split(/[—-]/)[0].trim(); // "Flats — $40" -> "Flats"
    const priceId = BASKET_PRICES[sizeName];
    const qty = parseInt(field(data, `Basket ${n} quantity`), 10) || 1;
    const color = field(data, `Basket ${n} color`) || '';
    const legStrap = !!field(data, `Basket ${n} leg strap`);
    const shoulderStrap = !!field(data, `Basket ${n} shoulder strap`);
    const legStrapQty = parseInt(field(data, `Basket ${n} leg strap quantity`), 10) || qty;
    const shoulderStrapQty = parseInt(field(data, `Basket ${n} shoulder strap quantity`), 10) || qty;

    if (priceId) {
      await stripePost(
        '/invoiceitems',
        {
          customer: customer.id,
          pricing: { price: priceId },
          quantity: qty,
          description: `${sizeRaw}${color ? ' — color: ' + color : ''}`,
        },
        env
      );
    } else {
      await logDebug(`Unrecognized basket size string on line ${n}, no base item created: ${sizeRaw}`, env);
    }

    if (legStrap) {
      await stripePost(
        '/invoiceitems',
        { customer: customer.id, pricing: { price: LEG_STRAP_PRICE }, quantity: legStrapQty },
        env
      );
    }
    if (shoulderStrap) {
      await stripePost(
        '/invoiceitems',
        { customer: customer.id, pricing: { price: SHOULDER_STRAP_PRICE }, quantity: shoulderStrapQty },
        env
      );
    }

    lineSummaries.push(
      `${sizeRaw || '(unspecified)'} x${qty}, color ${color || '(unspecified)'}` +
        (legStrap ? `, leg strap ${legStrapQty} of ${qty}` : '') +
        (shoulderStrap ? `, shoulder strap ${shoulderStrapQty} of ${qty}` : '')
    );
  }

  if (!anyLineFound) {
    await logDebug('No basket lines found in submission (no "Basket 1 size" field present).', env);
  }

  await stripePost(
    '/invoices',
    {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: 15,
      pending_invoice_items_behavior: 'include',
      description: 'Returns & shipping policy: https://ddp3d.com/returns.html',
      footer: `${lineSummaries.join(' | ') || 'No basket lines recognized — check submission manually'} | Shipping address: ${
        shippingAddress || '(not provided)'
      } | Phone: ${field(data, 'Phone') || '(none)'} | Notes: ${notes || '(none)'}`,
    },
    env
  );
  // Invoices are created in draft status by default — nothing here finalizes or sends it.
}

async function handleHymnal(data, env) {
  const taxExempt = !!field(data, 'Tax-exempt organization');
  await findOrCreateCustomer(data, env, {
    description: field(data, 'Organization') || undefined,
    tax_exempt: taxExempt ? 'exempt' : 'none',
    metadata: {
      estimated_quantity: field(data, 'Estimated quantity') || '',
      shipping_address: field(data, 'Shipping address') || '',
      notes: field(data, 'Notes') || '',
    },
  });
}

async function findOrCreateCustomer(data, env, extra) {
  const email = field(data, 'Email');
  if (email) {
    const existing = await stripeGet(`/customers?email=${encodeURIComponent(email)}&limit=1`, env);
    if (existing.data && existing.data.length > 0) {
      return existing.data[0];
    }
  }
  const params = Object.assign(
    {
      email: email || undefined,
      name: field(data, 'Name') || undefined,
      phone: field(data, 'Phone') || undefined,
    },
    extra || {}
  );
  return await stripePost('/customers', params, env);
}

async function logDebug(message, env) {
  try {
    await stripePost(
      '/customers',
      {
        email: `webhook-debug+${Date.now()}@ddp3d.com`,
        description: 'WEBHOOK DEBUG — automation did not process this submission normally',
        metadata: { detail: String(message).slice(0, 490) },
      },
      env
    );
  } catch (e) {
    // best-effort diagnostics only — never let this throw
  }
}

function stripeHeaders(env) {
  return {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function stripePost(path, params, env) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: stripeHeaders(env),
    body: toFormBody(params),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function stripeGet(pathWithQuery, env) {
  const res = await fetch(`${STRIPE_API}${pathWithQuery}`, { headers: stripeHeaders(env) });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe GET ${pathWithQuery} failed: ${JSON.stringify(json)}`);
  return json;
}

// Stripe's API takes application/x-www-form-urlencoded with bracket notation
// for nested objects/arrays (e.g. shipping[address][line1]=...).
function toFormBody(params, prefix) {
  const pairs = [];
  for (const key in params) {
    const value = params[key];
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          pairs.push(toFormBody(item, `${fullKey}[${i}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof value === 'object') {
      pairs.push(toFormBody(value, fullKey));
    } else {
      pairs.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return pairs.join('&');
}
