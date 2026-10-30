# Hafeez Helfer: static PWA served by nginx.
# Build:  docker build -t hafeez-helfer .
# Run:    docker run --rm -p 8080:80 hafeez-helfer   →  http://localhost:8080
# Optional: bundle the verified juz/hizb/quarter/page metadata with --build-arg FETCH_QURAN_DATA=1
#           (needs internet during the build; Tanzil metadata is CC BY 3.0, keep attribution).
#           The KFGQPC Quran text is always imported from public/KFGQPC-Hafs-V30/ (offline).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
ARG FETCH_QURAN_DATA=0
# Optional cloud accounts (public values, see docs/DEPLOY.md); empty = local-only mode.
ARG HAFEEZ_SUPABASE_URL=
ARG HAFEEZ_SUPABASE_ANON_KEY=
ENV HAFEEZ_SUPABASE_URL=$HAFEEZ_SUPABASE_URL HAFEEZ_SUPABASE_ANON_KEY=$HAFEEZ_SUPABASE_ANON_KEY
RUN npm run data:import && { if [ "$FETCH_QURAN_DATA" = "1" ]; then npm run data:fetch; fi; }
RUN npm run lint && npm run typecheck && npm test && npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
