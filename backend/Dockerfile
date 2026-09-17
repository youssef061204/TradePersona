FROM node:22-bookworm-slim

ENV PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY package*.json /app/backend/
RUN npm --prefix /app/backend ci --omit=dev

COPY requirements.txt /app/backend/requirements.txt
RUN /opt/venv/bin/pip install --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app/backend

# Fail the build clearly if inference artifacts have not been generated.
RUN test -f /app/backend/ml/artifacts/v1/model.joblib \
  && test -f /app/backend/ml/artifacts/v1/evaluation.json

ENV NODE_ENV=production
ENV PYTHON_PATH=/opt/venv/bin/python
ENV PYTHONDONTWRITEBYTECODE=1

USER node

EXPOSE 10000

CMD ["node", "backend/index.js"]
