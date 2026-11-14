/* Site configuration (the site owner edits this).
   serviceUrl:   the microservice that receives each uploaded/recorded call (one multipart field, `audioField`)
                 and returns {"request_id", "classes": [...], "summary"}. The fraud category is the F0–F9 code
                 (or category name) among "classes"; every class is shown as a label.
                 Every request carries the token as "Authorization: Bearer <token>"; the service verifies it (401 if wrong).
   healthUrl:    public liveness URL (no token), used to tell "service down" apart from "blocked by CORS".
   authCheckUrl: GET that needs the token (401 if bad), used by Settings → "Test connection & token".
   maxAudioSeconds: the service's audio length limit (checked before uploading).
   googleClientId: Google OAuth Client ID (Web application) for "Continue with Google". */
window.CG_CONFIG = {
  serviceUrl: "https://call-audio-api-c3qg.onrender.com/v1/audio/analyze",
  audioField: "audio",
  healthUrl: "https://call-audio-api-c3qg.onrender.com/healthz",
  authCheckUrl: "https://call-audio-api-c3qg.onrender.com/v1/status",
  maxAudioSeconds: 120,
  googleClientId: "",
  // Per-user sign-in (Supabase → Project Settings → API). Both empty = accounts stay in the browser.
  supabaseUrl: "",
  supabaseAnonKey: "",
};
