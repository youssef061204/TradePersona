FROM node:20-bookworm-slim

ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json /app/backend/
RUN npm --prefix /app/backend ci

COPY requirements.txt /app/backend/requirements.txt
RUN pip3 install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app/backend

ENV NODE_ENV=production
ENV PYTHON_PATH=/usr/bin/python3

EXPOSE 10000

CMD ["node", "backend/index.js"]
