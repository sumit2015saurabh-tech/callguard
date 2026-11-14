#!/bin/sh
# Stamp a new build number into the page + assets so every browser picks up the update, then push.
set -e
cd "$(dirname "$0")/docs"
V=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s#\?v=[0-9]+#?v=$V#g; s#var BUILD = \"[^\"]*\"#var BUILD = \"$V\"#" index.html
printf '{"v":"%s"}\n' "$V" > version.json
echo "build $V"
cd ..
git add -A
git -c user.name=sumit2015saurabh-tech -c user.email=sumit2015saurabh@gmail.com commit -qm "${1:-Update CallGuard}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
GH_TOKEN=$(gh auth token -u sumit2015saurabh-tech) git push -q
for i in $(seq 1 60); do curl -s "https://sumit2015saurabh-tech.github.io/callguard/version.json?x=$RANDOM" | grep -q "$V" && { echo "LIVE build $V"; exit 0; }; sleep 5; done
echo "pushed; Pages still building"
