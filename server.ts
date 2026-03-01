import express from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // API route for health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'hypecast-frontend' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
