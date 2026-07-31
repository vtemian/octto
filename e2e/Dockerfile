FROM oven/bun:1-debian

# chromium for the real browser, xvfb for a display, xdg-utils so octto's
# openBrowser() (which shells out to xdg-open on Linux) exercises its real path.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      xdg-utils \
      fonts-liberation \
      ca-certificates \
      curl \
      unzip \
      procps \
    && rm -rf /var/lib/apt/lists/*

# The installer's layout varies by version, so locate the binary rather than
# assume a path, and fail loudly if it is missing.
RUN curl -fsSL https://opencode.ai/install | bash \
    && OPENCODE_BIN="$(find / -type f -name opencode -perm -u+x 2>/dev/null | head -1)" \
    && test -n "${OPENCODE_BIN}" \
    && ln -sf "${OPENCODE_BIN}" /usr/local/bin/opencode \
    && opencode --version

# xdg-open must reach the SAME chromium instance the tests drive over CDP.
# Without a matching --user-data-dir, chromium starts a second, unobservable
# instance instead of opening a tab in the running one.
RUN printf '%s\n' \
      '[Desktop Entry]' \
      'Version=1.0' \
      'Name=Octto Chromium' \
      'Exec=/usr/bin/chromium --user-data-dir=/tmp/chrome-profile --no-sandbox --disable-gpu --disable-dev-shm-usage %U' \
      'Terminal=false' \
      'Type=Application' \
      'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;' \
      > /usr/share/applications/octto-chromium.desktop \
    && update-desktop-database /usr/share/applications || true

# System-wide default, because each test isolates HOME for opencode's config
# and would otherwise lose a per-user xdg-settings association.
RUN printf '%s\n' \
      '[Default Applications]' \
      'text/html=octto-chromium.desktop' \
      'x-scheme-handler/http=octto-chromium.desktop' \
      'x-scheme-handler/https=octto-chromium.desktop' \
      > /etc/xdg/mimeapps.list

WORKDIR /work

# Dependencies first so source edits do not bust the layer cache.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY e2e/package.json ./e2e/package.json
RUN cd e2e && bun install --ignore-scripts

COPY . .
RUN bun run build

ENV DISPLAY=:99 \
    CHROME_BIN=/usr/bin/chromium \
    CDP_PORT=9222 \
    OCTTO_PORT=7777 \
    STUB_PORT=8787

ENTRYPOINT ["/work/e2e/entrypoint.sh"]
CMD ["bun", "test", "e2e/specs", "--timeout", "200000"]
