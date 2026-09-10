#!/bin/sh
set -eu

: "${FILES_CLAMAV_PORT:?FILES_CLAMAV_PORT is required}"
case "$FILES_CLAMAV_PORT" in
  *[!0-9]*|'')
    printf '%s\n' 'FILES_CLAMAV_PORT must be an integer from 1 to 65535' >&2
    exit 2
    ;;
esac
if ! [ "$FILES_CLAMAV_PORT" -ge 1 ] 2>/dev/null || ! [ "$FILES_CLAMAV_PORT" -le 65535 ] 2>/dev/null; then
  printf '%s\n' 'FILES_CLAMAV_PORT must be an integer from 1 to 65535' >&2
  exit 2
fi
configuration=/tmp/openslate-clamd.conf
umask 077
cat /etc/clamav/openslate-clamd.conf > "$configuration"
printf '\nTCPSocket %s\n' "$FILES_CLAMAV_PORT" >> "$configuration"
exec /usr/sbin/clamd --config-file="$configuration" --foreground=true
