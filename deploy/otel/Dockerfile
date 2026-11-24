# Layer A: upstream OmniRoute image + OTel preload.
# Build: docker build -t omniroute-otel:local deploy/otel
FROM cheaperinference/omniroute:latest
USER root
WORKDIR /otel
COPY package.json preload.cjs ./
RUN npm install --omit=dev --no-audit --no-fund && chown -R node:node /otel
USER node
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=1024 --require=/otel/preload.cjs"
