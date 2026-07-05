FROM node:20-alpine

WORKDIR /app

# Install prod deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY server ./server
COPY public ./public
COPY config ./config

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
