# Single-container build: the FastAPI backend serves the built React UI from frontend/dist.

FROM node:22-slim AS ui
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
WORKDIR /app
COPY risk_engine/ risk_engine/
COPY backend/pyproject.toml backend/uv.lock backend/.python-version backend/README.md backend/
RUN uv --directory backend sync --frozen --no-dev
COPY backend/ backend/
COPY --from=ui /app/frontend/dist frontend/dist

# Hosts like Render, Fly and Railway inject PORT; main.py reads HOST and PORT.
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
WORKDIR /app/backend
CMD [".venv/bin/python", "main.py"]
