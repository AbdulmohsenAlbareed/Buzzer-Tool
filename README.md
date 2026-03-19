# أداة الزر — دليل الإعداد

## متغيرات البيئة على Railway

```
JWT_SECRET=نص_عشوائي_طويل
ADMIN_SECRET=كلمة_سر_لوحة_الادارة
DOMAIN=https://your-app.up.railway.app
DB_PATH=/app/data/adatalzar.db

# MyFatoorah
MF_TOKEN=رمز_API_من_MyFatoorah
MF_SANDBOX=false

# Google OAuth (اختياري)
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
```

## إعداد MyFatoorah

1. سجّل على https://myfatoorah.com
2. API Settings → انسخ API Token → ضعه في MF_TOKEN
3. للاختبار: MF_SANDBOX=true
4. للإنتاج: MF_SANDBOX=false

## الباقات

| الباقة | السعر | المدة |
|---|---|---|
| مجاني | 0 | جلسة واحدة / 15 دقيقة |
| جلسة | 3 ريال | ساعة كاملة |
| Pro | 19 ريال/شهر | بلا حد |

## الروابط

| الصفحة | الرابط |
|---|---|
| الهوست | `/` |
| اللاعب | `/player.html?room=room_XXX` |
| الباقات | `/pricing.html` |
| الإدارة | `/admin.html` |
| تسجيل الدخول | `/login.html` |
