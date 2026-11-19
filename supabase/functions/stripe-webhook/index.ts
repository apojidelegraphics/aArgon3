// Supabase Edge Function "stripe-webhook" (verify_jwt = false: Stripe signs its requests instead).
import { handler } from './handler.mjs';
Deno.serve(handler(Deno.env.toObject()));
