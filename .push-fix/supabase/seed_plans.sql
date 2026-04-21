-- Seed the plans table with Morphly credit packages
-- Pricing: ₦11,500 per 500 credits (base rate: ₦23 per credit)
-- Assuming exchange rate of ~1500 NGN/USD for USD pricing
INSERT INTO public.plans (name, price, credits, duration_minutes)
VALUES
  ('500 Credits', 11500, 500, 250),
  ('1,000 Credits', 23000, 1000, 500),
  ('2,000 Credits', 46000, 2000, 1000),
  ('5,000 Credits', 115000, 5000, 2500)
ON CONFLICT (name) DO UPDATE SET
  price = EXCLUDED.price,
  credits = EXCLUDED.credits,
  duration_minutes = EXCLUDED.duration_minutes;
