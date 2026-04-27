FROM node:22
WORKDIR /app

RUN apt-get update \
    && apt-get install -y git curl gnupg --no-install-recommends \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (separate layer for better cache reuse)
COPY package*.json ./
RUN npm install

# Copy source and build TypeScript
COPY . .
RUN npm run build

COPY railpack /usr/local/bin/railpack
RUN chmod +x /usr/local/bin/railpack

# Run the compiled output
CMD ["node", "dist/main.js"]