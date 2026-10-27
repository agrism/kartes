FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Izveido mapi lejupielādēto datu kešam
RUN mkdir -p /app/cache

ENTRYPOINT ["python", "importer.py"]
CMD ["--help"]
