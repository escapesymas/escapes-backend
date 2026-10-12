# Procesador de imágenes aislado: solo node, sharp y estos dos ficheros.
# Nada del backend (código, catálogo de Bihr, plantillas) entra en la imagen.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs worker.mjs ./

RUN addgroup -S -g 61010 imagenes && adduser -S -u 61010 -G imagenes imagenes
USER imagenes

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({socketPath:'/run/imgsock/imagenes.sock',path:'/salud'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.mjs"]
