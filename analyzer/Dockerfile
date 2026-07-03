FROM --platform=linux/amd64 python:3.10-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# `python -m flowstate_analyzer` adds the cwd to sys.path, but other
# entrypoints (e.g. pytest for the in-container integration test) do not.
ENV PYTHONPATH=/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt essentia-tensorflow

COPY scripts/download_models.sh scripts/
RUN ./scripts/download_models.sh /models

COPY . .

ENTRYPOINT ["python", "-m", "flowstate_analyzer"]
CMD ["run", "--auth", "/data/browser.json", "--db", "/data/vibes.db", "--models", "/models"]
