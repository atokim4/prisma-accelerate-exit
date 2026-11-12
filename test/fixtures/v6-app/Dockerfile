FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci && npx prisma generate --no-engine && npm run build
CMD ["node", "dist/index.js"]
