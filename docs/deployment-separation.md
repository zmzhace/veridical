# Research / production deployment separation

The server has two explicit modes. They must run as separate processes and use separate data roots.

## Research

```bash
VERIDICAL_MODE=development \
VERIDICAL_TRACES_DIR=/var/lib/veridical/research/traces \
VERIDICAL_SPECS_DIR=/var/lib/veridical/research/specs \
pnpm -F @veridical/server start:research
```

This process exposes the experimental `/api` routes and must never receive production credentials or data.

## Production

```bash
VERIDICAL_MODE=production \
VERIDICAL_CONFIG=/etc/veridical/production.json \
VERIDICAL_HOST=0.0.0.0 \
VERIDICAL_PORT=8787 \
pnpm -F @veridical/server start:production
```

Production exposes only `/v1` plus `/health/live` and `/health/ready`. Use a separate OS user, database, secrets, logs, and network policy. Do not mount the research `.traces` or `.specs` directories into the production process.

## CI gate

Run `pnpm test:regression` and `pnpm build` before publishing the production image. The production process should be promoted only from an immutable build artifact; research remains a separate deployment.
