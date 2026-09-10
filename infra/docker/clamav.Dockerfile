# Official ClamAV 1.4.6 LTS, Linux amd64; no bundled signatures or updater daemon.
FROM --platform=linux/amd64 clamav/clamav@sha256:aeac907bb9445b12c1dd76f9283415272d8dcd596d402245ed13729d7181bb8a

ENV TZ=UTC

COPY infra/clamav/clamd.conf /etc/clamav/openslate-clamd.conf
COPY infra/clamav/freshclam.conf /etc/clamav/openslate-freshclam.conf
COPY infra/clamav/serve.sh /usr/local/bin/openslate-clamd

USER 100:101
HEALTHCHECK NONE
ENTRYPOINT ["/bin/sh", "/usr/local/bin/openslate-clamd"]
