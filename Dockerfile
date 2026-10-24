FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --chown=node:node index.html privacy.html agents.html styles.css waitlist.js checkout.js paper-order.js demo-model.js contracts.html contract.html contracts.css contracts.js contract.js contracts-view.js market.js market.css methodology.html signup.html contact.html rfq.html signup.js forms.js forms.css audit.html audit.js audit.css dashboard.html dashboard.css dashboard.js dashboard-view.js theme.js tour.js tour-steps.js tour.css server.mjs package.json site.json ./
COPY --chown=node:node checkout.css ./
COPY --chown=node:node platform.css platform-shell.js sign-in.html sign-in.js offers.html offers.js checkout.html platform-checkout.js orders.html orders.js order.html order.js dashboard-platform.js dashboard-charts.js provider.html provider.js provider-view.js provider.css neocloud-api.html admin.html admin.js admin-view.js admin.css ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node data ./data
# The demo platform keeps its SQLite database here (DEMO_DB_FILE defaults to /app/data/demo.sqlite).
VOLUME /app/data
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--use-env-proxy", "server.mjs"]
