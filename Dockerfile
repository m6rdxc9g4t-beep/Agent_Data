# syntax=docker/dockerfile:1
# DataMind — image autonome.
#   docker build -t datamind .
#   docker run -p 8501:8501 -e OLLAMA_HOST=http://host.docker.internal:11434 datamind
# Le code écrit par l'IA s'exécute dans ce conteneur, sous un utilisateur sans privilèges.

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    MPLCONFIGDIR=/tmp/matplotlib \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_SERVER_PORT=8501
RUN apt-get update && apt-get install -y --no-install-recommends tzdata fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY . ./
RUN rm -f .env && useradd --create-home --uid 1000 datamind
USER datamind
EXPOSE 8501
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"STREAMLIT_SERVER_PORT\"]}/_stcore/health',timeout=3)"
CMD ["streamlit", "run", "app.py"]
