FROM node:22 AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=builder /app/dist /srv
CMD ["caddy", "file-server", "--root", "/srv", "--listen", ":4000"]