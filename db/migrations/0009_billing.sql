-- 0009: beta loop B6. Subscriptions, written only by the Stripe webhook (definer function).
-- Billing ships switched off (BILLING_ENABLED unset): nothing here limits anyone until it is on.
CREATE TABLE mca.subscription (
  user_id            text PRIMARY KEY REFERENCES mca.app_user(user_id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  stripe_subscription_id text,
  status             text NOT NULL,          -- Stripe status: active, trialing, past_due, canceled, ...
  price_id           text,
  current_period_end timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mca.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca.subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON mca.subscription FOR SELECT USING (user_id = mca.current_user_id());
GRANT SELECT ON mca.subscription TO mca_app;

-- Called by the verified webhook. Matches the user by the client_reference_id set at checkout,
-- or by a customer id already on file. Events for unknown customers are ignored.
CREATE FUNCTION mca.subscription_apply(p_user_id text, p_customer text, p_subscription text, p_status text, p_price text, p_period_end timestamptz)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = mca, pg_temp AS $$
DECLARE uid text := p_user_id;
BEGIN
  IF uid IS NULL THEN SELECT user_id INTO uid FROM subscription WHERE stripe_customer_id = p_customer; END IF;
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM app_user WHERE user_id = uid) THEN RETURN 'ignored'; END IF;
  INSERT INTO subscription (user_id, stripe_customer_id, stripe_subscription_id, status, price_id, current_period_end, updated_at)
  VALUES (uid, p_customer, p_subscription, p_status, p_price, p_period_end, now())
  ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = coalesce(EXCLUDED.stripe_subscription_id, subscription.stripe_subscription_id),
    status = EXCLUDED.status, price_id = coalesce(EXCLUDED.price_id, subscription.price_id),
    current_period_end = coalesce(EXCLUDED.current_period_end, subscription.current_period_end), updated_at = now();
  RETURN 'ok';
END $$;
REVOKE ALL ON FUNCTION mca.subscription_apply(text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mca.subscription_apply(text, text, text, text, text, timestamptz) TO mca_app;
