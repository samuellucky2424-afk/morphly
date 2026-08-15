-- Credit a confirmed IvoryPay transaction through the established payment
-- function, then record the correct payment provider for audit and refund work.
CREATE OR REPLACE FUNCTION public.apply_verified_ivorypay_payment(
  p_user UUID,
  p_package UUID,
  p_reference TEXT,
  p_gateway_id TEXT,
  p_amount NUMERIC,
  p_fee NUMERIC DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_transaction_id UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  v_result := public.apply_verified_package_payment(
    p_user,
    p_package,
    p_reference,
    p_gateway_id,
    p_amount,
    p_fee
  );

  v_transaction_id := NULLIF(v_result->>'transactionId', '')::UUID;
  IF v_transaction_id IS NOT NULL THEN
    UPDATE public.transactions
    SET payment_gateway = 'ivorypay'
    WHERE id = v_transaction_id;

    UPDATE public.wallet_ledger
    SET reason = 'Verified IvoryPay payment'
    WHERE transaction_id = v_transaction_id
      AND entry_type = 'package_purchase';
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_ivorypay_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_ivorypay_payment(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC)
  TO service_role;
