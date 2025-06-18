#!/bin/sh

# Custom build script for Azure App Service
# © Microsoft Corporation. Licensed under the MIT License.

set -e

cd api || exit 1

echo "📦 Installing dependencies..."
npm install --production

echo "🧹 Cleaning previous build (if applicable)..."
[ -f package.json ] && npm run clean || echo "No clean step defined."

echo "🔧 Building project (if applicable)..."
[ -f package.json ] && npm run build || echo "No build step defined."

echo "🗑️ Removing old deployment content..."
rm -rf /home/site/wwwroot/*

echo "📁 Copying app files to wwwroot..."
cp -r . /home/site/wwwroot/

echo "✅ Done. App is ready for launch."
