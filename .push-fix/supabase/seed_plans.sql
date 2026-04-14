-- Seed the plans table with Morphly credit packages
-- Pricing: ₦9,500 per 500 credits (base rate: ₦19 per credit)
-- Assuming exchange rate of ~1500 NGN/USD for USD pricing
INSERT INTO public.plans (name, price, credits, duration_minutes)
VALUES
  ('500 Credits', 9500, 500, 250),
  ('1,000 Credits', 19000, 1000, 500),
  ('2,000 Credits', 38000, 2000, 1000),
  ('5,000 Credits', 95000, 5000, 2500)
ON CONFLICT (name) DO UPDATE SET
  price = EXCLUDED.price,
  credits = EXCLUDED.credits,
  duration_minutes = EXCLUDED.duration_minutes;
