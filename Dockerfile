FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/app/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-dejavu \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY app.py README.md ./

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["python", "app.py"]
