/* One-time microphone grant. The offscreen recorder can't show Chrome's permission prompt, so
   the extension asks here, in a normal tab; after that the recorder can open the mic. */
(() => {
  const msg = document.getElementById("msg"), again = document.getElementById("again");
  async function ask() {
    again.hidden = true;
    msg.textContent = "Click Allow in Chrome's prompt.";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      msg.innerHTML = '<span class="ok">Microphone allowed.</span> Go back to your call; CallGuard now records your voice too.';
      chrome.runtime.sendMessage({ type: "cg:mic-granted" }).catch(() => {});
      setTimeout(() => window.close(), 2500);
    } catch (e) {
      msg.innerHTML = '<span class="bad">The microphone was blocked.</span> Click the icon at the left of the address bar, set Microphone to Allow, then press Ask again.';
      again.hidden = false;
    }
  }
  again.onclick = ask;
  ask();
})();
