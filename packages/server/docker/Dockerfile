# Pi Bot per-bot environment: one container per bot, its own named volume at /workspace.
# Nothing from the host is mounted and no Docker socket is exposed. Model and search
# credentials never enter this image or its containers.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git openssh-client sudo tini \
      build-essential pkg-config python3 python3-pip python3-venv python-is-python3 \
      unzip zip xz-utils jq ripgrep less procps file \
 && curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Playwright with Chromium (and its system libraries), usable by the non-root user.
RUN npm install -g playwright@1.64.1 \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Non-root user with passwordless sudo; /workspace is the bot's volume.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -s /bin/bash -u 1000 bot \
 && echo 'bot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot \
 && chmod 0440 /etc/sudoers.d/bot \
 && mkdir -p /workspace \
 && chown bot:bot /workspace

# The environment agent: Pi Durable's Node execution environment served over stdio, so the
# server's tools (bash, read, write, edit) run inside this container.
COPY package.json package-lock.json /opt/pibot-env/
RUN cd /opt/pibot-env && npm ci --omit=dev --no-audit --no-fund && rm -rf /root/.npm
COPY agent.mjs /opt/pibot-env/agent.mjs
# A build context can come from a private directory, whose modes COPY would keep.
RUN chmod -R a+rX /opt/pibot-env

USER bot
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
