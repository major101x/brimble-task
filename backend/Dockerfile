FROM node:22-alpine
WORKDIR /app
COPY . .
RUN echo '{"name":"backend","version":"1.0.0"}' > package.json
CMD ["node", "src/index.js"]