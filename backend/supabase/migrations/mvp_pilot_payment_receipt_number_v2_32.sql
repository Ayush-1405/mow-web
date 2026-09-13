-- Payment Follow-up records had no way to note the receipt number a
-- payment was actually recorded against — nullable since a follow-up is
-- often logged before the payment (and its receipt) exists yet.
ALTER TABLE public.interior_payment_records ADD COLUMN IF NOT EXISTS receipt_number text;
