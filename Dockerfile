FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY . .

ENV PORT=8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "server.js"]
