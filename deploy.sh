#!/bin/sh

# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

cd api || exit 1

echo "📦 Installing dependencies..."
npm install

echo "🧹 Cleaning build..."
npm run clean

echo "🔧 Building project..."
npm run build

echo "🗑️ Removing old content..."
rm -rf /home/site/wwwroot/*

echo "📁 Copying necessary files..."
cp -r dist/* /home/site/wwwroot/
cp package.json /home/site/wwwroot/
cp -r node_modules /home/site/wwwroot/
