/* One-time microphone grant. The offscreen recorder can't show Chrome's permission prompt, so
   the extension asks here, in a normal tab (opened automatically on install/update and when a capture
   starts without the mic). After one "Allow" the recorder opens the mic by itself on every call, and a
   capture that is already running gets the mic added (cg:mic-granted -> cg:add-mic). */
(() => {
  const msg = document.getElementById("msg"), again = document.getElementById("again"),
    settings = document.getElementById("settings");

  function granted() {
    msg.innerHTML = '<span class="ok">Microphone allowed.</span> CallGuard now records your voice too, on every call. This tab closes by itself.';
    again.hidden = true; settings.hidden = true;
    chrome.runtime.sendMessage({ type: "cg:mic-granted" }).catch(() => {});
    setTimeout(() => window.close(), 2500);
  }

  function blocked() {
    msg.innerHTML = '<span class="bad">The microphone is blocked for CallGuard.</span> Press the button below, set <b>Microphone</b> to <b>Allow</b>, then come back and press Ask again.';
    again.hidden = false; settings.hidden = false;
  }

  async function state() {
    try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch { return ""; }
  }

  async function ask() {
    const st = await state();
    if (st === "granted") return granted();
    again.hidden = true;
    msg.innerHTML = "Click <b>Allow</b> in Chrome's prompt. You are asked only once.";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      granted();
    } catch (e) {
      blocked();
    }
  }

  again.onclick = ask;
  settings.onclick = () => chrome.runtime.sendMessage({ type: "cg:open-mic-settings" }).catch(() => {});
  /* If the user allows it in Chrome's settings page, pick that up without another click. */
  (async () => {
    try {
      const p = await navigator.permissions.query({ name: "microphone" });
      p.onchange = () => { if (p.state === "granted") granted(); };
    } catch { /* ignore */ }
  })();
  ask();
})();
