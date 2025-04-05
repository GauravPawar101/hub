# Use Bun official image
FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy everything into the container
COPY . .

# Install dependencies
RUN bun install

# Expose the port (make sure your app reads from PORT env var)
EXPOSE 3000

# Start the app
CMD ["bun", "index.ts"]
