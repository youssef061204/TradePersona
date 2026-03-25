# Deploying The Backend To Render

This repo is set up to deploy the backend as a Docker-based Render web service.

## What Render will deploy

- Service: `tradepersona-backend`
- Config file: [render.yaml](./render.yaml)
- Docker image: [backend/Dockerfile](./backend/Dockerfile)
- Health check: `/healthz`

## Before you deploy

1. Push this repo to GitHub.
2. Make sure the backend secrets are ready. You will need some or all of:
   - `GEMINI_API_KEY`
   - `OPENROUTER_API_KEY` or `OPEN_ROUTER_KEY`
   - `SNOWFLAKE_ACCOUNT`
   - `SNOWFLAKE_USERNAME`
   - `SNOWFLAKE_PASSWORD`
   - `SNOWFLAKE_DATABASE`
   - `SNOWFLAKE_SCHEMA`
   - `SNOWFLAKE_WAREHOUSE`

You can copy the variable names from [backend/.env.example](./backend/.env.example).

## Deploy with Render Blueprint

1. In Render, open `New > Blueprint`.
2. Connect your GitHub repo.
3. Render should detect [render.yaml](./render.yaml).
4. Confirm the new service and create the Blueprint instance.
5. When Render prompts for secret values, fill them in.
6. Wait for the deploy to finish, then open the generated `onrender.com` URL.

## Connect Vercel frontend to Render backend

In your Vercel frontend project, set:

```env
NEXT_PUBLIC_API_BASE_URL=https://your-render-service.onrender.com
```

Then redeploy the frontend.

## Important note about uploads on free Render

Free Render web services use an ephemeral filesystem. That means uploaded CSV files and any in-memory session data can disappear after a restart or redeploy.

This app will still run on the free tier, but uploads are best treated as temporary demo data.

## If you want uploads to persist

Render only supports persistent disks on paid web services.

If you upgrade to a paid instance:

1. Add a disk in the Render dashboard.
2. Mount it at `/app/data`.
3. Set this environment variable on the backend service:

```env
UPLOADS_DIR=/app/data/uploads
```

4. Redeploy the service.

## Notes

- The backend Docker image installs both Node.js dependencies and Python packages from [backend/requirements.txt](./backend/requirements.txt).
- Python packages are installed into a container-local virtualenv so Render's Debian base image does not block `pip` with PEP 668.
- The app listens on `PORT`, which Render sets to `10000` in [render.yaml](./render.yaml).
