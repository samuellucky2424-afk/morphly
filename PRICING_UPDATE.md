# Credit Pricing Update

## New Pricing Structure

**Base Rate:** ₦9,500 per 500 credits (₦19 per credit)

### Credit Packages

| Credits | Price (NGN) | Price (USD)* | Duration** |
|---------|-------------|--------------|------------|
| 500     | ₦9,500      | $6.33        | ~4m 10s    |
| 1,000   | ₦19,000     | $12.67       | ~8m 20s    |
| 2,000   | ₦38,000     | $25.33       | ~16m 40s   |
| 5,000   | ₦95,000     | $63.33       | ~41m 40s   |

*USD pricing calculated at 1500 NGN/USD exchange rate  
**Duration based on 2 credits per second of stream time

## Files Updated

### Frontend
- ✅ `.push-fix/app/src/pages/Subscription.tsx` - Updated CREDIT_PLANS array
- ✅ `app/src/pages/Subscription.tsx` - Updated CREDIT_PLANS array

### Backend (Database)
- ✅ `.push-fix/supabase/current_schema.sql` - Updated plans insert statement
- ✅ `.push-fix/supabase/seed_plans.sql` - Updated seed data with NGN pricing

## Pricing Calculation

The pricing is proportional across all tiers:
- **500 credits** = ₦9,500 (base price)
- **1,000 credits** = ₦9,500 × 2 = ₦19,000
- **2,000 credits** = ₦9,500 × 4 = ₦38,000
- **5,000 credits** = ₦9,500 × 10 = ₦95,000

## How It Works

1. **Frontend Display**: The Subscription page shows USD prices with live NGN conversion
2. **Payment Processing**: Paystack processes payments in NGN
3. **Database Storage**: Plans are stored with both NGN and USD pricing
4. **Exchange Rate**: Live rates are fetched from the API, with fallback to 1500 NGN/USD

## Next Steps

To apply these changes to your database:

```sql
-- Run this SQL in your Supabase SQL Editor
UPDATE public.plans SET price_usd = 6.33 WHERE name = '500 Credits';
UPDATE public.plans SET price_usd = 12.67 WHERE name = '1,000 Credits';
UPDATE public.plans SET price_usd = 25.33 WHERE name = '2,000 Credits';
UPDATE public.plans SET price_usd = 63.33 WHERE name = '5,000 Credits';
```

Or run the seed file:
```bash
psql -h your-db-host -U postgres -d postgres -f .push-fix/supabase/seed_plans.sql
```
