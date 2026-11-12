FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py index.html styles.css script.js ./
COPY assets ./assets
COPY moments_web ./moments_web
ENV HOPESCOPE_DATA=/var/lib/hopescope HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
