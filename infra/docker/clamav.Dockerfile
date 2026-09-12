# Official ClamAV 1.4.6 LTS, Linux amd64; no bundled signatures or updater daemon.
FROM --platform=linux/amd64 clamav/clamav@sha256:488ff88a78d9769efa7e1bac7028419b696d54cecdae1b696c6c7cd670b3bb4b

ENV TZ=UTC

COPY infra/clamav/clamd.conf /etc/clamav/openslate-clamd.conf
COPY infra/clamav/freshclam.conf /etc/clamav/openslate-freshclam.conf
COPY infra/clamav/serve.sh /usr/local/bin/openslate-clamd

USER 100:101
HEALTHCHECK NONE
ENTRYPOINT ["/bin/sh", "/usr/local/bin/openslate-clamd"]
