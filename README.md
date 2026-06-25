# TrimRide Backend

This repository contains the backend API for the TrimRide barber booking platform.

## What it provides
- Authentication and authorization
- Barber and customer booking flows
- Real-time booking updates via Socket.IO
- Payment and notification support
- PostgreSQL-backed data access

## Tech stack
- Node.js
- Express
- PostgreSQL
- Socket.IO
- Firebase Admin SDK
- Jest + Supertest

## Getting started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and update values:
   ```bash
   cp .env.example .env
   ```
3. Start the server:
   ```bash
   npm run dev
   ```

## Tests
```bash
npm test
```

## Notes
- Keep secrets such as Firebase service account files and environment variables out of version control.
- The repository is intended for ongoing development and backup of the current project state.
