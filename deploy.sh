#!/bin/bash
# Server-side deploy script
# Run this ONCE on the server after cloning the repo

set -e

echo "=== PT Merge Mining Industri — Procurement App Deploy ==="

# 1. Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  echo ""
  echo "!!! IMPORTANT: Edit .env and set SESSION_SECRET before continuing !!!"
  echo "Run: nano .env"
  exit 1
fi

# 2. Create required directories
mkdir -p data exports

# 3. Check database exists
if [ ! -f data/procurement.db ]; then
  echo ""
  echo "!!! data/procurement.db not found !!!"
  echo "Copy your database file to the server first:"
  echo "  scp ./data/procurement.db user@YOUR_SERVER_IP:/path/to/app/data/"
  exit 1
fi

# 4. Build and start containers
echo "Building and starting containers..."
docker compose up -d --build

echo ""
echo "=== Deploy complete ==="
echo "App running at http://localhost:3000"
echo "Check logs with: docker compose logs -f"
