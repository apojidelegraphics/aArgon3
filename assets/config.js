/* Where aARgon3 talks to. Only public (publishable) keys belong here: this repo is public. */
window.A3_CONFIG = {
  // aARgon3 & Mexel Backend: orders, shifts, and the checkout / staff Edge Functions
  functions: 'https://yuergfrpfhtcxjkcgjrx.supabase.co/functions/v1',
  storeKey: 'sb_publishable_tX9wZpRsI3fAlthnz4lQKA_yVdY7768',
  // Nexus Backend: staff sign in with their Nexus admin account
  nexusUrl: 'https://yzbnxpkuhlxsuwzbjifx.supabase.co',
  nexusKey: 'sb_publishable_LY-EZORCvEQqW6AeQC5a8w_Z7wmeyjn',
  nexusSite: 'https://apojidelegraphics.github.io/Nexus-28/',
  // Stripe → Settings → Billing → Customer portal → "Login link". Paste it here to show "Manage subscription" links.
  portalUrl: ''
};
