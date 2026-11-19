// Supabase Edge Function "checkout" (deployed with verify_jwt = false: customers don't have accounts).
import { handler } from './handler.mjs';
Deno.serve(handler(Deno.env.toObject()));
