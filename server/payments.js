const db = require('./db');

// MyFatoorah API
const MF_BASE = process.env.MF_SANDBOX === 'true'
  ? 'https://apitest.myfatoorah.com'
  : 'https://api.myfatoorah.com';
const MF_TOKEN = process.env.MF_TOKEN || '';

const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';

const PLANS = {
  session: { amount: 3,  label: 'حروف — جلسة واحدة',  description: 'جلسة لعب واحدة (حتى 4 لاعبين)' },
  pro:     { amount: 19, label: 'حروف Pro — شهري',    description: 'جلسات غير محدودة لمدة 30 يوم' }
};

async function mfPost(endpoint, body) {
  const fetch = require('node-fetch');
  const res = await fetch(MF_BASE + endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + MF_TOKEN
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || data.IsSuccess === false) {
    throw new Error(data.Message || data.ValidationErrors?.[0]?.Error || 'MyFatoorah error');
  }
  return data;
}

// إنشاء رابط دفع
async function createCheckout(user, plan) {
  if (!MF_TOKEN) throw new Error('MyFatoorah غير مفعّل — أضف MF_TOKEN في متغيرات البيئة');

  const p = PLANS[plan];
  if (!p) throw new Error('باقة غير صحيحة');

  const data = await mfPost('/v2/SendPayment', {
    PaymentMethodId: null,        // null = يعرض كل طرق الدفع
    CustomerName: user.name || 'عميل',
    CustomerEmail: user.email || 'noreply@huroof.app',
    DisplayCurrencyIso: 'SAR',
    MobileCountryCode: '+966',
    CustomerMobile: user.phone?.replace('+966','') || '0500000000',
    Amount: p.amount,
    CallBackUrl: `${DOMAIN}/api/mf-callback?userId=${user.id}&plan=${plan}`,
    ErrorUrl: `${DOMAIN}/pricing.html?payment=failed`,
    Language: 'AR',
    CustomerReference: `user_${user.id}_${plan}_${Date.now()}`,
    InvoiceValue: p.amount,
    DisplayCurrencyValue: p.amount,
    MobileCountry: 'SAR',
    UserDefinedField: JSON.stringify({ userId: user.id, plan }),
    ExpiryDate: '',
    NotificationOption: 'LNK',
    SupplierCode: null,
    Suppliers: null,
    RecurringModel: plan === 'pro' ? {
      RecurringType: 'Monthly',
      IntervalDays: 30,
      Iteration: 12,
      RetryTimes: 3
    } : null
  });

  return { url: data.Data.InvoiceURL, invoiceId: data.Data.InvoiceId };
}

// Callback من MyFatoorah بعد الدفع
async function handleCallback(query) {
  const { paymentId, userId, plan } = query;
  if (!paymentId || !userId || !plan) throw new Error('بيانات ناقصة');

  // تحقق من حالة الدفع
  const data = await mfPost('/v2/GetPaymentStatus', {
    Key: paymentId,
    KeyType: 'PaymentId'
  });

  const invoice = data.Data;
  if (invoice.InvoiceStatus !== 'Paid') {
    throw new Error('لم يتم الدفع بعد');
  }

  const uid = parseInt(userId);

  if (plan === 'session') {
    db.prepare('UPDATE users SET session_credits = session_credits + 1 WHERE id = ?').run(uid);
    db.prepare('INSERT INTO payments (user_id, stripe_payment_id, amount, plan) VALUES (?,?,?,?)')
      .run(uid, invoice.InvoiceId, 300, 'session');
  } else if (plan === 'pro') {
    const subEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    db.prepare('UPDATE users SET plan=?, sessions_limit=-1, subscription_end=? WHERE id=?')
      .run('pro', subEnd, uid);
    db.prepare('INSERT INTO payments (user_id, stripe_payment_id, amount, plan) VALUES (?,?,?,?)')
      .run(uid, invoice.InvoiceId, 1900, 'pro');
  }

  return { ok: true, plan };
}

module.exports = { createCheckout, handleCallback };
