# Automata backend. Build from the repo root:
#   docker build -f backend/Dockerfile -t automata-api ./backend
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data \
    PORT=8001

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

# Non-root, and the only writable place is the data volume.
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /data \
 && chown -R app:app /data /app
USER app

VOLUME ["/data"]
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8001')+'/api/').read()" || exit 1

CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --proxy-headers --forwarded-allow-ips '*'"]
