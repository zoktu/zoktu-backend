import { Router } from 'express';
import { env } from '../config/env.js';
import fetch from 'node-fetch';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const CF_VERSION = '2023-08-01';
const baseForEnv = (env.cashfreeEnv === 'PROD') ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

const cashfreeFetch = async (path, opts = {}) => {
  const url = `${baseForEnv}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-version': CF_VERSION,
    'x-client-id': env.cashfreeAppId,
    'x-client-secret': env.cashfreeSecret,
    ...(opts.headers || {})
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; } catch (e) { return { ok: res.ok, status: res.status, data: text }; }
};

// Create order (server-side only) - require auth and server-side pricing
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const { plan } = req.body; // expected 'monthly' or 'yearly'
    if (!plan || !['monthly', 'yearly'].includes(plan)) return res.status(400).json({ message: 'plan required: monthly or yearly' });

    // Server-side price mapping (INR)
    const PRICES = { monthly: '49', yearly: '540' };
    const amount = PRICES[plan];

    // Build customer details from authenticated user (prevent client tampering)
    const customerId = req.user?.id || req.user?._id || req.user?.userId || null;
    const customer_details = {
      customer_id: customerId || `guest_${Date.now()}`,
      customer_email: req.user?.email || req.body?.customer_email || '',
      customer_phone: req.body?.customer_phone || ''
    };

    const request = {
      order_amount: String(amount),
      order_currency: 'INR',
      customer_details,
      order_meta: { return_url: env.cashfreeReturnUrl || '', ...(req.body.order_meta || {}) },
      order_note: `Subscription ${plan}`
    };

    const resp = await cashfreeFetch('/pg/orders', { method: 'POST', body: JSON.stringify(request) });
    if (!resp.ok) {
      console.error('cashfree create-order failed', resp.status, resp.data);
      return res.status(502).json({ message: 'Cashfree create-order failed', status: resp.status, data: resp.data });
    }

    // return order data to client (contains payment_session_id)
    return res.json({ success: true, data: resp.data });
  } catch (e) {
    console.error('payments:create-order error', e?.response?.data || e);
    return res.status(500).json({ message: 'Could not create order', error: e?.message || String(e) });
  }
});

// Verify / fetch order status (server-side)
router.post('/verify', async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ message: 'order_id required' });
    const resp = await cashfreeFetch(`/pg/orders/${encodeURIComponent(String(order_id))}`, { method: 'GET' });
    if (!resp.ok) return res.status(502).json({ message: 'Cashfree fetch-order failed', status: resp.status, data: resp.data });
    return res.json({ success: true, data: resp.data });
  } catch (e) {
    console.error('payments:verify error', e?.response?.data || e);
    return res.status(500).json({ message: 'Could not verify order', error: e?.message || String(e) });
  }
});

// Redirect/return handler for web checkout (Cashfree will redirect the user here)
// Example: GET /api/payments/return?order_id=order_123
router.get('/return', async (req, res) => {
  try {
    const order_id = req.query.order_id || req.query.orderId || req.query.order;
    if (!order_id) return res.status(400).send('Missing order_id');
    const resp = await cashfreeFetch(`/pg/orders/${encodeURIComponent(String(order_id))}`, { method: 'GET' });
    if (!resp.ok) {
      console.error('payments:return fetch failed', resp.status, resp.data);
      return res.status(502).send('Error verifying order');
    }
    const data = resp.data || resp;
    const status = (data.order_status || data.orderStatus || data.status || '').toString().toUpperCase();

    // If paid, find user by customer_id (expected to be passed in create-order's customer_details.customer_id)
    if (status === 'PAID') {
      const customerId = data.customer_details?.customer_id;
      if (customerId) {
        const user = await User.findOne({ $or: [{ _id: customerId }, { guestId: customerId }, { email: customerId }] }).lean();
        if (user) {
          const premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
          await User.findByIdAndUpdate(user._id, {
            $set: {
              isPremium: true,
              premiumUntil,
              subscription: {
                provider: 'cashfree',
                orderId: String(order_id),
                plan: 'premium',
                amount: String(data.order_amount || data.amount || '')
              }
            }
          }).exec();
        }
      }
    }

    // Redirect user back to frontend return URL with order status
    const target = env.cashfreeReturnUrl || 'https://zoktu.com';
    try {
      const url = new URL(target);
      url.searchParams.set('order_id', String(order_id));
      url.searchParams.set('status', String(status));
      return res.redirect(url.toString());
    } catch (e) {
      // fallback: simple redirect
      return res.redirect(`${target}?order_id=${encodeURIComponent(String(order_id))}&status=${encodeURIComponent(String(status))}`);
    }
  } catch (e) {
    console.error('payments:return error', e?.response?.data || e);
    return res.status(500).send('Error verifying order');
  }
});

export default router;
