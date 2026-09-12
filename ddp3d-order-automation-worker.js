// ddp3d order automation — Cloudflare Worker
// Receives FormSubmit's _webhook POST for both the Stripping Basket request
// form and the Hymnal Rack inquiry form, and creates the corresponding
// Stripe object(s). Never sends or finalizes anything — invoices are left
// in draft, and existing customers are matched by email rather than duplicated.

const STRIPE_API = 'https://api.stripe.com/v1';

// Live-account price IDs created for this automation (see ddp3d Stripe account).
const BASKET_PRICES = {
  Flats: 'price_1UEvVICCK2YpqVF5ot6HSler',
  Wader: 'price_1UEvVJCCK2YpqVF554klmqAV',
  Surf: 'price_1UEvVLCCK2YpqVF5lFtFpEww',
};
const LEG_STRAP_PRICE = 'price_1UEvVMCCK2YpqVF5I0eJ4bQM';
const SHOULDER_STRAP_PRICE = 'price_1UEvVNCCK2YpqVF5wMz84xjh';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return new Response('OK', { status: 200 }); // ignore malformed pings
    }

    const data = payload.form_data || payload;
    const form = data['Form'] || '';

    try {
      if (form === 'Stripping Basket Request') {
        await handleBasket(data, env);
      } else if (form === 'Hymnal Rack Inquiry') {
        await handleHymnal(data, env);
      } else {
        console.log('Unrecognized form submission, no automation ran:', JSON.stringify(data));
      }
    } catch (err) {
      // Never fail loudly back to FormSubmit — just log for the Cloudflare "Logs" tab.
      console.log('Automation error:', err.message);
    }

    return new Response('OK', { status: 200 });
  },
};

async function handleBasket(data, env) {
  const sizeRaw = data['Basket size'] || '';
  const sizeName = sizeRaw.split(/[—-]/)[0].trim(); // "Flats — $40" -> "Flats"
  const priceId = BASKET_PRICES[sizeName];
  const qty = parseInt(data['Quantity'], 10) || 1;
  const color = data['Color'] || '';
  const legStrap = !!data['Leg strap add-on'];
  const shoulderStrap = !!data['Shoulder strap add-on'];
  const shippingAddress = data['Shipping address'] || '';
  const notes = data['Notes'] || '';

  const customer = await findOrCreateCustomer(data, env, {
    shipping: {
      name: data['Name'] || '',
      address: { line1: shippingAddress || 'Not provided' },
    },
  });

  if (priceId) {
    await stripePost(
      '/invoiceitems',
      {
        customer: customer.id,
        price: priceId,
        quantity: qty,
        description: `${sizeRaw}${color ? ' — color: ' + color : ''}`,
      },
      env
    );
  } else {
    console.log('Unrecognized basket size string, no base item created:', sizeRaw);
  }

  if (legStrap) {
    await stripePost('/invoiceitems', { customer: customer.id, price: LEG_STRAP_PRICE, quantity: qty }, env);
  }
  if (shoulderStrap) {
    await stripePost('/invoiceitems', { customer: customer.id, price: SHOULDER_STRAP_PRICE, quantity: qty }, env);
  }

  await stripePost(
    '/invoices',
    {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: 15,
      footer: `Size: ${sizeRaw || '(unspecified)'} | Color: ${color || '(unspecified)'} | Leg strap: ${
        legStrap ? 'Yes' : 'No'
      } | Shoulder strap: ${shoulderStrap ? 'Yes' : 'No'} | Shipping address: ${
        shippingAddress || '(not provided)'
      } | Phone: ${data['Phone'] || '(none)'} | Notes: ${notes || '(none)'}`,
    },
    env
  );
  // Invoices are created in draft status by default — nothing here finalizes or sends it.
}

async function handleHymnal(data, env) {
  const taxExempt = !!data['Tax-exempt organization'];
  await findOrCreateCustomer(data, env, {
    description: data['Organization'] || undefined,
    tax_exempt: taxExempt ? 'exempt' : 'none',
    metadata: {
      estimated_quantity: data['Estimated quantity'] || '',
      shipping_address: data['Shipping address'] || '',
      notes: data['Notes'] || '',
    },
  });
}

async function findOrCreateCustomer(data, env, extra) {
  const email = data['Email'];
  if (email) {
    const existing = await stripeGet(`/customers?email=${encodeURIComponent(email)}&limit=1`, env);
    if (existing.data && existing.data.length > 0) {
      return existing.data[0];
    }
  }
  const params = Object.assign(
    {
      email: email || undefined,
      name: data['Name'] || undefined,
      phone: data['Phone'] || undefined,
    },
    extra || {}
  );
  return await stripePost('/customers', params, env);
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
