#!/usr/bin/env bash
# CallGuard extension check — one command to verify the extension before release.
#
#   ./extension_check.sh                 every check (Chrome checks are skipped if Chrome is absent)
#   ./extension_check.sh --fast          skip the Chrome checks
#   ./extension_check.sh --package       also build dist/callguard-extension-<version>.zip
#
# Exit status: 0 when every check passed or was skipped, 1 when anything failed.
set -u
cd "$(dirname "$0")"

ROOT=$PWD
CHECK_DIR="$ROOT/dist/.check"
SERVER_PID=""
PASS=0
FAIL=0
SKIPPED=0
FAST=0
PACKAGE=0

usage() {
  cat <<'TXT'
Usage: ./extension_check.sh [--fast] [--package]

  --fast      skip the checks that need Chrome (pack validation, dashboard boot)
  --package   build the release zip in dist/ after the checks
  -h, --help  show this help
TXT
}

for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --package) PACKAGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'Unknown option: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_SKIP=$'\033[33m'; C_TITLE=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_SKIP=""; C_TITLE=""; C_OFF=""
fi

pass()  { PASS=$((PASS + 1));      printf '  %sPASS%s %s\n' "$C_OK" "$C_OFF" "$1"; }
fail()  { FAIL=$((FAIL + 1));      printf '  %sFAIL%s %s\n' "$C_BAD" "$C_OFF" "$1"; }
skip()  { SKIPPED=$((SKIPPED + 1)); printf '  %sSKIP%s %s\n' "$C_SKIP" "$C_OFF" "$1"; }
title() { printf '\n%s%s%s\n' "$C_TITLE" "$1" "$C_OFF"; }
show()  { [ -s "$1" ] && sed -n '1,20p' "$1" | sed 's/^/       /'; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}
trap cleanup EXIT INT TERM

find_chrome() {
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v google-chrome-stable 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

rm -rf "$CHECK_DIR"
mkdir -p "$CHECK_DIR"

title "CallGuard extension check"
printf '  extension: %s\n' "$ROOT/extension"

# ---------------------------------------------------------------- environment
title "Environment"
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node -p 'process.versions.node')
  NODE_MAJOR=${NODE_VERSION%%.*}
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    pass "node $NODE_VERSION (18+ needed for node:test)"
  else
    fail "node $NODE_VERSION is too old; 18+ is required"
  fi
else
  fail "node is not installed (needed for syntax checks and unit tests)"
  title "Summary"
  printf '  %d passed · %d failed · %d skipped\n' "$PASS" "$FAIL" "$SKIPPED"
  exit 1
fi

# --------------------------------------------------------------------- files
title "Files"
MISSING=""
for file in \
  extension/manifest.json \
  extension/background.js \
  extension/content.js \
  extension/offscreen.html \
  extension/offscreen.js \
  extension/store.js \
  extension/lib/core.js \
  extension/popup.html \
  extension/popup.css \
  extension/popup.js \
  extension/icons/icon16.png \
  extension/icons/icon32.png \
  extension/icons/icon48.png \
  extension/icons/icon128.png; do
  [ -f "$file" ] || MISSING="$MISSING $file"
done
if [ -z "$MISSING" ]; then
  pass "all runtime files present"
else
  fail "missing:$MISSING"
fi

# -------------------------------------------------------------------- syntax
title "Syntax"
SYNTAX_BAD=""
JS_FILES=$(find extension -type f -name '*.js' | sort)
[ -f docs/assets/app.js ] && JS_FILES="$JS_FILES
docs/assets/app.js"
for file in $JS_FILES; do
  if ! node --check "$file" >"$CHECK_DIR/syntax.err" 2>&1; then
    SYNTAX_BAD="$SYNTAX_BAD $file"
    printf '\n%s\n' "$file"
    show "$CHECK_DIR/syntax.err"
  fi
done
if [ -z "$SYNTAX_BAD" ]; then
  pass "every JavaScript file parses"
else
  fail "syntax errors in:$SYNTAX_BAD"
fi

# --------------------------------------------------------- manifest contents
title "Manifest"
if ROOT="$ROOT" node - >"$CHECK_DIR/manifest.out" 2>&1 <<'NODE'
const fs = require("fs");
const path = require("path");
const root = path.join(process.env.ROOT, "extension");
const errors = [];
const p = (rel) => path.join(root, rel);
const exists = (rel) => {
  try { return fs.statSync(p(rel)).isFile(); } catch { return false; }
};
const need = (cond, msg) => { if (!cond) errors.push(msg); };

let m;
try {
  m = JSON.parse(fs.readFileSync(p("manifest.json"), "utf8"));
} catch (e) {
  console.error("manifest.json cannot be read: " + e.message);
  process.exit(1);
}

need(m.manifest_version === 3, "manifest_version must be 3");
need(/^\d+\.\d+\.\d+$/.test(String(m.version || "")), "version must look like 1.0.0");
need(typeof m.name === "string" && m.name.length > 0, "name is empty");
need(typeof m.description === "string" && m.description.length > 0 && m.description.length <= 132,
  "description must be 1-132 characters (currently " + String(m.description || "").length + ")");
need(typeof m.homepage_url === "string" && /^https:\/\//.test(m.homepage_url), "homepage_url must be an https URL");

const perms = Array.isArray(m.permissions) ? m.permissions : [];
for (const perm of ["tabCapture", "activeTab", "audioCapture", "offscreen", "storage", "unlimitedStorage", "scripting"]) {
  need(perms.includes(perm), "missing permission: " + perm);
}

const hosts = Array.isArray(m.host_permissions) ? m.host_permissions : [];
need(hosts.some((h) => h.indexOf("web.telegram.org") >= 0), "missing the Telegram host permission");
need(hosts.some((h) => h.indexOf("web.whatsapp.com") >= 0), "missing the WhatsApp host permission");
need(hosts.some((h) => h.indexOf("github.io") >= 0), "missing the CallGuard dashboard host permission");

need(m.background && m.background.service_worker && exists(m.background.service_worker),
  "background.service_worker is missing");
need(m.action && m.action.default_popup && exists(m.action.default_popup),
  "action.default_popup is missing");
need(Array.isArray(m.content_scripts) && m.content_scripts.length > 0, "no content_scripts entry");
for (const cs of m.content_scripts || []) {
  for (const js of cs.js || []) need(exists(js), "content script is missing: " + js);
  need((cs.matches || []).some((u) => u.indexOf("web.telegram.org") >= 0),
    "a content script does not match web.telegram.org");
  need((cs.matches || []).some((u) => u.indexOf("web.whatsapp.com") >= 0),
    "a content script does not match web.whatsapp.com");
}

const icons = m.icons || {};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const size of ["16", "32", "48", "128"]) {
  const rel = icons[size];
  need(!!rel && exists(rel), "icon" + size + ".png is missing");
  if (!rel || !exists(rel)) continue;
  const b = fs.readFileSync(p(rel));
  const isPng = b.length > 24 && b.slice(0, 8).equals(PNG);
  need(isPng, "icon" + size + ".png is not a PNG");
  if (isPng) {
    const w = b.readUInt32BE(16);
    const h = b.readUInt32BE(20);
    need(w === Number(size) && h === Number(size), "icon" + size + ".png is " + w + "x" + h);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
then
  pass "manifest is valid, complete and self-consistent"
else
  fail "manifest check failed"
  show "$CHECK_DIR/manifest.out"
fi

# -------------------------------------------------------------- page wiring
title "Page wiring"
if ROOT="$ROOT" node - >"$CHECK_DIR/wiring.out" 2>&1 <<'NODE'
const fs = require("fs");
const path = require("path");
const root = path.join(process.env.ROOT, "extension");
const errors = [];

function order(file, scripts) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  let at = -1;
  for (const src of scripts) {
    const i = html.indexOf(src);
    if (i < 0) {
      errors.push(file + " does not load " + src);
    } else {
      if (i < at) errors.push(file + " loads " + src + " before an earlier script");
      at = i;
    }
  }
}

order("offscreen.html", ["lib/core.js", "store.js", "offscreen.js"]);
order("popup.html", ["lib/core.js", "store.js", "popup.js"]);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
then
  pass "recorder and popup load core.js → store.js → their script, in order"
else
  fail "a page loads its scripts in the wrong order or misses one"
  show "$CHECK_DIR/wiring.out"
fi

# ---------------------------------------------------------------- unit tests
title "Unit tests"
if node --test extension/test/*.test.js >"$CHECK_DIR/tests.log" 2>&1; then
  COUNT=$(sed -n 's/^ℹ pass \(.*\)$/\1/p' "$CHECK_DIR/tests.log" | tail -1)
  [ -n "$COUNT" ] || COUNT=$(sed -n 's/^# pass \(.*\)$/\1/p' "$CHECK_DIR/tests.log" | tail -1)
  pass "unit tests passed${COUNT:+ ($COUNT)}"
else
  fail "unit tests failed"
  sed -n '1,60p' "$CHECK_DIR/tests.log" | sed 's/^/       /'
fi

# ------------------------------------------------------------------ hygiene
title "Hygiene"
if grep -rnE 'console\.(log|debug)|TODO|FIXME|XXX' extension \
    --include='*.js' --include='*.html' --include='*.css' --include='*.json' \
    >"$CHECK_DIR/hygiene.txt" 2>/dev/null; then
  fail "debug leftovers in the extension"
  show "$CHECK_DIR/hygiene.txt"
else
  pass "no console.log / TODO / FIXME in the extension"
fi

if find extension \( -name '*.crx' -o -name '*.pem' -o -name '*.zip' -o -name '.DS_Store' \) | grep -q .; then
  fail "packaged artifacts or .DS_Store inside extension/"
else
  pass "extension folder contains only source files"
fi

# ------------------------------------------------------- dashboard coupling
if [ -f docs/index.html ] && [ -f docs/version.json ] && [ -f docs/assets/app.js ]; then
  title "Dashboard bridge"
  if ROOT="$ROOT" node - >"$CHECK_DIR/dashboard.out" 2>&1 <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.env.ROOT;
const errors = [];
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

try {
  const html = read("docs/index.html");
  const version = JSON.parse(read("docs/version.json")).v;
  if (html.indexOf('var BUILD = "' + version + '"') < 0) {
    errors.push("index.html BUILD does not match version.json (" + version + ")");
  }
  const stamps = Array.from(html.matchAll(/\?v=(\d+)/g)).map((m) => m[1]);
  if (!stamps.length) errors.push("no cache-busting ?v= stamps in index.html");
  else if (stamps.some((s) => s !== version)) {
    errors.push("some ?v= stamps differ from version.json (" + version + ")");
  }
  const app = read("docs/assets/app.js");
  if (app.indexOf("callguard-extension") < 0) errors.push("docs/assets/app.js has no clip bridge (callguard-extension)");
  if (app.indexOf("importExtensionClip") < 0) errors.push("docs/assets/app.js has no importExtensionClip()");
} catch (e) {
  errors.push(e.message);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
  then
    pass "build stamp consistent and the dashboard has the clip bridge"
  else
    fail "dashboard bridge or build stamp is out of date"
    show "$CHECK_DIR/dashboard.out"
  fi
else
  skip "docs/ not found, dashboard checks skipped"
fi

# ---------------------------------------------------------------- Chrome
CHROME=""
if [ "$FAST" -eq 1 ]; then
  title "Chrome"
  skip "Chrome checks skipped (--fast)"
elif CHROME=$(find_chrome); then
  title "Chrome accepts the extension"
  mkdir -p "$CHECK_DIR/pack"
  cp -R extension "$CHECK_DIR/pack/extension"
  if "$CHROME" --pack-extension="$CHECK_DIR/pack/extension" --no-message-box \
      >"$CHECK_DIR/pack.log" 2>&1 && [ -f "$CHECK_DIR/pack/extension.crx" ]; then
    pass "Chrome packed it (manifest and files accepted, $(wc -c < "$CHECK_DIR/pack/extension.crx" | tr -d ' ') bytes)"
  else
    fail "Chrome could not pack the extension"
    show "$CHECK_DIR/pack.log"
  fi

  if [ -f docs/index.html ] && command -v python3 >/dev/null 2>&1; then
    title "Dashboard boots"
    PORT=$((8100 + RANDOM % 300))
    python3 -m http.server "$PORT" --bind 127.0.0.1 --directory docs >/dev/null 2>&1 &
    SERVER_PID=$!
    sleep 1
    if "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
        --user-data-dir="$CHECK_DIR/chrome-profile" --virtual-time-budget=8000 \
        --enable-logging=stderr --log-level=0 \
        --dump-dom "http://127.0.0.1:$PORT/" >"$CHECK_DIR/dom.html" 2>"$CHECK_DIR/chrome.log"; then
      if CHECK_DIR="$CHECK_DIR" node - >"$CHECK_DIR/dom.out" 2>&1 <<'NODE'
const fs = require("fs");
const path = require("path");
const dir = process.env.CHECK_DIR;
const errors = [];

let html = "";
try {
  html = fs.readFileSync(path.join(dir, "dom.html"), "utf8");
} catch (e) {
  console.error("no DOM was produced: " + e.message);
  process.exit(1);
}

if (!/<div id="bootFail"[^>]*\bhidden\b/.test(html)) {
  errors.push("recovery card (#bootFail) is visible — the page failed to start");
}
if (!/<div class="auth-wrap" id="auth"(?![^>]*\bhidden\b)[^>]*>/.test(html)) {
  errors.push("login screen (#auth) did not render");
}
if (!/<div class="app" id="appRoot"[^>]*\bhidden\b/.test(html)) {
  errors.push("app shell (#appRoot) should stay hidden until login");
}
if (html.indexOf("auth-pane") < 0) errors.push("no login card in the DOM");

let log = "";
try { log = fs.readFileSync(path.join(dir, "chrome.log"), "utf8"); } catch { /* optional */ }
const jsErrors = log.split("\n").filter((l) => /uncaught|syntaxerror|typeerror|referenceerror/i.test(l));
if (jsErrors.length) errors.push("browser console: " + jsErrors.slice(0, 3).join(" | "));

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
NODE
      then
        pass "login screen renders, recovery card stays hidden, no JS errors"
      else
        fail "the dashboard did not boot cleanly"
        show "$CHECK_DIR/dom.out"
      fi
    else
      fail "headless Chrome could not load the dashboard"
      show "$CHECK_DIR/chrome.log"
    fi
    cleanup
  else
    skip "dashboard not present or python3 missing, boot check skipped"
  fi
else
  title "Chrome"
  skip "Chrome not found (install Chrome, or pass --fast to hide this)"
fi

# ---------------------------------------------------------------- package
if [ "$PACKAGE" -eq 1 ]; then
  title "Package"
  if ! command -v zip >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
    fail "zip and unzip are needed for --package"
  else
    VERSION=$(node -p 'require("./extension/manifest.json").version')
    ZIP="$ROOT/dist/callguard-extension-$VERSION.zip"
    rm -f "$ZIP"
    if (cd extension && zip -rq "$ZIP" . -x 'test/*' -x 'STORE.md' -x '*.DS_Store' -x '*/.*'); then
      if unzip -p "$ZIP" manifest.json >"$CHECK_DIR/packed-manifest.json" 2>/dev/null &&
          node - "$CHECK_DIR/packed-manifest.json" "$VERSION" >"$CHECK_DIR/zip.out" 2>&1 <<'NODE'
const fs = require("fs");
const [file, version] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(file, "utf8"));
if (m.version !== version) {
  console.error("packaged version " + m.version + " does not match manifest version " + version);
  process.exit(1);
}
if (m.manifest_version !== 3) {
  console.error("packaged manifest is not Manifest V3");
  process.exit(1);
}
NODE
      then
        pass "wrote dist/callguard-extension-$VERSION.zip ($(wc -c < "$ZIP" | tr -d ' ') bytes, manifest at root)"
      else
        fail "the packaged zip has no valid manifest at its root"
        show "$CHECK_DIR/zip.out"
      fi
    else
      fail "zip failed"
    fi
  fi
fi

# ---------------------------------------------------------------- summary
title "Summary"
printf '  %d passed · %d failed · %d skipped\n' "$PASS" "$FAIL" "$SKIPPED"
printf '  logs: %s\n' "$CHECK_DIR"
if [ "$FAIL" -gt 0 ]; then
  printf '  %sNot ready for release.%s\n' "$C_BAD" "$C_OFF"
  exit 1
fi
printf '  %sAll checks passed.%s\n' "$C_OK" "$C_OFF"
exit 0
