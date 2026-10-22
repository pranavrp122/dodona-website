FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY --chown=node:node index.html privacy.html agents.html styles.css waitlist.js checkout.js paper-order.js demo-model.js contracts.html contract.html contracts.css contracts.js contract.js contracts-view.js market.js market.css methodology.html signup.html contact.html rfq.html signup.js forms.js forms.css audit.html audit.js audit.css dashboard.html dashboard.css dashboard.js dashboard-view.js server.mjs package.json site.json ./
COPY --chown=node:node checkout.css ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node data ./data
COPY --chown=node:node assets ./assets
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--use-env-proxy", "server.mjs"]
