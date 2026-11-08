// Sobe o servidor HTTP. Em produção, coloque-o atrás de um proxy com HTTPS (o app exige HTTPS
// fora do emulador, de localhost e da rede local).
import { createApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';

const config = loadConfig();
const db = openDatabase(config.dbFile);
const app = createApp(config, db);

if (!process.env.JWT_SECRET) {
  console.warn('[aviso] JWT_SECRET não definido: usando um segredo temporário (as sessões caem a cada reinício).');
}

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Custódia Sync na porta ${config.port} (health: http://localhost:${config.port}/api/health)`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
