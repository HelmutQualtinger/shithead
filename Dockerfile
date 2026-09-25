# ---- builder: compile/collect Python deps with build tools available ----
FROM python:3.12-alpine AS builder

RUN apk add --no-cache gcc musl-dev python3-dev libffi-dev

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements.txt

# ---- final: slim runtime image, no compilers ----
FROM python:3.12-alpine

RUN adduser -D -H appuser
COPY --from=builder /install /usr/local

WORKDIR /app
COPY backend/ backend/
COPY frontend/ frontend/

WORKDIR /app/backend
USER appuser

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
