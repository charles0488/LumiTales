FROM python:3.10-slim-bookworm

ENV NODE_ENV=production \
    PORT=3000 \
    TTS_PROVIDER=coqui_xtts_v2 \
    TTS_COMMAND=tts \
    TTS_SPEAKER_MP3=/app/voices/satisfaction.mp3 \
    TTS_LANGUAGE=en \
    TTS_MODEL=tts_models/multilingual/multi-dataset/xtts_v2 \
    TTS_HOME=/models/tts \
    XDG_CACHE_HOME=/models/cache

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      espeak-ng \
      ffmpeg \
      git \
      libsndfile1 \
      nodejs \
      unzip \
    && python -m pip install --no-cache-dir --upgrade pip "setuptools<81" wheel \
    && python -m pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch==2.1.2" \
      "torchaudio==2.1.2" \
    && python -m pip install --no-cache-dir "TTS==0.22.0" \
    && apt-get purge -y --auto-remove build-essential git \
    && rm -rf /var/lib/apt/lists/*

RUN tts --model_info_by_name "$TTS_MODEL"

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY voices ./voices

RUN test -f /app/voices/satisfaction.mp3
RUN mkdir -p /app/books

VOLUME ["/app/books"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/books >/dev/null || exit 1

CMD ["node", "server.js"]
