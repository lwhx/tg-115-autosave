FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=8715
EXPOSE 8715

CMD ["node", "src/server.js"]
