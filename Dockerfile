# Usa una imagen de Node.js
FROM node:18-alpine

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./
COPY tsconfig.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código (incluyendo la carpeta src)
COPY . .

# Compilar TypeScript a JavaScript
RUN npm run build

# Exponer el puerto
EXPOSE 8080

# Comando para arrancar
CMD ["node", "dist/server.js"]