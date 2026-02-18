import { Router } from 'express';
import { env } from '../config/env.js';
import fetch from 'node-fetch';
import crypto from 'crypto';
import User from '../models/User.js';
import Order from '../models/Order.js';
import { sendMail } from '../lib/mailer.js';
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
    // Load full user profile to validate emailVerified and phone
    const profile = customerId ? await User.findById(customerId).lean().exec() : null;
    if (!profile) return res.status(400).json({ message: 'Invalid user' });
    if (!profile.emailVerified) return res.status(403).json({ message: 'Only email-verified users can purchase Premium' });

    const resolvedPhone = profile.phone || profile.phoneNumber || req.body?.customer_phone || '';
    if (!resolvedPhone) {
      return res.status(400).json({ message: 'Phone number required. Please add your phone to your profile before purchasing.' });
    }

    const customer_details = {
      customer_id: customerId || `guest_${Date.now()}`,
      customer_email: profile.email || req.body?.customer_email || '',
      customer_phone: resolvedPhone,
      customer_name: profile.displayName || profile.username || ''
    };

    const request = {
      order_amount: String(amount),
      order_currency: 'INR',
      customer_details,
      order_meta: {
        return_url: env.cashfreeReturnUrl || '',
        username: profile.username || profile.displayName || '',
        email: profile.email || '',
        ...(req.body.order_meta || {})
      },
      order_note: `Subscription ${plan} - user:${profile.username || profile.displayName || profile.email || customerId}`
    };

    // Idempotency: accept Idempotency-Key header or body.idempotencyKey
    const idemKey = req.headers['idempotency-key'] || req.body?.idempotencyKey || '';
    if (String(idemKey).trim()) {
      try {
        const existing = await Order.findOne({ idempotencyKey: String(idemKey), customerId: String(customer_details.customer_id), plan }).lean().exec();
        if (existing) {
          // return existing order data to client
          return res.json({ success: true, data: existing.rawResponse || { order_id: existing.orderId, payment_session_id: existing.paymentSessionId, checkout_url: existing.checkoutUrl } });
        }
      } catch (e) {}
    }

    const resp = await cashfreeFetch('/pg/orders', { method: 'POST', body: JSON.stringify(request) });
    if (!resp.ok) {
      console.error('cashfree create-order failed', resp.status, resp.data);
      return res.status(502).json({ message: 'Cashfree create-order failed', status: resp.status, data: resp.data });
    }

    // Persist order for reconciliation
    try {
      const od = resp.data || {};
      const orderDoc = new Order({
        orderId: String(od.order_id || od.orderId || od.id || ''),
        paymentSessionId: String(od.payment_session_id || od.paymentSessionId || ''),
        checkoutUrl: String(od.checkout_url || od.checkoutUrl || ''),
        amount: String(od.order_amount || od.amount || amount),
        currency: String(od.order_currency || 'INR'),
        customerId: String(customer_details.customer_id || ''),
        customerEmail: String(customer_details.customer_email || ''),
        customerPhone: String(customer_details.customer_phone || ''),
        username: String(request.order_meta?.username || ''),
        idempotencyKey: idemKey ? String(idemKey) : undefined,
        plan: plan,
        status: 'PENDING',
        rawResponse: od
      });
      await orderDoc.save().catch(() => {});
    } catch (e) {
      console.warn('payments:create-order - could not persist order', e?.message || e);
    }

    // return order data to client (contains payment_session_id or checkout_url)
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
        const user = await User.findOne({ $or: [{ _id: customerId }, { guestId: customerId }, { email: customerId }] }).exec();
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

          // Send confirmation email
          try {
            const to = user.email;
            if (to) {
              const subject = 'Your Zoktu Premium is active 🎉';
              const features = [
                'Ad-free experience',
                'Priority customer support',
                'Premium badge & profile themes',
                'Advanced chat features & emojis',
                'Enhanced privacy controls',
                'Custom chat themes & colors',
                'Early access to new features'
              ];
              const html = `<p>Hi ${user.displayName || user.username || ''},</p>
                <p>Your payment was successful and your <strong>Zoktu Premium</strong> subscription is now active. You will have access to the following features:</p>
                <ul>${features.map(f => `<li>${f}</li>`).join('')}</ul>
                <p>Order ID: ${order_id}</p>
                <p>If you did not authorize this payment, please contact support.</p>
                <p>— Zoktu Team</p>`;
              await sendMail({ to, subject, html, text: `Your Zoktu Premium is active. Order: ${order_id}` });
            }
          } catch (e) {
            console.warn('payments:return - failed to send confirmation email', e?.message || e);
          }
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

