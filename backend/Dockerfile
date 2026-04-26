FROM node:22
WORKDIR /app

# Install dependencies first (separate layer for better cache reuse)
COPY package*.json ./
RUN npm install

# Copy source and build TypeScript
COPY . .
RUN npm run build

# Run the compiled output
CMD ["node", "dist/main.js"]