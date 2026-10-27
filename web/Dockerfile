# Node 22 Alpine bāzēts konteiners React + Vite izstrādei un HMR
FROM node:22-alpine

WORKDIR /app

# Nokopē atkarību failu un uzinstalē bibliotēkas konteinera iekšienē
COPY package.json ./

RUN npm install

# Nokopē pārējos koda failus
COPY . .

EXPOSE 5173

# Palaiž Vite ar host 0.0.0.0, lai tas būtu pieejams ārpus konteinera
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
