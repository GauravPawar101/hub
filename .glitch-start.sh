#!/bin/bash
curl -fsSL https://bun.sh/install | bash
export PATH="/home/glitch/.bun/bin:$PATH"
bun install
bun index.ts
