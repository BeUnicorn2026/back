FROM docker:27-cli

RUN apk add --no-cache git docker-cli-compose

COPY update.sh /usr/local/bin/voice-partition-update
RUN chmod 0555 /usr/local/bin/voice-partition-update

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/voice-partition-update"]