// Webhook endpoint for Cashfree to notify payment status changes
// Cashfree may send a signature header; we attempt HMAC-SHA256 verification when possible.
router.post('/webhook', async (req, res) => {
  try {
    const sigHeader = req.headers['x-cashfree-signature'] || req.headers['x-webhook-signature'] || req.headers['x-cf-signature'] || req.headers['x-signature'];
    const payload = req.body || {};

    // Verify HMAC if signature present
    if (sigHeader && env.cashfreeSecret) {
      try {
        const computed = crypto.createHmac('sha256', String(env.cashfreeSecret)).update(JSON.stringify(payload)).digest('hex');
        if (computed !== String(sigHeader)) {
          console.warn('payments:webhook - signature mismatch');
          return res.status(400).send('Invalid signature');
        }
      } catch (e) {
        console.warn('payments:webhook - signature verification error', e?.message || e);
      }
    }

    // Normalize order id and status
    const orderId = String(payload.order_id || payload.orderId || payload.orderId || payload.order || payload.data?.order_id || '');
    const status = String(payload.order_status || payload.orderStatus || payload.status || payload.data?.order_status || '').toUpperCase();

    if (!orderId) {
      console.warn('payments:webhook - no order id in payload');
      return res.status(400).send('Missing order id');
    }

    // Update order record
    try {
      await Order.findOneAndUpdate({ orderId }, { $set: { status: status || 'PENDING', rawResponse: payload } }).catch(() => {});
    } catch (e) {}

    if (status === 'PAID') {
      // fetch order to get customer info
      try {
        const ord = await Order.findOne({ orderId }).lean().exec();
        const customerId = ord?.customerId || payload.customer_details?.customer_id || payload.data?.customer_id || '';
        if (customerId) {
          const user = await User.findOne({ $or: [{ _id: customerId }, { guestId: customerId }, { email: customerId }] }).exec();
          if (user) {
            const premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await User.findByIdAndUpdate(user._id, {
              $set: {
                isPremium: true,
                premiumUntil,
                subscription: { provider: 'cashfree', orderId: String(orderId), plan: ord?.plan || 'premium', amount: ord?.amount || '' }
              }
            }).exec();

            // send confirmation email
            try {
              const to = user.email;
              if (to) {
                const subject = 'Your Zoktu Premium is active 🎉';
                const features = [
                  'Ad-free experience',
                  'Priority customer support',
                  'Premium badge & profile themes',
                  'Advanced chat features & emojis',
                  'Enhanced privacy controls',
                  'Custom chat themes & colors',
                  'Early access to new features'
                ];
                const html = `<p>Hi ${user.displayName || user.username || ''},</p>
                  <p>Your payment was successful and your <strong>Zoktu Premium</strong> subscription is now active. You will have access to the following features:</p>
                  <ul>${features.map(f => `<li>${f}</li>`).join('')}</ul>
                  <p>Order ID: ${orderId}</p>
                  <p>If you did not authorize this payment, please contact support.</p>
                  <p>— Zoktu Team</p>`;
                await sendMail({ to, subject, html, text: `Your Zoktu Premium is active. Order: ${orderId}` });
              }
            } catch (e) {
              console.warn('payments:webhook - email failed', e?.message || e);
            }
          }
        }
      } catch (e) {
        console.warn('payments:webhook - reconciliation error', e?.message || e);
      }
    }

    return res.status(200).send('ok');
  } catch (e) {
    console.error('payments:webhook error', e?.message || e);
    return res.status(500).send('error');
  }
});

// Admin refund endpoint
// Requires header `x-admin-secret` matching env.adminSecret
router.post('/refund', async (req, res) => {
  try {
    const adminHeader = req.headers['x-admin-secret'] || req.headers['x-admin-token'];
    if (!adminHeader || String(adminHeader) !== String(env.adminSecret)) return res.status(403).json({ message: 'Forbidden' });

    const { orderId, amount } = req.body || {};
    if (!orderId) return res.status(400).json({ message: 'orderId required' });

    // Call Cashfree refund API (attempt generic endpoint)
    const body = { order_id: String(orderId) };
    if (amount) body['refund_amount'] = String(amount);

    const resp = await cashfreeFetch('/pg/refunds', { method: 'POST', body: JSON.stringify(body) });
    if (!resp.ok) {
      console.error('payments:refund failed', resp.status, resp.data);
      return res.status(502).json({ message: 'Cashfree refund failed', status: resp.status, data: resp.data });
    }

    // update order record
    try { await Order.findOneAndUpdate({ orderId: String(orderId) }, { $set: { status: 'REFUNDED', rawResponse: resp.data } }).catch(() => {}); } catch (e) {}

    return res.json({ success: true, data: resp.data });
  } catch (e) {
    console.error('payments:refund error', e?.message || e);
    return res.status(500).json({ message: 'Refund error', error: e?.message || String(e) });
  }
});

export default router;
