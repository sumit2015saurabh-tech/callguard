/* Site configuration (the site owner edits this).
   serviceUrl:   the microservice that receives each uploaded/recorded call (multipart field `audioField`)
                 and returns the transcript, summary, fraud category (F0–F9) and labels.
                 Every request carries the signed-in user's token as "Authorization: Bearer <token>";
                 the service verifies it and answers 401 if it's missing or wrong.
   healthUrl:    public liveness URL (no token), used to tell "service down" apart from "blocked by CORS".
   authCheckUrl: a GET that needs the token (401 if bad), used by Settings → "Test connection & token".
   googleClientId: Google OAuth Client ID (Web application) for "Continue with Google". */
window.CG_CONFIG = {
  serviceUrl: "https://call-audio-api-c3qg.onrender.com/v1/audio/transcribe",
  audioField: "audio",
  healthUrl: "https://call-audio-api-c3qg.onrender.com/healthz",
  authCheckUrl: "https://call-audio-api-c3qg.onrender.com/health",
  googleClientId: "",
};
