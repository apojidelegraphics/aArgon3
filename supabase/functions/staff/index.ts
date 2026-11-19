// Supabase Edge Function "staff" (verify_jwt = false: staff sign in with their Nexus account, which this project
// can't check by itself, so the function checks the token with Nexus instead).
import { handler } from './handler.mjs';
Deno.serve(handler(Deno.env.toObject()));
