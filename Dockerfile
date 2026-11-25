FROM node:20-slim AS frontend
WORKDIR /app
COPY package.json vite.config.js index.html ./
COPY src ./src
RUN npm install && npm run build

FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./
COPY --from=frontend /app/dist ./dist
EXPOSE 7860
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-7860}"]
