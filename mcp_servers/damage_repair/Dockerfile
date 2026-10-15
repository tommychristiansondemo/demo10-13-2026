# AgentCore Runtime requires linux/arm64 images (platform is set by the CDK asset).
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OTEL_PYTHON_DISTRO=aws_distro \
    OTEL_PYTHON_CONFIGURATOR=aws_configurator \
    AGENT_OBSERVABILITY_ENABLED=true

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY tools.py server.py ./
COPY data ./data

RUN useradd --uid 1000 --create-home mcp
USER mcp

EXPOSE 8000
# opentelemetry-instrument sends traces/spans to AgentCore Observability (CloudWatch / X-Ray).
CMD ["opentelemetry-instrument", "python", "server.py"]
