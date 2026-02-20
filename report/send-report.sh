#!/bin/bash
# Generate and send Moby report image via Signal
# Usage: ./send-report.sh [target_uuid]
set -e
cd "$(dirname "$0")"

TARGET="${1:?Usage: send-report.sh <target_uuid>}"

# Run strategy to refresh prices (UW_API_TOKEN must be set in env)
if [ -z "$UW_API_TOKEN" ]; then echo "ERROR: UW_API_TOKEN not set"; exit 1; fi
node strategy.js > /dev/null 2>&1

# Generate HTML report
node render-report.js > /tmp/moby-report.html

# Screenshot
openclaw browser navigate 'file:///tmp/moby-report.html' > /dev/null 2>&1
sleep 1
IMG=$(openclaw browser screenshot --full-page 2>&1 | grep -oP '(?<=MEDIA:).*')

# Expand tilde
IMG="${IMG/#\~/$HOME}"

# Send
openclaw message send --channel signal -t "$TARGET" --media "$IMG" -m "🐋 Moby Status" 2>&1
